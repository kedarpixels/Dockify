import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { ensureDashboardApiRule, type CfClient, type CfIngress } from "./cloudflare.ts";
import { checkDns, serverAddresses, type DnsLookup } from "./dns.ts";
import { routableHosts } from "./hosts.ts";
import type { EdgeSettings } from "./ingress.ts";
import { checkDomain, dnsRecheckDelayMs, dnsRecheckDue, queueWaitingDnsChecks, edgeServerHandlers, resyncRoutes, syncAppRoute, type EdgeDeps } from "./jobs.ts";
import { DockerError, fileRouteStore } from "@dockify/engine";
import { LABEL } from "../deploy/containers.ts";
import { imagePortFor } from "../wiring.ts";
import { readRoute, routeFileName, writeAsleepRoute, writeRoute } from "./routes.ts";
import { appStarted, START_EVENTS_FILTER } from "./starts.ts";

const APP = "11111111-1111-4111-8111-111111111111";
const PV = "22222222-2222-4222-8222-222222222222";
const NET = "dockify-env-33333333-3333-4333-8333-333333333333";
const OLD = "dk-route-44444444-4444-4444-8444-444444444444";
const NEW = "dk-route-55555555-5555-4555-8555-555555555555";

let dir: string;
const routeConfPath = (root: string, appId: string) => join(root, "conf", routeFileName(appId));
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "edge-sync-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Domain { id?: string; hostname: string; dnsStatus: string; appId?: string; createdAt?: Date; dnsCheckedAt?: Date | null }
interface World {
  app: { id: string; name?: string; serverId: string; port: number | null; kind: string; desiredState: string; primaryDomain: { hostname: string } | null; domains: Domain[] } | null;
  deploying: boolean;
  jobs: Array<{ kind: string; payload: unknown; dedupeKey: string | null; lockedBy: string | null; completedAt: Date | null; failedAt: Date | null }>;
  domainRows: Domain[];
  updates: Array<Record<string, unknown>>;
  activity?: Array<Record<string, unknown>>;
}

function fakeDb(w: World): Db {
  const tx = {
    $executeRaw: async () => 0,
    app: { findUnique: async () => ({ serverId: "s1" }) },
    job: {
      findFirst: async ({ where }: { where: { dedupeKey: string; lockedBy?: null } }) =>
        w.jobs.find((j) => j.dedupeKey === where.dedupeKey && !j.completedAt && !j.failedAt && (where.lockedBy === undefined || j.lockedBy === null)) ?? null,
      create: async ({ data }: { data: { kind: string; payload: unknown; dedupeKey: string } }) => {
        w.jobs.push({ ...data, lockedBy: null, completedAt: null, failedAt: null });
        return { id: `j${w.jobs.length}` };
      },
    },
  };
  return {
    ...tx,
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    app: {
      findUnique: async () => w.app,
      findMany: async () => (w.app ? [{ id: w.app.id, desiredState: w.app.desiredState }] : []),
      updateMany: async ({ where, data }: { where: { port: null }; data: { port: number } }) => {
        if (!w.app || w.app.port !== where.port) return { count: 0 };
        w.app.port = data.port;
        return { count: 1 };
      },
    },
    activityLog: { create: async ({ data }: { data: Record<string, unknown> }) => void (w.activity ??= []).push(data) },
    deployment: { findFirst: async () => (w.deploying ? { id: "dep" } : null) },
    domain: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const r = w.domainRows.find((d) => d.id === where.id);
        return r ? { ...r } : null;
      },
      findMany: async () => w.domainRows,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        w.updates.push({ id: where.id, ...data });
        Object.assign(w.domainRows.find((d) => d.id === where.id)!, data);
      },
    },
  } as unknown as Db;
}

const settings = (mode: "direct_tls" | "cloudflare_tunnel" = "direct_tls", over: Partial<EdgeSettings> = {}): EdgeSettings => ({
  mode: mode === "direct_tls" ? { ingress: mode, certResolver: "le" } : { ingress: mode },
  dashboardHost: "dash.example.com", serverIpv4: "203.0.113.7", serverIpv6: null, acmeEmail: "ops@example.com", acmeCaServer: null,
  ...over,
});

function world(domains: Domain[], o: Partial<World> = {}): World {
  return {
    app: { id: APP, serverId: "s1", port: 3000, kind: "frontend", desiredState: "running", primaryDomain: null, domains },
    deploying: false, jobs: [], domainRows: [], updates: [],
    ...o,
  };
}

function deps(w: World, target: string | null = NEW, over: Partial<EdgeDeps> = {}) {
  const joined: string[] = [];
  const d: EdgeDeps = {
    db: fakeDb(w), vault: {} as never, settings: settings(), serverId: "s1", routes: fileRouteStore(dir), mode: settings().mode,
    routeTarget: async () => (target ? { backend: target, network: NET } : null),
    imagePort: async () => { throw new Error("an app with a port never asks its image"); },
    joinProxy: async (n) => void joined.push(n),
    dns: { resolve4: async () => [], resolveCname: async () => [] },
    tls: async () => { throw new Error("no TLS in this test"); },
    ...over,
  };
  return { d, joined };
}

describe("syncAppRoute", () => {
  it("routes only the domains whose DNS points here, primary first", async () => {
    const w = world([
      { hostname: "late.example.com", dnsStatus: "missing" },
      { hostname: "shop.example.com", dnsStatus: "ok" },
      { hostname: "www.example.com", dnsStatus: "ok" },
      { hostname: "elsewhere.example.com", dnsStatus: "mismatch" },
      { hostname: "new.example.com", dnsStatus: "unchecked" },
    ], {});
    w.app!.primaryDomain = { hostname: "www.example.com" };
    const { d, joined } = deps(w);
    expect(await syncAppRoute(d, APP)).toBe("written");
    expect(await readRoute(fileRouteStore(dir), APP)).toEqual({ hosts: ["www.example.com", "shop.example.com"], backend: NEW });
    expect(joined).toEqual([NET]);
  });

  it("names the container's alias, never an address, so a reboot cannot misroute", async () => {
    const { d } = deps(world([{ hostname: "shop.example.com", dnsStatus: "ok" }]));
    await syncAppRoute(d, APP);
    const text = await readFile(routeConfPath(dir, APP), "utf8");
    expect(text).toContain(`"http://${NEW}.:3000"`);
    expect(text).not.toMatch(/http:\/\/\d+\.\d+\.\d+\.\d+/);
  });

  it("keeps a routed host while its check cannot tell, and never adds an unchecked one", async () => {
    await writeRoute(fileRouteStore(dir), { id: APP, port: 3000, hosts: ["shop.example.com", "live.example.com"] }, OLD, settings().mode, new Set());
    const { d } = deps(world([
      { hostname: "shop.example.com", dnsStatus: "ok" },
      { hostname: "live.example.com", dnsStatus: "unchecked" },
      { hostname: "fresh.example.com", dnsStatus: "unchecked" },
    ]));
    await syncAppRoute(d, APP);
    expect((await readRoute(fileRouteStore(dir), APP))?.hosts).toEqual(["shop.example.com", "live.example.com"]);
  });

  it("leaves the backend to a deploy in flight and only refreshes the hosts", async () => {
    await writeRoute(fileRouteStore(dir), { id: APP, port: 3000, hosts: ["shop.example.com"] }, OLD, settings().mode, new Set());
    const { d } = deps(world([{ hostname: "shop.example.com", dnsStatus: "ok" }, { hostname: "www.example.com", dnsStatus: "ok" }], { deploying: true }), NEW);
    await syncAppRoute(d, APP);
    // The canonical name may hold the deploy's new container before it is ready: never route to it here.
    expect(await readRoute(fileRouteStore(dir), APP)).toEqual({ hosts: ["shop.example.com", "www.example.com"], backend: OLD });
  });

  it("removes the route when the app should not run, is not routable, or has no running container", async () => {
    const domains = [{ hostname: "shop.example.com", dnsStatus: "ok" }];
    for (const [w, target] of [
      [world(domains, {}), null],
      [{ ...world(domains), app: { ...world(domains).app!, desiredState: "stopped" } }, NEW],
      [{ ...world(domains), app: { ...world(domains).app!, kind: "postgres" } }, NEW],
      [{ ...world(domains), app: null }, NEW],
    ] as Array<[World, string | null]>) {
      await writeRoute(fileRouteStore(dir), { id: APP, port: 3000, hosts: ["shop.example.com"] }, OLD, settings().mode, new Set());
      expect(await syncAppRoute(deps(w, target).d, APP)).toBe("removed");
      expect(await readRoute(fileRouteStore(dir), APP)).toBeNull();
    }
  });
});

describe("an app with no port, given a domain after its first deploy", () => {
  const noPort = (domains: Domain[], o: Partial<NonNullable<World["app"]>> = {}): World => {
    const w = world(domains);
    Object.assign(w.app!, { port: null, name: "whoami" }, o);
    return w;
  };
  const SHOP = { hostname: "shop.example.com", dnsStatus: "ok" };

  it("takes the port its running image says, stores it and writes the route, with no redeploy", async () => {
    const w = noPort([SHOP]);
    const { d, joined } = deps(w, NEW, { imagePort: async () => 80 });
    expect(await syncAppRoute(d, APP)).toBe("written");
    expect(w.app!.port).toBe(80);
    expect(await readRoute(fileRouteStore(dir), APP)).toEqual({ hosts: ["shop.example.com"], backend: NEW });
    expect(await readFile(routeConfPath(dir, APP), "utf8")).toContain(`http://${NEW}.:80`);
    expect(joined).toEqual([NET]);
    expect(w.activity).toEqual([expect.objectContaining({ action: "app.port.detected", targetLabel: "whoami", failed: false, suffix: expect.stringContaining("to 80") })]);
  });

  it("settles the port once the domain exists, and routes it when its DNS check passes", async () => {
    const w = noPort([{ hostname: "shop.example.com", dnsStatus: "unchecked" }]);
    const { d, joined } = deps(w, NEW, { imagePort: async () => 8080 });
    await syncAppRoute(d, APP);
    expect(w.app!.port).toBe(8080);
    expect(await readRoute(fileRouteStore(dir), APP)).toBeNull();
    expect(joined).toEqual([]);
    w.app!.domains[0]!.dnsStatus = "ok";
    await syncAppRoute({ ...d, imagePort: async () => { throw new Error("settled: not asked again"); } }, APP);
    expect(await readRoute(fileRouteStore(dir), APP)).toEqual({ hosts: ["shop.example.com"], backend: NEW });
    expect(w.activity).toHaveLength(1);
  });

  it("leaves an app with no domain alone: it may not listen at all", async () => {
    const w = noPort([]);
    const { d } = deps(w, NEW, { imagePort: async () => { throw new Error("no domain: not asked"); } });
    await syncAppRoute(d, APP);
    expect(w.app!.port).toBeNull();
    expect(await readRoute(fileRouteStore(dir), APP)).toBeNull();
  });

  it("writes no route and stores nothing when the image says no port", async () => {
    const w = noPort([SHOP]);
    const { d, joined } = deps(w, NEW, { imagePort: async () => null });
    await syncAppRoute(d, APP);
    expect(w.app!.port).toBeNull();
    expect(await readRoute(fileRouteStore(dir), APP)).toBeNull();
    expect(joined).toEqual([]);
    expect(w.activity).toBeUndefined();
  });

  it("does not ask while a deploy is under way or when there is no container", async () => {
    const never = async () => { throw new Error("not asked"); };
    const busy = noPort([SHOP]);
    busy.deploying = true;
    expect(await syncAppRoute(deps(busy, NEW, { imagePort: never }).d, APP)).toBe("kept");
    expect(busy.app!.port).toBeNull();
    const none = noPort([SHOP]);
    expect(await syncAppRoute(deps(none, null, { imagePort: never }).d, APP)).toBe("removed");
    expect(none.app!.port).toBeNull();
  });

  it("uses a port a person saved in the meantime, and credits nothing to the image", async () => {
    const w = noPort([SHOP]);
    const { d } = deps(w, NEW, { imagePort: async () => { w.app!.port = 9000; return 80; } });
    await syncAppRoute(d, APP);
    expect(w.app!.port).toBe(9000);
    expect(await readFile(routeConfPath(dir, APP), "utf8")).toContain(`http://${NEW}.:9000`);
    expect(w.activity).toBeUndefined();
  });

  it("lets a failing inspect fail the sync, so the job's retry asks again", async () => {
    const w = noPort([SHOP]);
    await expect(syncAppRoute(deps(w, NEW, { imagePort: async () => { throw new Error("daemon busy"); } }).d, APP)).rejects.toThrow("daemon busy");
    expect(w.app!.port).toBeNull();
  });
});

describe("imagePortFor", () => {
  const info = (labels: Record<string, string>) => ({ Image: "sha256:abc", Config: { Labels: labels } });
  const notFound = () => new DockerError(404, "no such container");

  it("reads the image of the app's own container, as the deploy does", async () => {
    const asked: string[] = [];
    const docker = { inspectContainer: async () => info({ [LABEL.app]: APP }), inspectImage: async (id: string) => { asked.push(id); return { Config: { ExposedPorts: { "8080/tcp": {}, "9000/tcp": {} } } }; } };
    expect(await imagePortFor(docker as never)(APP)).toBe(8080);
    expect(asked).toEqual(["sha256:abc"]);
  });

  it("says nothing for a container of another app, no container, an image gone, or an image with no port", async () => {
    const never = async () => { throw new Error("not asked"); };
    expect(await imagePortFor({ inspectContainer: async () => info({ [LABEL.app]: "other" }), inspectImage: never } as never)(APP)).toBeNull();
    expect(await imagePortFor({ inspectContainer: async () => { throw notFound(); }, inspectImage: never } as never)(APP)).toBeNull();
    expect(await imagePortFor({ inspectContainer: async () => info({ [LABEL.app]: APP }), inspectImage: async () => { throw notFound(); } } as never)(APP)).toBeNull();
    expect(await imagePortFor({ inspectContainer: async () => info({ [LABEL.app]: APP }), inspectImage: async () => ({ Config: {} }) } as never)(APP)).toBeNull();
  });

  it("does not swallow a daemon that cannot answer", async () => {
    await expect(imagePortFor({ inspectContainer: async () => { throw new Error("socket hang up"); } } as never)(APP)).rejects.toThrow("socket hang up");
  });
});

describe("the boot resync", () => {
  it("re-points every app route and moves an old preview route off its address", async () => {
    await writeRoute(fileRouteStore(dir), { id: APP, port: 3000, hosts: ["shop.example.com"] }, "10.0.0.9", settings().mode, new Set());
    await writeRoute(fileRouteStore(dir), { id: `pv-${PV}`, port: 3000, hosts: ["pr-1.preview.example.com"] }, "10.0.0.12", settings().mode, new Set());
    const { d, joined } = deps(world([{ hostname: "shop.example.com", dnsStatus: "ok" }]), NEW, {
      previewTarget: async (id) => (id === PV ? { backend: `dk-pv-${PV}-abcd1234`, network: "dockify-pv-forks" } : null),
    });
    expect(await resyncRoutes(d)).toEqual({ apps: 1, previews: 1 });
    expect((await readRoute(fileRouteStore(dir), APP))?.backend).toBe(NEW);
    expect((await readRoute(fileRouteStore(dir), `pv-${PV}`))?.backend).toBe(`dk-pv-${PV}-abcd1234`);
    expect(joined).toContain("dockify-pv-forks");
  });

  it("drops an old preview route whose container is gone: its address may belong to anyone now", async () => {
    await writeRoute(fileRouteStore(dir), { id: `pv-${PV}`, port: 3000, hosts: ["pr-1.preview.example.com"] }, "10.0.0.12", settings().mode, new Set());
    const { d } = deps({ ...world([]), app: null }, null, { previewTarget: async () => null });
    expect(await resyncRoutes(d)).toEqual({ apps: 0, previews: 1 });
    expect(await readRoute(fileRouteStore(dir), `pv-${PV}`)).toBeNull();
  });
});

describe("the periodic sweep of route files", () => {
  it("keeps a sleeping preview's page, and drops the route of a closed one", async () => {
    const CLOSED = "66666666-6666-4666-8666-666666666666";
    await writeAsleepRoute(fileRouteStore(dir), { id: `pv-${PV}`, port: 3000, hosts: ["pr-1.preview.example.com"] }, settings().mode, new Set());
    await writeAsleepRoute(fileRouteStore(dir), { id: `pv-${CLOSED}`, port: 3000, hosts: ["pr-2.preview.example.com"] }, settings().mode, new Set());
    const rows = [{ id: PV, status: "asleep" }, { id: CLOSED, status: "closed" }];
    const previewDeployment = { findMany: async ({ where }: { where: { env: { status: { in: string[] } } } }) => rows.filter((r) => where.env.status.in.includes(r.status)) };
    const { d } = deps({ ...world([]), app: null }, null);
    d.db = { ...d.db, previewDeployment } as unknown as Db;
    await edgeServerHandlers(d).reconcile!({} as never, new AbortController().signal);
    const names = Object.keys(await fileRouteStore(dir).snapshot());
    expect(names).toContain(routeFileName(`pv-${PV}`));
    expect(names).not.toContain(routeFileName(`pv-${CLOSED}`));
  });
});

describe("checkDomain", () => {
  const lookup = (a: string[] | Error, aaaa: string[] = []): DnsLookup => ({
    resolve4: async (h) => {
      if (h === "dash.example.com") return ["198.51.100.20"];
      if (a instanceof Error) throw a;
      return a;
    },
    resolve6: async () => aaaa,
    resolveCname: async () => [],
  });
  const row = (dnsStatus: string): Domain => ({ id: "d1", hostname: "shop.example.com", appId: APP, dnsStatus });
  const run = async (w: World, dns: DnsLookup, s = settings()) => {
    await checkDomain({ db: fakeDb(w), settings: s, dns, tls: async () => ({ cert: null, authorized: false, authorizationError: null }) }, "d1");
  };

  it("routes a domain once its DNS starts pointing here, and unroutes it when it stops", async () => {
    const w = { ...world([]), domainRows: [row("missing")] };
    await run(w, lookup(["203.0.113.7"]));
    expect(w.updates.at(-1)).toMatchObject({ dnsStatus: "ok" });
    expect(w.jobs.map((j) => j.dedupeKey)).toEqual([`edge.route:${APP}`]);
    w.jobs[0]!.completedAt = new Date();
    await run(w, lookup(["192.0.2.50"]));
    expect(w.updates.at(-1)).toMatchObject({ dnsStatus: "mismatch" });
    expect(w.jobs.filter((j) => !j.completedAt)).toHaveLength(1);
  });

  it("keeps the last verdict when the lookup itself fails, so a resolver hiccup never takes a site down", async () => {
    const w = { ...world([]), domainRows: [row("ok")] };
    await run(w, lookup(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })));
    expect(w.domainRows[0]!.dnsStatus).toBe("ok");
    expect(w.updates.at(-1)).not.toHaveProperty("dnsStatus");
    expect(w.jobs).toEqual([]);
  });

  it("counts the dashboard host's address as this server's, which covers a server behind NAT", async () => {
    const w = { ...world([]), domainRows: [row("unchecked")] };
    await run(w, lookup(["198.51.100.20"]), settings("direct_tls", { serverIpv4: "10.0.0.4" }));
    expect(w.domainRows[0]!.dnsStatus).toBe("ok");
  });
});

describe("checkDomain with the ownership probe", () => {
  /** Cloudflare's edge, as a proxied record resolves. */
  const proxied: DnsLookup = { resolve4: async (h) => (h === "dash.example.com" ? ["203.0.113.7"] : ["104.16.1.1", "104.16.2.2"]), resolve6: async () => [], resolveCname: async () => [] };
  const direct: DnsLookup = { resolve4: async () => ["203.0.113.7"], resolve6: async () => [], resolveCname: async () => [] };
  const row = (dnsStatus: string): Domain => ({ id: "d1", hostname: "shop.example.com", appId: APP, dnsStatus });
  const tlsAsked: string[] = [];
  const tls = async (ip: string) => {
    tlsAsked.push(ip);
    return { cert: null, authorized: false, authorizationError: null };
  };
  const run = async (w: World, dns: DnsLookup, probe: EdgeDeps["probe"], s = settings()) => {
    tlsAsked.length = 0;
    const asked: string[] = [];
    const p = probe ? (async (host: string, id: string) => (asked.push(`${host} ${id}`), probe(host, id))) : undefined;
    await checkDomain({ db: fakeDb(w), settings: s, dns, tls, ...(p ? { probe: p } : {}) }, "d1");
    return asked;
  };
  const passed = async () => ({ status: "passed" as const, detail: "Asking shop.example.com reached this server over https." });
  const failed = async () => ({ status: "failed" as const, detail: "Asking shop.example.com did not reach this server: it answered 404." });

  it("routes a proxied domain that answers with this server's value, and reads its certificate from this server", async () => {
    const w = { ...world([]), domainRows: [row("missing")] };
    expect(await run(w, proxied, passed)).toEqual(["shop.example.com d1"]);
    expect(w.updates.at(-1)).toMatchObject({ dnsStatus: "ok", dnsDetail: null, probeStatus: "passed", probeDetail: "Asking shop.example.com reached this server over https.", dnsResolved: ["104.16.1.1", "104.16.2.2"] });
    expect(w.updates.at(-1)!.probeCheckedAt).toBeInstanceOf(Date);
    expect(w.jobs.map((j) => j.dedupeKey)).toEqual([`edge.route:${APP}`]);
    // The origin's certificate, not Cloudflare's.
    expect(tlsAsked).toEqual(["203.0.113.7"]);
  });

  it("keeps a proxied domain that does not answer waiting, with both reasons for the page", async () => {
    const w = { ...world([]), domainRows: [row("missing")] };
    await run(w, proxied, failed);
    expect(w.updates.at(-1)).toMatchObject({
      dnsStatus: "mismatch",
      dnsDetail: "shop.example.com is proxied by Cloudflare, so its records name Cloudflare, not 203.0.113.7.",
      probeStatus: "failed",
      probeDetail: "Asking shop.example.com did not reach this server: it answered 404.",
      tlsStatus: "pending",
    });
    expect(w.jobs).toEqual([]);
    expect(tlsAsked).toEqual([]);
  });

  it("unroutes a proxied domain that stops answering", async () => {
    const w = { ...world([]), domainRows: [row("ok")] };
    await run(w, proxied, failed);
    expect(w.domainRows[0]!.dnsStatus).toBe("mismatch");
    expect(w.jobs.map((j) => j.dedupeKey)).toEqual([`edge.route:${APP}`]);
  });

  it("never asks a domain whose DNS already points here, or that has no records, or a tunnel-mode one", async () => {
    const here = { ...world([]), domainRows: [row("missing")] };
    expect(await run(here, direct, passed)).toEqual([]);
    expect(here.updates.at(-1)).toMatchObject({ dnsStatus: "ok", probeStatus: "untried", probeDetail: null, probeCheckedAt: null });
    const none = { ...world([]), domainRows: [row("missing")] };
    expect(await run(none, { resolve4: async (h) => (h === "dash.example.com" ? ["203.0.113.7"] : []), resolve6: async () => [], resolveCname: async () => [] }, passed)).toEqual([]);
    expect(none.updates.at(-1)).toMatchObject({ dnsStatus: "missing", probeStatus: "untried" });
    const tunnel = { ...world([]), domainRows: [row("missing")] };
    expect(await run(tunnel, direct, passed, settings("cloudflare_tunnel"))).toEqual([]);
  });

  it("asks a domain whose records cannot be compared, when this server's address is unknown", async () => {
    const w = { ...world([]), domainRows: [row("missing")] };
    const unknown = settings("direct_tls", { serverIpv4: null, dashboardHost: "dash.example.com" });
    const noDash: DnsLookup = { resolve4: async (h) => (h === "dash.example.com" ? [] : ["198.51.100.9"]), resolve6: async () => [], resolveCname: async () => [] };
    expect(await run(w, noDash, passed, unknown)).toEqual(["shop.example.com d1"]);
    expect(w.updates.at(-1)).toMatchObject({ dnsStatus: "ok", probeStatus: "passed" });
  });

  it("gives a live domain one more check when the probe got no answer at all, then drops it", async () => {
    const w = { ...world([]), domainRows: [row("ok")] };
    const timeout = async () => ({ status: "failed" as const, detail: "Asking shop.example.com did not reach this server: no answer within 8 s.", transient: true });
    await run(w, proxied, timeout);
    expect(w.domainRows[0]!.dnsStatus).toBe("ok");
    expect(w.updates.at(-1)).toMatchObject({ probeStatus: "failed", probeDetail: "Asking shop.example.com did not reach this server: no answer within 8 s. The domain stays live until the next check." });
    expect(w.updates.at(-1)).not.toHaveProperty("dnsStatus");
    expect(w.jobs).toEqual([]);
    await run(w, proxied, timeout);
    expect(w.domainRows[0]!.dnsStatus).toBe("mismatch");
    expect(w.jobs.map((j) => j.dedupeKey)).toEqual([`edge.route:${APP}`]);
  });

  it("records a probe that throws as a failed check, never as a pass", async () => {
    const w = { ...world([]), domainRows: [row("missing")] };
    await run(w, proxied, async () => {
      throw new Error("boom");
    });
    expect(w.updates.at(-1)).toMatchObject({ dnsStatus: "mismatch", probeStatus: "failed", probeDetail: "The check could not run: boom" });
  });
});

describe("dns checks for domains still waiting", () => {
  it("backs off from 30 seconds to 15 minutes as a domain ages", () => {
    expect(dnsRecheckDelayMs(0)).toBe(30_000);
    expect(dnsRecheckDelayMs(10 * 60_000)).toBe(60_000);
    expect(dnsRecheckDelayMs(5 * 3_600_000)).toBe(15 * 60_000);
    const created = new Date(0);
    expect(dnsRecheckDue(created, null, 1_000)).toBe(true);
    expect(dnsRecheckDue(created, new Date(10_000), 30_000)).toBe(false);
    expect(dnsRecheckDue(created, new Date(10_000), 40_000)).toBe(true);
  });

  it("queues one check per due domain, up to the limit, and never two for one domain", async () => {
    const now = 3_600_000;
    const rows: Domain[] = [
      { id: "a", hostname: "a.example.com", dnsStatus: "missing", createdAt: new Date(now - 120_000), dnsCheckedAt: null },
      { id: "b", hostname: "b.example.com", dnsStatus: "mismatch", createdAt: new Date(now - 120_000), dnsCheckedAt: new Date(now - 5_000) },
      { id: "c", hostname: "c.example.com", dnsStatus: "unchecked", createdAt: new Date(now - 600_000), dnsCheckedAt: new Date(now - 120_000) },
    ];
    const w = { ...world([]), domainRows: rows };
    expect(await queueWaitingDnsChecks(fakeDb(w), now)).toBe(2);
    expect(w.jobs.map((j) => [j.kind, j.dedupeKey])).toEqual([["dns_check", "edge.dns.wait:a"], ["dns_check", "edge.dns.wait:c"]]);
    await queueWaitingDnsChecks(fakeDb(w), now);
    expect(w.jobs).toHaveLength(2);
    expect(await queueWaitingDnsChecks(fakeDb({ ...world([]), domainRows: rows }), now, 1)).toBe(1);
  });
});

describe("checkDns with AAAA records and this server's addresses", () => {
  const lookup = (v4: string[], v6: string[]): DnsLookup => ({ resolve4: async () => v4, resolve6: async () => v6, resolveCname: async () => [] });
  const here = { v4: ["203.0.113.7"], v6: ["2001:db8::7"] };

  it("passes A and AAAA records that all point here, in any spelling", async () => {
    expect((await checkDns(lookup(["203.0.113.7"], ["2001:0db8:0:0::7"]), "a.example.com", "direct_tls", here)).status).toBe("ok");
    expect((await checkDns(lookup([], ["2001:db8::7"]), "a.example.com", "direct_tls", here)).status).toBe("ok");
  });

  it("refuses an AAAA record elsewhere: Let's Encrypt tries IPv6 first", async () => {
    const r = await checkDns(lookup(["203.0.113.7"], ["2001:db8::99"]), "a.example.com", "direct_tls", here);
    expect(r.status).toBe("mismatch");
    const unknown = await checkDns(lookup(["203.0.113.7"], ["2001:db8::99"]), "a.example.com", "direct_tls", { v4: ["203.0.113.7"], v6: [] });
    expect(unknown.detail).toMatch(/IPv6 address is not known/);
  });

  it("finds this server's addresses from the configuration and the dashboard host, never a Cloudflare edge", async () => {
    const dns: DnsLookup = {
      resolve4: async () => ["198.51.100.20", "104.16.1.1"],
      resolve6: async () => ["2001:db8::20", "2606:4700::1"],
      resolveCname: async () => [],
    };
    expect(await serverAddresses(dns, { serverIpv4: "10.0.0.4", serverIpv6: null, dashboardHost: "dash.example.com" })).toEqual({ v4: ["10.0.0.4", "198.51.100.20"], v6: ["2001:db8::20"] });
    expect(await serverAddresses(dns, { serverIpv4: "203.0.113.7", serverIpv6: null, dashboardHost: null })).toEqual({ v4: ["203.0.113.7"], v6: [] });
  });

  it("filters routable hosts the same way the deploy does", () => {
    expect(routableHosts([{ hostname: "Shop.Example.com", dnsStatus: "ok" }, { hostname: "metadata.google.internal", dnsStatus: "ok" }, { hostname: "dash.example.com", dnsStatus: "ok" }], { reserved: new Set(["dash.example.com"]) })).toEqual(["shop.example.com"]);
  });
});

describe("the tunnel's api rule for installs from before it existed", () => {
  function cf(ingress: CfIngress[]) {
    const puts: unknown[] = [];
    const client: CfClient = {
      call: async <T,>(_path: string, init: { method?: string; body?: unknown } = {}) => {
        if (init.method === "PUT") {
          puts.push(init.body);
          return {} as T;
        }
        return { config: { ingress, "warp-routing": { enabled: false } } } as T;
      },
    };
    return { client, puts };
  }
  const run = (c: CfClient) => ensureDashboardApiRule({ cf: c, accountId: "acc", tunnelId: "0f0e0d0c-0000-4000-8000-0000000000aa", dashboardHost: "dash.example.com", withTunnelLock: (fn) => fn() });
  const old: CfIngress[] = [{ hostname: "dash.example.com", service: "http://web:3000" }, { hostname: "shop.example.com", service: "http://dockify-proxy:80" }, { service: "http://dockify-proxy:80" }];

  it("puts it right above the dashboard rule and keeps everything else", async () => {
    const { client, puts } = cf(old);
    expect(await run(client)).toBe("added");
    expect(puts).toEqual([{ config: { ingress: [{ hostname: "dash.example.com", path: "^/api/v1/", service: "http://172.30.1.10:3001" }, ...old], "warp-routing": { enabled: false } } }]);
  });

  it("changes nothing when it is there, or when the dashboard rule was edited by hand", async () => {
    const present = cf([{ hostname: "dash.example.com", path: "^/api/v1/", service: "http://172.30.1.10:3001" }, ...old]);
    expect(await run(present.client)).toBe("present");
    const custom = cf([{ hostname: "dash.example.com", path: "^/app", service: "http://web:3000" }, { service: "http_status:404" }]);
    expect(await run(custom.client)).toBe("skipped");
    expect([...present.puts, ...custom.puts]).toEqual([]);
  });
});

describe("Docker start events", () => {
  const event = (attrs: Record<string, string>, action = "start", type = "container") => JSON.stringify({ Type: type, Action: action, Actor: { ID: "x", Attributes: attrs } });

  it("asks for start events of Dockify's own containers only", () => {
    expect(JSON.parse(START_EVENTS_FILTER)).toEqual({ type: ["container"], event: ["start"], label: ["dockify.managed=true"] });
  });

  it("names the app of a started app container, and nothing else", () => {
    expect(appStarted(event({ "dockify.managed": "true", "dockify.role": "app", "dockify.app": APP }))).toBe(APP);
    expect(appStarted(event({ "dockify.managed": "true", "dockify.role": "release", "dockify.app": APP }))).toBeNull();
    expect(appStarted(event({ "dockify.managed": "true", "dockify.role": "preview", "dockify.app": "" }))).toBeNull();
    expect(appStarted(event({ "dockify.role": "app", "dockify.app": APP }))).toBeNull();
    expect(appStarted(event({ "dockify.managed": "true", "dockify.role": "app", "dockify.app": APP }, "die"))).toBeNull();
    expect(appStarted(event({ "dockify.managed": "true", "dockify.role": "app", "dockify.app": "../x" }))).toBeNull();
    expect(appStarted("not json")).toBeNull();
  });
});

describe("the work folder in the image and the compose file", () => {
  const root = join(import.meta.dirname, "../../../..");
  it("is created in the image for the runtime user, so an empty volume mounted over it is that user's", async () => {
    const dockerfile = await readFile(join(root, "deploy/Dockerfile"), "utf8");
    const run = /RUN chmod 0755 \/usr\/local\/bin\/dockify-entrypoint \\\n([\s\S]*?)\nUSER node/.exec(dockerfile)?.[1] ?? "";
    expect(run).toMatch(/mkdir -p [^\n]*\/var\/lib\/dockify\/work\b/);
    expect(run).toMatch(/chown node:node [^\n]*\/var\/lib\/dockify\/work\b/);
  });
  it("is the worker's mounted work volume, and its temp folder is inside it", async () => {
    const compose = await readFile(join(root, "deploy/docker-compose.yml"), "utf8");
    const worker = /^ {2}worker:\n([\s\S]*?)(?=^ {2}\S|^\S)/m.exec(compose)?.[1] ?? "";
    expect(worker).toContain("- dockify-work:/var/lib/dockify/work");
    expect(worker).toMatch(/DOCKIFY_TMP_DIR: \/var\/lib\/dockify\/work\//);
  });
});
