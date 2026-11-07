/**
 * The status page must not say Operational while the app answers 502, and the server page lists
 * every control service, not only the api and Postgres.
 */
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { readControlPlane, recordControlPlane } from "./control-plane.ts";
import type { ContainerInspect, ContainerSummary, DockerReader } from "./docker.ts";
import { probeReachability, proxyProbe, reachableFrom, type ReachState } from "./reach.ts";
import { minuteState, REACH_FRESH_MS } from "./uptime.ts";

describe("reachableFrom", () => {
  it("reads gateway errors and Traefik's no-route 404 as unreachable, any other answer as reachable", () => {
    for (const s of [502, 503, 504]) expect(reachableFrom(s, ""), String(s)).toBe(false);
    expect(reachableFrom(404, "404 page not found\n")).toBe(false);
    expect(reachableFrom(404, "<h1>Not here</h1>")).toBe(true);
    for (const s of [200, 301, 401, 500]) expect(reachableFrom(s, ""), String(s)).toBe(true);
  });
});

describe("proxyProbe against a stand-in proxy", () => {
  let server: Server;
  let port = 0;
  const seen: Array<{ host?: string; path?: string }> = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ host: req.headers.host, path: req.url });
      if (req.headers.host === "dead.example.com") return void res.writeHead(502).end("Bad Gateway");
      if (req.headers.host === "noroute.example.com") return void res.writeHead(404, { "Content-Type": "text/plain" }).end("404 page not found\n");
      res.writeHead(200).end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("sends the app's hostname as Host to the proxy, never anywhere else, and reads the answer", async () => {
    // Tunnel mode speaks plain http to the proxy; the test server stands in for it on a free port.
    const probe = (host: string) => proxyProbeOn(port)({ appId: "a", hostname: host, path: "/healthz" });
    expect(await probe("live.example.com")).toBe(true);
    expect(await probe("dead.example.com")).toBe(false);
    expect(await probe("noroute.example.com")).toBe(false);
    expect(seen[0]).toEqual({ host: "live.example.com", path: "/healthz" });
  });

  it("reads a refused connection as unreachable", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const p = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    expect(await proxyProbeOn(p)({ appId: "a", hostname: "x.example.com", path: "/" })).toBe(false);
  });
});

/** The tunnel-mode probe (plain http, as to Traefik on :80), pointed at the stand-in's port. */
const proxyProbeOn = (port: number) => proxyProbe({
  tls: false,
  timeoutMs: 2_000,
  dial: (_target, opts) => new Promise((resolve, reject) => {
    const s = connect({ host: "127.0.0.1", port });
    s.once("connect", () => resolve(s));
    s.once("error", reject);
    if (opts?.timeoutMs) s.setTimeout(opts.timeoutMs, () => s.destroy(new Error("timeout")));
  }),
});

describe("probeReachability", () => {
  it("probes each status page app and stores the verdict on its row and in memory", async () => {
    const writes: Array<{ id: string; data: Record<string, unknown> }> = [];
    const db = {
      app: {
        findMany: async () => [
          { id: "a1", healthCheckPath: "/health", primaryDomain: { hostname: "a1.example.com" }, domains: [{ hostname: "a1.example.com" }] },
          { id: "a2", healthCheckPath: null, primaryDomain: null, domains: [{ hostname: "a2.example.com" }] },
        ],
        updateMany: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          writes.push({ id: where.id, data });
          return { count: 1 };
        },
      },
    } as unknown as Db;
    const asked: string[] = [];
    const state: ReachState = new Map([["gone", { ok: true, at: 0 }]]);
    const n = await probeReachability(db, "s1", async (t) => {
      asked.push(`${t.hostname}${t.path}`);
      return t.appId === "a1";
    }, state, () => 1_000);
    expect(n).toBe(2);
    expect(asked).toEqual(["a1.example.com/health", "a2.example.com/"]);
    expect(writes).toEqual([
      { id: "a1", data: { reachable: true, reachableAt: new Date(1_000) } },
      { id: "a2", data: { reachable: false, reachableAt: new Date(1_000) } },
    ]);
    expect([...state.keys()].sort()).toEqual(["a1", "a2"]);
  });
});

describe("uptime minutes read the reachability verdict", () => {
  const up = { state: "running", health: null };
  it("counts a fresh unreachable verdict as a down minute, and ignores a stale one", () => {
    const now = 10 * 60_000;
    expect(minuteState(up, { ok: false, at: now - 30_000 }, now)).toBe("down");
    expect(minuteState(up, { ok: false, at: now - REACH_FRESH_MS - 1 }, now)).toBe("up");
    expect(minuteState(up, { ok: true, at: now }, now)).toBe("up");
    expect(minuteState(up, undefined, now)).toBe("up");
  });
});

describe("control plane containers", () => {
  const summary = (service: string, state = "running", extra: Record<string, string> = {}): ContainerSummary => ({
    Id: Buffer.from(service).toString("hex").padEnd(64, "0").slice(0, 64),
    Names: [`/dockify-${service}-1`], State: state, Status: "", Created: 0,
    Labels: { "com.docker.compose.project": "dockify", "com.docker.compose.service": service, ...extra },
  });
  const reader = (list: ContainerSummary[], self: ContainerSummary | null): DockerReader => ({
    listManaged: async () => [],
    listFiltered: async (f) => (f.name ? (self ? [self] : []) : list.filter((c) => f.label?.includes(`com.docker.compose.project=${c.Labels["com.docker.compose.project"]}`))),
    inspect: async (id) => {
      const c = list.find((x) => x.Id === id);
      return { Id: id, RestartCount: 0, State: { Status: c?.State ?? "exited", Running: c?.State === "running", Restarting: false, StartedAt: "2026-11-06T08:00:00Z", ...(c?.Labels["com.docker.compose.service"] === "web" ? { Health: { Status: "unhealthy" } } : {}) } } as ContainerInspect;
    },
    stats: async () => ({}),
    followLogs: async () => { throw new Error("unused"); },
  });

  it("lists every long-running service of the worker's own compose project, with state and health", async () => {
    const list = [summary("api"), summary("web"), summary("proxy-direct"), summary("buildkit", "restarting"), summary("migrate", "exited"), summary("updater", "running", { "com.docker.compose.oneoff": "True" })];
    const out = await readControlPlane(reader(list, summary("worker")), "dockify-worker");
    expect(out?.map((s) => s.service)).toEqual(["api", "buildkit", "proxy-direct", "web"]);
    expect(out?.find((s) => s.service === "web")).toMatchObject({ state: "running", health: "unhealthy", startedAt: "2026-11-06T08:00:00Z" });
    expect(out?.find((s) => s.service === "buildkit")?.state).toBe("restarting");
  });

  it("stores nothing when the worker cannot find its own container (dev, no compose)", async () => {
    expect(await readControlPlane(reader([], null), "dockify-worker")).toBeNull();
    expect(await readControlPlane(reader([], null), "")).toBeNull();
    const db = { instance: { updateMany: async () => { throw new Error("must not write"); } } } as unknown as Db;
    expect(await recordControlPlane(db, reader([], null), "dockify-worker")).toBe(0);
  });
});
