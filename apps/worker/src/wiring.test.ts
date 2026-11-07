import { PassThrough } from "node:stream";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadKeyring } from "@dockify/crypto";
import { keyringVault } from "@dockify/db";
import { JobKind, type Db } from "@dockify/db";
import { toState, wireDemux } from "./data/engine-port.ts";
import { textTypes } from "./data/pg-session.ts";
import { bridgeName, DockerClient, DockerError, type DockerApi } from "@dockify/engine";
import { writeRoute } from "./deploy/routes.ts";
import { CERT_RESOLVER, loadEdgeSettings } from "./edge/ingress.ts";
import { fileRouteStore } from "@dockify/engine";
import type { ServerRuntime } from "./server/runtime.ts";
import { isPermanentError, PermanentJobError } from "./errors.ts";
import { parseRemoveApp, removeApp } from "./teardown.ts";
import { buildGlobalHandlers, buildHandlers, buildServerHandlers, routeTargetFor, secretsFor, UNHANDLED_KINDS, workerShared } from "./wiring.ts";

const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 251)).toString("base64");
const vault = keyringVault(loadKeyring({ DOCKIFY_MASTER_KEY: KEY } as NodeJS.ProcessEnv));
const noDb = () => new Proxy({} as Db, { get: (_t, p) => (p === "then" ? undefined : () => { throw new Error(`db touched: ${String(p)}`); }) });
const env = { DOCKIFY_PUBLIC_URL: "https://dash.example.com", DOCKIFY_MASTER_KEY: KEY } as NodeJS.ProcessEnv;
const APP = "0f0e0d0c-0000-4000-8000-0000000000aa";
/** Nothing here is called: the table only needs a runtime to close over. */
const runtime = (): ServerRuntime => ({
  serverId: "s1",
  docker: new DockerClient({ socketPath: "/nowhere" }, { cpuCores: 4 }),
  routes: fileRouteStore("/nowhere"),
  host: async () => { throw new Error("not read"); },
  dial: async () => { throw new Error("not dialled"); },
  builder: {} as never,
  mode: { ingress: "cloudflare_tunnel" },
  cpuCores: 4,
});

describe("worker wiring", () => {
  it("covers every job kind exactly once: a handler, or a reviewed reason not to have one", () => {
    const { handlers } = buildHandlers(runtime(), workerShared({ db: noDb(), vault, env }));
    const handled = Object.keys(handlers).sort();
    for (const k of UNHANDLED_KINDS) expect(handled, k).not.toContain(k);
    expect([...handled, ...UNHANDLED_KINDS].sort()).toEqual(Object.values(JobKind).sort());
  });

  it("splits the table: what touches a server takes a runtime, and vercel_sync, which reaches none, does not", () => {
    const shared = workerShared({ db: noDb(), vault, env });
    const server = Object.keys(buildServerHandlers(runtime(), shared).handlers);
    const global = Object.keys(buildGlobalHandlers({ ...shared, primary: runtime() }));
    expect(server.filter((k) => global.includes(k))).toEqual([]);
    for (const k of ["deploy", "build_detect", "janitor", "reconcile", "edge_route_sync", "prune", "remove_app", "app_power", "backup", "restore", "preview_cleanup", "preview_wake", "scheduled_run"]) expect(server, k).toContain(k);
    for (const k of ["email_send", "deploy_notify", "webhook_send", "vercel_sync", "vercel_mirror", "dns_check", "dashboard_domain", "icon_fetch", "alert_notify"]) expect(global, k).toContain(k);
  });

  it("treats every module's permanent signal as permanent, and nothing else", () => {
    expect(isPermanentError(new PermanentJobError("x"))).toBe(true);
    expect(isPermanentError(Object.assign(new Error("data"), { permanent: true }))).toBe(true);
    expect(isPermanentError(Object.assign(new Error("flaky"), { permanent: false }))).toBe(false);
    expect(isPermanentError(new Error("network"))).toBe(false);
    expect(isPermanentError("text")).toBe(false);
  });

  it("routes an app to its container's own alias on its environment network, never an address", async () => {
    const db = { app: { findUnique: async () => ({ environmentId: "e1" }) } } as unknown as Db;
    const info = (running: boolean, aliases: string[] | null, app = APP) => ({
      State: { Running: running },
      Config: { Labels: { "dockify.app": app } },
      NetworkSettings: { Networks: { "dockify-env-e1": { IPAddress: running ? "10.1.0.5" : "", Aliases: aliases }, other: { IPAddress: "10.9.9.9" } } },
    });
    const docker = (i: unknown) => ({ inspectContainer: async () => i }) as unknown as DockerApi;
    expect(await routeTargetFor(db, docker(info(true, [`dk-${APP}`, "dk-route-dep1"])))(APP)).toEqual({ backend: "dk-route-dep1", network: "dockify-env-e1" });
    // A container made before route aliases: the canonical name, which only the live container holds.
    expect(await routeTargetFor(db, docker(info(true, null)))(APP)).toEqual({ backend: `dk-${APP}`, network: "dockify-env-e1" });
    // Not started yet after a reboot: the route stays on its name, which answers once it is back.
    expect(await routeTargetFor(db, docker(info(false, ["dk-route-dep1"])))(APP)).toEqual({ backend: "dk-route-dep1", network: "dockify-env-e1" });
    // Never a container labelled for another app, whatever its name, and nothing without a container.
    expect(await routeTargetFor(db, docker(info(true, ["dk-route-dep1"], "0f0e0d0c-0000-4000-8000-0000000000ff")))(APP)).toBeNull();
    const gone = { inspectContainer: async () => { throw new DockerError(404, "no such container"); } } as unknown as DockerApi;
    expect(await routeTargetFor(db, gone)(APP)).toBeNull();
  });
});

describe("runtime log redaction", () => {
  // A vault that opens from a fixed table, so the test sees exactly which rows were asked for.
  const tableVault = (values: Record<string, string>) =>
    ({
      open: async (_tx: unknown, ids: string[]) => new Map(ids.map((id) => [id, values[id] ?? null])),
      seal: async () => { throw new Error("not used"); },
      escrow: async () => { throw new Error("not used"); },
    }) as unknown as Parameters<typeof secretsFor>[1];
  const dbFor = (app: object | null, vars: object[] = []) =>
    ({ app: { findUnique: async () => app }, envVar: { findMany: async () => vars } }) as unknown as Db;
  const SVC = { environmentId: "e1", passwordSecretId: "pw", environment: { projectId: "p1" } };

  it("conceals a managed service's own generated password, not only its env vars", async () => {
    const creds = JSON.stringify({ user: "dockify", password: "s3rvice-pass-word", database: "db" });
    const got = await secretsFor(dbFor(SVC, [{ key: "TOKEN", secretId: "v1", isSecret: true, target: "runtime", scopeType: "app" }]), tableVault({ pw: creds, v1: "env-secret-value" }))(APP);
    expect(got).toContain("s3rvice-pass-word");
    expect(got).toContain("env-secret-value");
  });

  it("keeps the service password when an env var cannot be opened, and skips credentials it cannot parse", async () => {
    const creds = JSON.stringify({ user: "default", password: "redis-pass-word" });
    const broken = [{ key: "X", secretId: "gone", isSecret: true, target: "runtime", scopeType: "app" }];
    expect(await secretsFor(dbFor(SVC, broken), tableVault({ pw: creds }))(APP)).toEqual(["redis-pass-word"]);
    expect(await secretsFor(dbFor(SVC), tableVault({ pw: "not json" }))(APP)).toEqual([]);
    expect(await secretsFor(dbFor({ ...SVC, passwordSecretId: null }), tableVault({}))(APP)).toEqual([]);
    expect(await secretsFor(dbFor(null), tableVault({}))(APP)).toEqual([]);
  });
});

describe("tenant bridges", () => {
  it("names every bridge dk- plus 12 hex characters, stable per network", () => {
    const a = bridgeName("dockify-env-0f0e0d0c-0000-4000-8000-000000000001");
    expect(a).toMatch(/^dk-[0-9a-f]{12}$/);
    expect(a.length).toBeLessThanOrEqual(15);
    expect(bridgeName("dockify-env-0f0e0d0c-0000-4000-8000-000000000001")).toBe(a);
    expect(bridgeName("dockify-env-0f0e0d0c-0000-4000-8000-000000000002")).not.toBe(a);
  });
});

describe("one route writer", () => {
  it("the deploy swap writes the edge module's file, with the direct-mode TLS shape when set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dk-wire-"));
    const t = { appId: APP, hosts: ["shop.example.com"], port: 3000, backend: "dk-route-dep1" };
    await writeRoute(fileRouteStore(dir), t, "dash.example.com", { ingress: "direct_tls", certResolver: CERT_RESOLVER });
    const file = await readFile(join(dir, "conf", `${APP}.yml`), "utf8");
    expect(file).toContain("websecure");
    expect(loadEdgeSettings(env).mode).toEqual({ ingress: "cloudflare_tunnel" });
    await expect(writeRoute(fileRouteStore(dir), { ...t, hosts: ["dash.example.com"] }, "dash.example.com", { ingress: "cloudflare_tunnel" })).rejects.toThrow(/dashboard/);
  });
});

describe("teardown", () => {
  it("removes the images only the app ran, and sweeps its environment's network", async () => {
    const A = `sha256:${"a".repeat(64)}`;
    const B = `sha256:${"b".repeat(64)}`;
    const images: string[] = [];
    const docker = {
      listContainers: async () => [],
      listImages: async () => [],
      removeImage: async (id: string) => void images.push(id),
    } as unknown as DockerApi;
    // Another app's rollback target stays; the rows of the deleted app are already gone.
    const db = { deployment: { findFirst: async ({ where }: { where: { imageId: string } }) => (where.imageId === B ? { id: "other" } : null) }, environment: { findMany: async () => [] } } as unknown as Db;
    const swept: string[] = [];
    const networks = {
      docker: {
        listEnvNetworks: async () => { swept.push("listed"); return []; },
      } as never,
      ownContainers: [],
    };
    const dir = await mkdtemp(join(tmpdir(), "dk-rm-"));
    await removeApp({ db, docker, routes: fileRouteStore(dir), removeVolume: async () => {}, networks }, { appId: APP, volumeNames: [], domains: [], imageIds: [A, B, "not-an-id"] }, "s1");
    expect(images).toEqual([A]);
    expect(swept).toEqual(["listed"]);
  });

  it("validates the remove_app payload", () => {
    expect(() => parseRemoveApp({})).toThrow(PermanentJobError);
    const p = parseRemoveApp({ appId: APP, volumeNames: ["ok-vol", "../etc", 3], domains: [{ hostname: "a.example.com", cfZoneId: "z", cfRecordId: "r" }, { nope: 1 }] });
    expect(p.volumeNames).toEqual(["ok-vol"]);
    expect(p.domains).toHaveLength(1);
  });

  it("removes every container of the app, its volumes, and queues the recorded Cloudflare ids only", async () => {
    const removed: string[] = [];
    const volumeFlags: boolean[] = [];
    const jobs: unknown[] = [];
    const docker = {
      listContainers: async (labels: Record<string, string>) => (labels["dockify.app"] === APP ? [{ Id: "c1", Labels: {} }, { Id: "c2", Labels: {} }] : []),
      removeContainer: async (id: string, o?: { volumes?: boolean }) => {
        removed.push(id);
        volumeFlags.push(!!o?.volumes);
      },
      listImages: async () => [],
    } as unknown as DockerApi;
    const db = {
      $transaction: async (fn: (tx: unknown) => unknown) => fn({
        $executeRaw: async () => 0,
        job: { findFirst: async () => null, create: async (a: { data: unknown }) => { jobs.push(a.data); return { id: "j" }; } },
      }),
    } as unknown as Db;
    const dir = await mkdtemp(join(tmpdir(), "dk-rm-"));
    const vols: string[] = [];
    await removeApp({ db, docker, routes: fileRouteStore(dir), removeVolume: async (v) => void vols.push(v) }, {
      appId: APP, volumeNames: ["v1"], domains: [{ hostname: "a.example.com", cfZoneId: "z", cfRecordId: "r" }, { hostname: "b.example.com", cfZoneId: null, cfRecordId: null }],
    }, "s1");
    expect(removed).toEqual(["c1", "c2"]);
    expect(volumeFlags).toEqual([true, true]);
    expect(vols).toEqual(["v1"]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "edge_cf_unwire", serverId: "s1", payload: { zoneId: "z", recordId: "r" } });
  });
});

describe("engine port", () => {
  it("demuxes stdout and keeps a stderr tail", async () => {
    const src = new PassThrough();
    const io = wireDemux(src, null);
    const frame = (kind: number, text: string) => {
      const body = Buffer.from(text);
      const h = Buffer.alloc(8);
      h[0] = kind;
      h.writeUInt32BE(body.length, 4);
      return Buffer.concat([h, body]);
    };
    const chunks: Buffer[] = [];
    io.stdout.on("data", (c: Buffer) => chunks.push(c));
    src.end(Buffer.concat([frame(1, "rows"), frame(2, "warn"), frame(1, "!")]));
    await io.ended;
    await new Promise((r) => setImmediate(r));
    expect(Buffer.concat(chunks).toString()).toBe("rows!");
    expect(io.stderr.text()).toBe("warn");
  });

  it("maps inspect output to the port's container state", () => {
    const s = toState({ Id: "x", State: { Running: true, Health: { Status: "healthy" } }, Config: { Labels: null }, NetworkSettings: { Networks: { n: { IPAddress: "10.0.0.2" }, empty: { IPAddress: "" } } } });
    expect(s).toEqual({ id: "x", running: true, health: "healthy", labels: {}, addresses: { n: "10.0.0.2" } });
  });

  it("parses every postgres value as text", () => {
    const parse = (textTypes as unknown as { getTypeParser: () => (v: string) => unknown }).getTypeParser();
    expect(parse("2026-10-30")).toBe("2026-10-30");
  });
});
