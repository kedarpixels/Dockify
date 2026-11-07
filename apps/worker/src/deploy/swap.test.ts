import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ContainerInput } from "@dockify/engine";
import { canonicalName, envNetwork, routeAlias } from "./containers.ts";
import { DockerError, type ContainerInfo, type DockerApi } from "@dockify/engine";
import { DeployLog } from "./log.ts";
import { waitUntilReady, type HealthConfig, type ProbeDeps } from "./readiness.ts";
import { RolledBackError, swap, type SwapApp } from "./swap.ts";
import { fileRouteStore } from "@dockify/engine";
import type { Dialer } from "../server/runtime.ts";

interface FakeContainer {
  id: string;
  name: string;
  running: boolean;
  ip: string;
  restarts: number;
  input?: ContainerInput;
  /** Aliases of a seeded container; a created one takes its input's. */
  aliases?: string[];
  labels?: Record<string, string>;
}

class FakeDocker implements DockerApi {
  containers = new Map<string, FakeContainer>();
  calls: string[] = [];
  next = 1;
  find(idOrName: string) {
    for (const c of this.containers.values()) if (c.id === idOrName || c.name === idOrName) return c;
    throw new DockerError(404, "no such container");
  }
  seed(name: string, ip: string, aliases?: string[]) {
    const id = `c${this.next++}`;
    this.containers.set(id, { id, name, running: true, ip, restarts: 0, ...(aliases ? { aliases } : {}) });
    return id;
  }
  async inspectContainer(id: string): Promise<ContainerInfo> {
    const c = this.find(id);
    return {
      Id: c.id, Name: `/${c.name}`, Image: "sha256:x", RestartCount: c.restarts,
      State: { Status: c.running ? "running" : "exited", Running: c.running, Restarting: false, ExitCode: c.running ? 0 : 1 },
      Config: { Labels: (c.input?.labels as Record<string, string>) ?? null },
      NetworkSettings: { Networks: c.running ? { [c.input?.network ?? envNetwork(ENV_ID)]: { IPAddress: c.ip, Aliases: c.input?.aliases ?? c.aliases ?? null } } : {} },
    };
  }
  async listContainers(labels: Record<string, string>) {
    return [...this.containers.values()]
      .filter((c) => Object.entries(labels).every(([k, v]) => ((c.input?.labels as Record<string, string> | undefined) ?? c.labels ?? {})[k] === v))
      .map((c) => ({ Id: c.id, Names: [`/${c.name}`], Image: "", ImageID: "", State: c.running ? "running" : "exited", Labels: c.labels ?? {} }));
  }
  async createContainer(name: string, input: ContainerInput) {
    if ([...this.containers.values()].some((c) => c.name === name)) throw new DockerError(409, "name in use");
    const id = `c${this.next++}`;
    this.containers.set(id, { id, name, running: false, ip: `10.0.0.${this.next}`, restarts: 0, input });
    this.calls.push(`create ${name}`);
    return id;
  }
  async startContainer(id: string) { this.find(id).running = true; this.calls.push(`start ${id}`); }
  async stopContainer(id: string) { this.find(id).running = false; this.calls.push(`stop ${id}`); }
  async removeContainer(id: string) { const c = this.find(id); this.containers.delete(c.id); this.calls.push(`remove ${id}`); }
  async renameContainer(id: string, name: string) { this.find(id).name = name; this.calls.push(`rename ${id} ${name}`); }
  async waitContainer() { return 0; }
  async logs() { return Readable.from([]); }
  async inspectImage(): Promise<never> { throw new DockerError(404, "x"); }
  async listImages() { return []; }
  async removeImage() {}
  async pullImage() {}
  async loadImage() {}
  async ensureNetwork() {}
  async connectNetwork(n: string, c: string) { this.calls.push(`connect ${c}`); }
  async disconnectNetwork(n: string, c: string) { this.calls.push(`disconnect ${c}`); }
  async removeVolume() {}
  async ensureVolume() {}
}

const APP_ID = "0f0e0d0c-0000-4000-8000-0000000000aa";
const ENV_ID = "0f0e0d0c-0000-4000-8000-0000000000bb";
const app = (over: Partial<SwapApp> = {}): SwapApp => ({
  id: APP_ID, kind: "backend", environmentId: ENV_ID, projectId: "p", port: 3000, startCommand: null,
  memoryLimitMb: null, cpuLimit: null, pidsLimit: null, capAdd: [], sysctls: {}, volumes: [],
  hosts: ["shop.example.com"],
  routeHosts: ["shop.example.com"],
  health: { path: null, expectedStatus: 200, timeoutSeconds: 1, graceSeconds: 0, intervalSeconds: 1, windowSeconds: 0 },
  ...over,
});
const IMG = `sha256:${"b".repeat(64)}`;
const noLog = () => new DeployLog({ write: async () => {} });

/** `oldAliases`: a previous container made with a route alias; without, one from before route aliases. */
async function setup(listening: boolean, oldAliases?: string[]) {
  const docker = new FakeDocker();
  const proxyDir = await mkdtemp(join(tmpdir(), "dk-swap-"));
  const oldId = docker.seed(canonicalName(APP_ID), "10.0.0.250", oldAliases);
  const routeFile = join(proxyDir, "conf", `${APP_ID}.yml`);
  // What the route said while the new container was being probed, before the flip.
  const duringProbe: string[] = [];
  const deps = {
    docker, log: noLog(), routes: fileRouteStore(proxyDir), mode: { ingress: "cloudflare_tunnel" } as const, dial: async () => { throw new Error("not dialled here"); }, proxyContainer: "proxy", dashboardHost: "dash.example.com", settleMs: 0,
    probe: {
      tcp: async () => {
        duringProbe.push(await readFile(routeFile, "utf8").catch(() => ""));
        return listening;
      },
      sleep: async () => {},
    } as Partial<ProbeDeps>,
  };
  return { docker, proxyDir, oldId, deps, routeFile, duringProbe };
}

describe("swap", () => {
  it("zero downtime: old keeps serving until the new one is ready, then the route flips", async () => {
    const { docker, proxyDir, oldId, deps } = await setup(true);
    const res = await swap(app(), "d1", IMG, { A: "1" }, deps, new AbortController().signal);
    expect(res.mode).toBe("zero_downtime");
    const route = await readFile(join(proxyDir, "conf", `${APP_ID}.yml`), "utf8");
    // By the alias only the new container holds, never by an address.
    expect(route).toContain(`"http://${routeAlias("d1")}.:3000"`);
    expect(route).not.toContain(docker.find(res.containerId).ip);
    // the old container was never stopped before the new one was started
    const firstStopOld = docker.calls.indexOf(`stop ${oldId}`);
    expect(docker.calls.indexOf(`start ${res.containerId}`)).toBeLessThan(firstStopOld);
    expect(() => docker.find(oldId)).toThrow();
    expect(docker.find(res.containerId).name).toBe(canonicalName(APP_ID));
    // Joining the network to probe is the dialer's now (server/dial.test.ts): this holds none of it.
    expect(docker.calls).not.toContain("connect worker");
  });

  it("a failed readiness probe keeps the old container and its name, and says rolled back", async () => {
    const { docker, routeFile, oldId, deps } = await setup(false);
    await expect(swap(app(), "d1", IMG, {}, deps, new AbortController().signal)).rejects.toThrow(RolledBackError);
    const old = docker.find(oldId);
    expect(old.running).toBe(true);
    expect(old.name).toBe(canonicalName(APP_ID));
    expect(docker.containers.size).toBe(1);
    // The route still sends traffic to the old container and never named the new one.
    const route = await readFile(routeFile, "utf8");
    expect(route).toContain('"http://10.0.0.250:3000"');
    expect(route).not.toContain(routeAlias("d1"));
  });

  it("probes the new container through the server's dialer, on its environment network", async () => {
    const { docker, deps } = await setup(true);
    const asked: unknown[] = [];
    const dial: Dialer = async (t, o) => {
      asked.push({ t, timeoutMs: o?.timeoutMs });
      return new PassThrough();
    };
    const res = await swap(app(), "d1", IMG, {}, { ...deps, dial, probe: { sleep: async () => {} } }, new AbortController().signal);
    expect(asked).toEqual([{ t: { container: res.containerId, network: envNetwork(ENV_ID), port: 3000 }, timeoutMs: 1_000 }]);
    expect(docker.find(res.containerId).name).toBe(canonicalName(APP_ID));
  });

  it("nothing answering the dial rolls back as nothing listening", async () => {
    const { docker, oldId, deps } = await setup(true);
    const dial: Dialer = async () => {
      throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    };
    const err = await swap(app(), "d1", IMG, {}, { ...deps, dial, probe: { sleep: async () => {} } }, new AbortController().signal).catch((e: Error) => e);
    expect(err).toBeInstanceOf(RolledBackError);
    expect((err as Error).message).toMatch(/nothing is listening on port 3000/);
    expect(docker.find(oldId).name).toBe(canonicalName(APP_ID));
  });

  it("gives the new container the route alias next to its canonical name", async () => {
    const { docker, deps } = await setup(true);
    const res = await swap(app(), "d1", IMG, {}, deps, new AbortController().signal);
    expect(docker.find(res.containerId).input?.aliases).toEqual([canonicalName(APP_ID), routeAlias("d1")]);
  });

  it("keeps the route on the old container's alias while the new one is probed", async () => {
    const { routeFile, duringProbe, deps } = await setup(true, [canonicalName(APP_ID), routeAlias("d0")]);
    await swap(app(), "d1", IMG, {}, deps, new AbortController().signal);
    expect(duringProbe.length).toBeGreaterThan(0);
    for (const r of duringProbe) expect(r).toContain(`"http://${routeAlias("d0")}.:3000"`);
    expect(await readFile(routeFile, "utf8")).toContain(`"http://${routeAlias("d1")}.:3000"`);
  });

  it("pins a container from before route aliases to its address during the swap, never to the canonical name the new one takes", async () => {
    const { routeFile, duringProbe, deps } = await setup(true);
    await swap(app(), "d1", IMG, {}, deps, new AbortController().signal);
    for (const r of duringProbe) {
      expect(r).toContain('"http://10.0.0.250:3000"');
      expect(r).not.toContain(canonicalName(APP_ID));
    }
    expect(await readFile(routeFile, "utf8")).toContain(`"http://${routeAlias("d1")}.:3000"`);
  });

  it("routes only the domains whose DNS points here, and none at all before one does", async () => {
    const { routeFile, deps } = await setup(true, [routeAlias("d0")]);
    await swap(app({ hosts: ["shop.example.com", "new.example.com"], routeHosts: ["shop.example.com"] }), "d1", IMG, {}, deps, new AbortController().signal);
    const route = await readFile(routeFile, "utf8");
    expect(route).toContain("Host(`shop.example.com`)");
    expect(route).not.toContain("new.example.com");
    await swap(app({ hosts: ["new.example.com"], routeHosts: [] }), "d2", IMG, {}, deps, new AbortController().signal);
    await expect(readFile(routeFile, "utf8")).rejects.toThrow();
  });

  it("stop-then-start for volume apps, restarting the old one when the new one fails", async () => {
    const { docker, oldId, deps } = await setup(false);
    const err = await swap(app({ volumes: [{ id: "v", name: "dk-pg", mountPath: "/data" }] }), "d1", IMG, {}, deps, new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(RolledBackError);
    expect((err as Error).message).toMatch(/restarted/);
    expect(docker.calls.indexOf(`stop ${oldId}`)).toBeLessThan(docker.calls.findIndex((c) => c.startsWith("create")));
    expect(docker.find(oldId).running).toBe(true);
  });

  const OWN = { "dockify.app": APP_ID };
  const parkedLeft = (docker: FakeDocker, stamp: string, running: boolean, aliases?: string[]) => {
    const id = docker.seed(`${canonicalName(APP_ID)}-prev-${stamp}`, "10.0.0.240", aliases);
    const c = docker.find(id);
    c.labels = OWN;
    c.running = running;
    return id;
  };
  /** A world where a dead worker left only a parked container: the canonical name is free. */
  const interrupted = async (listening: boolean, running = true) => {
    const s = await setup(listening);
    docker_remove(s.docker, s.oldId);
    return { ...s, parked: parkedLeft(s.docker, "k1", running, ["dk-route-old"]) };
  };
  const docker_remove = (d: FakeDocker, id: string) => void d.containers.delete(id);

  it("after an interrupted swap the parked container is the previous one, and goes only once the new one serves", async () => {
    const { docker, parked, deps, routeFile, duringProbe } = await interrupted(true);
    await swap(app(), "d2", IMG, {}, deps, new AbortController().signal);
    expect(duringProbe[0]).toContain("dk-route-old");
    expect(() => docker.find(parked)).toThrow();
    expect(docker.find(canonicalName(APP_ID)).running).toBe(true);
    expect([...docker.containers.values()]).toHaveLength(1);
    expect(await readFile(routeFile, "utf8")).toContain(routeAlias("d2"));
  });

  it("a failing retry after an interrupted stop-then-start restarts the parked container and gives it its name back", async () => {
    const { docker, parked, deps } = await interrupted(false, false);
    const err = await swap(app({ volumes: [{ id: "v", name: "dk-pg", mountPath: "/data" }] }), "d2", IMG, {}, deps, new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(RolledBackError);
    expect((err as Error).message).toMatch(/restarted and serves again/);
    expect((err as Error).message).not.toMatch(/no previous container/);
    expect(docker.find(parked)).toMatchObject({ name: canonicalName(APP_ID), running: true });
  });

  it("an earlier attempt of the same deployment under the canonical name is scrapped, not treated as the good one", async () => {
    const { docker, oldId, deps } = await setup(true);
    docker.find(oldId).input = { labels: { "dockify.app": APP_ID, "dockify.deployment": "d2" } } as unknown as ContainerInput;
    const parked = parkedLeft(docker, "k1", true, ["dk-route-old"]);
    await swap(app(), "d2", IMG, {}, deps, new AbortController().signal);
    expect(docker.calls).toContain(`remove ${oldId}`);
    expect(docker.calls).toContain(`remove ${parked}`);
    expect([...docker.containers.values()].map((c) => c.name)).toEqual([canonicalName(APP_ID)]);
  });

  it("a container of another deployment stays the previous one, and leftovers go only after a success", async () => {
    const ok = await setup(true);
    ok.docker.find(ok.oldId).input = { labels: { "dockify.app": APP_ID, "dockify.deployment": "d1" } } as unknown as ContainerInput;
    const ghost = parkedLeft(ok.docker, "k1", true);
    await swap(app(), "d2", IMG, {}, ok.deps, new AbortController().signal);
    expect(() => ok.docker.find(ghost)).toThrow();
    expect(() => ok.docker.find(ok.oldId)).toThrow();

    const bad = await setup(false);
    const kept = parkedLeft(bad.docker, "k1", true);
    await expect(swap(app(), "d2", IMG, {}, bad.deps, new AbortController().signal)).rejects.toBeInstanceOf(RolledBackError);
    expect(bad.docker.find(kept).running).toBe(true);
    expect(bad.docker.find(bad.oldId).name).toBe(canonicalName(APP_ID));
  });

  it("the newest parked container is the one taken back", async () => {
    const { docker, parked, deps } = await interrupted(false);
    const newer = parkedLeft(docker, "z9", true);
    await expect(swap(app(), "d2", IMG, {}, deps, new AbortController().signal)).rejects.toBeInstanceOf(RolledBackError);
    expect(docker.find(newer).name).toBe(canonicalName(APP_ID));
    expect(docker.find(parked).name).toMatch(/-prev-k1$/);
  });

  it("a flip that throws scraps the new container and restores the old one", async () => {
    const { docker, oldId, deps } = await setup(true);
    docker.connectNetwork = async () => { throw new Error("no such network"); };
    await expect(swap(app(), "d2", IMG, {}, deps, new AbortController().signal)).rejects.toThrow(/no such network/);
    expect(docker.find(oldId)).toMatchObject({ name: canonicalName(APP_ID), running: true });
    expect([...docker.containers.values()]).toHaveLength(1);
  });

  it("cancel before create restores the old container", async () => {
    const { docker, oldId, deps } = await setup(true);
    const ac = new AbortController();
    ac.abort();
    await expect(swap(app(), "d1", IMG, {}, deps, ac.signal)).rejects.toThrow(/Cancelled/);
    expect(docker.find(oldId).name).toBe(canonicalName(APP_ID));
    expect(docker.calls.some((c) => c.startsWith("create"))).toBe(false);
  });
});

describe("readiness", () => {
  const info = (over: Partial<ContainerInfo["State"]> = {}, restarts = 0): ContainerInfo => ({
    Id: "c", Name: "/c", Image: "i", RestartCount: restarts,
    State: { Status: "running", Running: true, Restarting: false, ExitCode: 0, ...over },
    Config: { Labels: {} }, NetworkSettings: { Networks: { n: { IPAddress: "10.0.0.9" } } },
  });
  const cfg = (o: Partial<HealthConfig> = {}): HealthConfig => ({ port: 3000, path: null, expectedStatus: 200, timeoutSeconds: 1, graceSeconds: 0, intervalSeconds: 1, windowSeconds: 5, ...o });
  const deps = (o: Partial<ProbeDeps>, clock = { t: 0 }): ProbeDeps => ({
    inspect: async () => info(), addressOf: () => "10.0.0.9", tcp: async () => true, http: async () => 200,
    sleep: async (ms) => void (clock.t += ms), now: () => clock.t, ...o,
  });
  const sig = new AbortController().signal;

  it("passes on a TCP connect, and on the expected HTTP status", async () => {
    expect((await waitUntilReady(cfg(), deps({}), sig)).ok).toBe(true);
    expect((await waitUntilReady(cfg({ path: "/health" }), deps({}), sig)).detail).toMatch(/GET \/health with 200/);
  });
  it("fails on the wrong status after the window", async () => {
    const r = await waitUntilReady(cfg({ path: "/health" }), deps({ http: async () => 503 }), sig);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/answered 503, expected 200/);
  });
  it("counts restarts in plain words, and names none when Docker has not counted one yet", async () => {
    const at = (RestartCount: number, Restarting = true) => ({ State: { Status: "restarting", Running: !Restarting, Restarting, ExitCode: 1 }, RestartCount });
    const read = async (states: Array<ReturnType<typeof at>>) => {
      let i = 0;
      return (await waitUntilReady({ port: null, path: null, expectedStatus: 200, timeoutSeconds: 5, graceSeconds: 0, intervalSeconds: 1, windowSeconds: 5 } as never, {
        inspect: async () => states[Math.min(i++, states.length - 1)],
        now: () => 0, sleep: async () => {}, addressOf: () => null,
      } as never, new AbortController().signal)).detail;
    };
    expect(await read([at(0)])).toBe("is crash-looping, last exit code 1");
    expect(await read([at(0, false), at(1)])).toMatch(/^is crash-looping \(restarted 1 time\)/);
    expect(await read([at(0, false), at(2)])).toMatch(/^is crash-looping \(restarted 2 times\)/);
  });

  it("fails fast on exit and on a crash loop", async () => {
    expect((await waitUntilReady(cfg(), deps({ inspect: async () => info({ Running: false, Status: "exited", ExitCode: 1 }) }), sig)).detail).toMatch(/exit code 1/);
    let n = 0;
    const r = await waitUntilReady(cfg(), deps({ inspect: async () => info({}, n++), tcp: async () => false }), sig);
    expect(r.detail).toMatch(/crash-looping/);
  });
  it("an app with no port must stay up through the settle window", async () => {
    const clock = { t: 0 };
    const r = await waitUntilReady(cfg({ port: null }), deps({}, clock), sig);
    expect(r.ok).toBe(true);
    expect(clock.t).toBeGreaterThanOrEqual(3000);
  });
});
