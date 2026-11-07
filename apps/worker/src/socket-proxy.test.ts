/**
 * The Docker socket is reached only through a proxy that allows the exact
 * endpoints Dockify uses. This test is the contract between the worker's Docker calls and
 * deploy/socket-proxy/haproxy.cfg: every call the worker makes must match an allow rule, and a
 * list of calls the worker never makes (and must never be able to make) must match none. It also
 * runs a real swap through DockerClient against a fake daemon, so the requests checked are the
 * ones the worker actually puts on the wire.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ruleFor } from "../../agent/src/docker-gate.ts";
import { dockerCalls } from "../../../packages/engine/src/docker-calls.fixture.ts";
import { canonicalName, envNetwork } from "./deploy/containers.ts";
import { DockerClient } from "@dockify/engine";
import { fileRouteStore } from "@dockify/engine";
import { DeployLog } from "./deploy/log.ts";
import { RolledBackError, swap, type SwapApp, type SwapDeps } from "./deploy/swap.ts";
import { START_EVENTS_PATH } from "./edge/starts.ts";

const CFG = new URL("../../../deploy/socket-proxy/haproxy.cfg", import.meta.url);
const COMPOSE = new URL("../../../deploy/docker-compose.yml", import.meta.url);

/** One condition of an allow rule, in the forms haproxy.cfg uses. All of a rule's conditions must hold. */
type Cond =
  | { kind: "path"; re: RegExp }
  | { kind: "query"; re: RegExp }
  | { kind: "headerCount"; header: string; count: number };

interface Rule {
  method: string;
  conds: Cond[];
}

/** A request as HAProxy sees it: method, raw path with its query string, and headers. */
interface Call {
  method: string;
  url: string;
  headers?: Record<string, string>;
}

/** One "{ ... }" condition. Anything this test cannot model throws, so it is never silently skipped. */
function condition(words: string[], line: string): Cond {
  if (words.length === 2 && words[0] === "path_reg") return { kind: "path", re: new RegExp(words[1]!) };
  if (words.length === 4 && words[0] === "query" && words[1] === "-m" && words[2] === "reg") return { kind: "query", re: new RegExp(words[3]!) };
  if (words.length === 5 && words[0] === "query" && words[1] === "-m" && words[2] === "reg" && words[3] === "-i") return { kind: "query", re: new RegExp(words[4]!, "i") };
  const hdr = /^req\.hdr_cnt\(([a-z0-9-]+)\)$/.exec(words[0] ?? "");
  if (hdr && words.length === 3 && words[1] === "eq" && /^\d+$/.test(words[2]!)) return { kind: "headerCount", header: hdr[1]!, count: Number(words[2]) };
  throw new Error(`a condition this test cannot model: { ${words.join(" ")} } in: ${line.trim()}`);
}

/**
 * Reads an allow line the way HAProxy does: words split on whitespace, then METH_<X> and one or
 * more "{ ... }" groups, which are ANDed. A negation, an "or" or anything else throws.
 */
function parseRule(line: string): Rule {
  const all = line.trim().split(/\s+/);
  // A deny with conditions reads the same after its status.
  const words = all[1] === "deny" && all[2] === "deny_status" ? [all[0]!, "allow", ...all.slice(4)] : all;
  const meth = /^METH_([A-Z]+)$/.exec(words[3] ?? "");
  if (words[0] !== "http-request" || words[1] !== "allow" || words[2] !== "if" || !meth) throw new Error(`not an allow rule this test can read: ${line.trim()}`);
  const rest = words.slice(4);
  const conds: Cond[] = [];
  while (rest.length) {
    const close = rest.indexOf("}");
    if (rest[0] !== "{" || close < 2) throw new Error(`not a { ... } condition in: ${line.trim()}`);
    conds.push(condition(rest.slice(1, close), line));
    rest.splice(0, close + 1);
  }
  return { method: meth[1]!, conds };
}

async function rules(): Promise<Rule[]> {
  const text = await readFile(CFG, "utf8");
  return text.split("\n").filter((l) => !l.trim().startsWith("#") && /http-request allow/.test(l)).map(parseRule);
}

/** HAProxy's req.hdr_cnt: every occurrence of the header, each comma separated part counted. */
function headerCount(headers: Record<string, string> | undefined, name: string): number {
  let n = 0;
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === name) n += v.split(",").length;
  return n;
}

function matches(rule: Rule, c: Call): boolean {
  if (rule.method !== c.method) return false;
  const q = c.url.indexOf("?");
  // HAProxy's path ends before the first "?"; query is what follows it, and absent without one.
  const path = q === -1 ? c.url : c.url.slice(0, q);
  const query = q === -1 ? undefined : c.url.slice(q + 1);
  return rule.conds.every((k) => {
    if (k.kind === "path") return k.re.test(path);
    if (k.kind === "query") return query !== undefined && k.re.test(query);
    return headerCount(c.headers, k.header) === k.count;
  });
}

const allowed = (list: Rule[], c: Call): boolean => list.some((r) => matches(r, c));
/** The conditional denies, which come before the allow they narrow. */
async function denies(): Promise<Rule[]> {
  const text = await readFile(CFG, "utf8");
  return text.split("\n").filter((l) => !l.trim().startsWith("#") && /http-request deny deny_status \d+ if /.test(l)).map(parseRule);
}
const call = ([method, url, headers]: [string, string, Record<string, string>?]): Call => ({ method, url, ...(headers ? { headers } : {}) });

const { APP_ID, ENV_ID, LIVE, PARKED, HEX_ID, USED, AGENT_ONLY, FORBIDDEN } = dockerCalls(canonicalName, START_EVENTS_PATH);

interface FakeContainer {
  name: string;
  running: boolean;
  labels: Record<string, string>;
}

/**
 * Just enough of the Docker Engine API for swap(), on a real local port, so the test sees every
 * request exactly as DockerClient puts it on the wire. Containers resolve by id or by name, the way
 * the daemon resolves them. It starts with one running container holding the app's live name.
 */
async function fakeDaemon() {
  const sent: Call[] = [];
  const containers = new Map<string, FakeContainer>([[HEX_ID, { name: LIVE, running: true, labels: {} }]]);
  let next = 0;
  const lookup = (ref: string): [string, FakeContainer] | null => {
    const key = decodeURIComponent(ref);
    const byId = containers.get(key);
    if (byId) return [key, byId];
    for (const entry of containers) if (entry[1].name === key) return entry;
    return null;
  };
  const server = createServer((req, res) => {
    const body: Buffer[] = [];
    req.on("data", (c: Buffer) => body.push(c));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
      sent.push({ method: req.method ?? "", url: req.url ?? "", headers });
      const u = new URL(req.url ?? "/", "http://docker");
      const path = u.pathname.replace(/^\/v1\.\d+/, "");
      const reply = (status: number, json?: unknown) => {
        res.writeHead(status, json === undefined ? {} : { "Content-Type": "application/json" });
        res.end(json === undefined ? undefined : JSON.stringify(json));
      };
      const m = /^\/containers\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
      if (req.method === "POST" && path === "/containers/create") {
        const name = u.searchParams.get("name") ?? "";
        if ([...containers.values()].some((c) => c.name === name)) return reply(409, { message: "name in use" });
        const id = (next++).toString(16).padStart(64, "b");
        const spec = JSON.parse(Buffer.concat(body).toString("utf8") || "{}") as { Labels?: Record<string, string> };
        containers.set(id, { name, running: false, labels: spec.Labels ?? {} });
        return reply(201, { Id: id });
      }
      if (req.method === "GET" && path === "/containers/json") {
        return reply(200, [...containers].map(([id, c]) => ({ Id: id, Names: [`/${c.name}`], Image: "", ImageID: "", State: "", Labels: c.labels })));
      }
      if (m) {
        const found = lookup(m[1]!);
        if (!found) return reply(404, { message: `No such container: ${m[1]}` });
        const [id, c] = found;
        const action = `${req.method} ${m[2] ?? ""}`;
        if (action === "GET json") {
          return reply(200, {
            Id: id, Name: `/${c.name}`, Image: "sha256:x", RestartCount: 0,
            State: { Status: c.running ? "running" : "exited", Running: c.running, Restarting: false, ExitCode: 0 },
            Config: { Labels: c.labels },
            NetworkSettings: { Networks: c.running ? { [envNetwork(ENV_ID)]: { IPAddress: "10.0.0.2" } } : {} },
          });
        }
        if (action === "GET logs") return reply(200);
        if (action === "POST rename") {
          const to = u.searchParams.get("name") ?? "";
          if ([...containers.values()].some((o) => o !== c && o.name === to)) return reply(409, { message: "name in use" });
          c.name = to;
          return reply(204);
        }
        if (action === "POST start" || action === "POST stop") {
          c.running = action === "POST start";
          return reply(204);
        }
        if (action === "DELETE ") {
          containers.delete(id);
          return reply(204);
        }
      }
      if (req.method === "GET" && /^\/networks\/[^/]+$/.test(path)) return reply(200, { Name: path.slice("/networks/".length) });
      if (req.method === "POST" && /^\/networks\/[^/]+\/(connect|disconnect)$/.test(path)) return reply(200);
      if (req.method === "POST" && path === "/volumes/create") return reply(201, {});
      reply(500, { message: `the fake daemon does not model ${req.method} ${path}` });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    sent,
    containers,
    docker: new DockerClient({ host: "127.0.0.1", port }, { cpuCores: 4 }),
    close: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

const swapApp = (over: Partial<SwapApp> = {}): SwapApp => ({
  id: APP_ID, kind: "backend", environmentId: ENV_ID, projectId: "p", port: 3000, startCommand: null,
  memoryLimitMb: null, cpuLimit: null, pidsLimit: null, capAdd: [], sysctls: {}, volumes: [],
  hosts: ["shop.example.com"],
  routeHosts: ["shop.example.com"],
  health: { path: null, expectedStatus: 200, timeoutSeconds: 1, graceSeconds: 0, intervalSeconds: 1, windowSeconds: 0 },
  ...over,
});

/** Runs one swap against the fake daemon and returns what reached the wire, and how it ended. */
async function wireSwap(app: SwapApp, listening: boolean, leftover = false) {
  const daemon = await fakeDaemon();
  if (leftover) daemon.containers.set("e".repeat(64), { name: `${LIVE}-prev-k3j2`, running: true, labels: { "dockify.app": APP_ID } });
  const proxyDir = await mkdtemp(join(tmpdir(), "dk-proxy-"));
  try {
    const deps: SwapDeps = {
      docker: daemon.docker, log: new DeployLog({ write: async () => {} }),
      routes: fileRouteStore(proxyDir), mode: { ingress: "cloudflare_tunnel" }, dial: async () => { throw new Error("not dialled here"); },
      proxyContainer: "dockify-proxy", dashboardHost: "dash.example.com", settleMs: 0,
      probe: { tcp: async () => listening, sleep: async () => {}, now: () => 0 },
    };
    const outcome = await swap(app, "d1", `sha256:${"c".repeat(64)}`, {}, deps, new AbortController().signal).then(() => null, (e: unknown) => e);
    const live = [...daemon.containers].find(([, c]) => c.name === LIVE)?.[0] ?? null;
    return { sent: daemon.sent, outcome, live };
  } finally {
    await daemon.close();
    await rm(proxyDir, { recursive: true, force: true });
  }
}

const renames = (sent: Call[]) => sent.filter((c) => /\/rename(\?|$)/.test(c.url)).map((c) => c.url);
const PARKED_RENAME = new RegExp(`^/v1\\.43/containers/${LIVE}/rename\\?name=${LIVE}-prev-[0-9a-z]+$`);
const RESTORE_RENAME = new RegExp(`^/v1\\.43/containers/${LIVE}-prev-[0-9a-z]+/rename\\?name=${LIVE}$`);

describe("socket proxy allowlist", () => {
  it("lists only method-and-path rules, one per line, and ends with a deny", async () => {
    const text = await readFile(CFG, "utf8");
    const list = await rules();
    expect(list.length).toBeGreaterThan(20);
    // Every allow line parsed: a malformed rule would throw rather than vanish from this check.
    const allowLines = text.split("\n").filter((l) => !l.trim().startsWith("#") && /http-request allow/.test(l));
    expect(allowLines).toHaveLength(list.length);
    expect(text).toMatch(/^\s*http-request deny deny_status 403\s*$/m);
    expect(text.search(/^\s*http-request deny deny_status 403\s*$/m)).toBeGreaterThan(text.lastIndexOf("http-request allow"));
    for (const r of list) {
      // Each rule gates on exactly one path, first, and every regex is anchored at both ends.
      expect(r.conds[0]?.kind).toBe("path");
      expect(r.conds.filter((k) => k.kind === "path")).toHaveLength(1);
      for (const k of r.conds) if (k.kind !== "headerCount") expect(k.re.source, k.re.source).toMatch(/^\^.*\$$/);
    }
  });

  it("allows every endpoint the worker uses", async () => {
    const list = await rules();
    for (const u of [...USED, ...AGENT_ONLY]) expect(allowed(list, call(u)), `${u[0]} ${u[1]}`).toBe(true);
  });

  it("refuses every endpoint the worker must never reach", async () => {
    const list = await rules();
    for (const f of FORBIDDEN) expect(allowed(list, call(f)), `${f[0]} ${f[1]} ${JSON.stringify(f[2] ?? {})}`).toBe(false);
  });

  it("refuses a pull from an internal registry by the same list as the gate, and keeps a LAN one", async () => {
    const [allow, deny] = [await rules(), await denies()];
    const pull = (ref: string): Call => ({ method: "POST", url: `/v1.43/images/create?fromImage=${new URLSearchParams({ x: ref }).toString().slice(2)}` });
    expect(deny.length).toBe(1);
    for (const ref of [
      "127.0.0.1:5000/x", "127.1.2.3/x", "0.0.0.0:80/x", "LOCALHOST:5000/x", "localhost/x", "localhost.:5000/x", "a.localhost/x", "localhost.localdomain/x", "ip6-localhost:80/x", "ip6-loopback:80/x",
      "169.254.169.254/x", "169.254.0.1:80/x", "100.100.100.200/x", "168.63.129.16/x", "metadata:80/x", "metadata.google.internal/x", "metadata.goog/x", "instance-data:80/x", "instance-data.ec2.internal/x", "host.docker.internal/x",
      "172.30.1.10:3001/x", "172.30.2.10/x", "172.30.3.2:5432/x", "172.30.4.2:2375/x", "172.30.5.30/x",
      "127.1:5000/x", "2130706433:5000/x", "0x7f000001:80/x", "0x7f.0.0.1/x", "0177.0.0.1/x", "127.0.0.01/x", "0:80/x", "127.0.0.1./x",
    ]) {
      expect(allowed(deny, pull(ref)), ref).toBe(true);
      expect(() => ruleFor("POST", pull(ref).url), `the gate on ${ref}`).toThrow();
    }
    for (const ref of [
      "nginx:1.27", "acme/web:1", "ghcr.io/a/b:1", "docker.io/library/nginx", "192.168.1.5:5000/x", "10.0.0.7:5000/a/b:1", "172.16.0.5/x", "172.30.6.5:5000/x", "100.64.0.1/x",
      "registry.lan:5000/x", "registry.corp.internal/x", "127.example.com/x", "localhost.example.com/x", "metadata.example.com/x", "metadata/x", "instance-data/x", "ip6-localhost/x", "1234/app", "0x7f/x", "127.0.0.1:8000", `postgres:16@sha256:${"a".repeat(64)}`,
    ]) {
      expect(allowed(deny, pull(ref)), ref).toBe(false);
      expect(allowed(allow, pull(ref)), ref).toBe(true);
      expect(() => ruleFor("POST", pull(ref).url), `the gate on ${ref}`).not.toThrow();
    }
  });

  it("puts that deny ahead of the allow it narrows", async () => {
    const lines = (await readFile(CFG, "utf8")).split("\n").filter((l) => !l.trim().startsWith("#"));
    const deny = lines.findIndex((l) => /http-request deny deny_status 403 if METH_POST \{ path_reg \S+images\/create/.test(l));
    const allow = lines.findIndex((l) => /http-request allow if METH_POST \{ path_reg \S+images\/create/.test(l));
    expect(deny).toBeGreaterThan(-1);
    expect(deny).toBeLessThan(allow);
  });

  it("renames only a dk- container, only to a dk- name, with nothing but the name in the request", async () => {
    const list = await rules();
    const rename = (from: string, query: string, headers?: Record<string, string>) =>
      allowed(list, { method: "POST", url: `/v1.43/containers/${from}/rename${query}`, ...(headers ? { headers } : {}) });
    expect(rename("dk-x", "?name=dk-x-prev-k3j2")).toBe(true);
    expect(rename("dk-x-prev-k3j2", "?name=dk-x")).toBe(true);
    // a control container, by name or by daemon id, never gets a dk- name
    for (const from of ["dockify-api-1", "dockify-postgres-1", "postgres", HEX_ID, HEX_ID.slice(0, 12)]) expect(rename(from, "?name=dk-x"), from).toBe(false);
    // a dk- container never leaves the dk- names
    for (const to of ["dockify-api-1", "api", "dockify-rt-x", "x-dk-y"]) expect(rename("dk-x", `?name=${to}`), to).toBe(false);
    expect(rename("dk-x", "?name=dk-y&name=api")).toBe(false);
    expect(rename("dk-x", "?name=api&name=dk-y")).toBe(false);
    expect(rename("dk-x", "?name=dk-y", { "content-type": "application/x-www-form-urlencoded" })).toBe(false);
  });

  it("passes every request a real swap sends, and the swap renames by name, never by daemon id", async () => {
    const list = await rules();
    const scenarios = [
      { what: "zero downtime", app: swapApp(), listening: true },
      { what: "zero downtime rollback", app: swapApp(), listening: false },
      { what: "stop then start rollback", app: swapApp({ volumes: [{ id: "v", name: "dk-0f0e0d0c-data", mountPath: "/data" }] }), listening: false },
      { what: "zero downtime over a container an interrupted deploy left parked", app: swapApp(), listening: true, leftover: true },
    ];
    for (const s of scenarios) {
      const run = await wireSwap(s.app, s.listening, s.leftover);
      expect(run.sent.length, s.what).toBeGreaterThan(5);
      for (const c of run.sent) expect(allowed(list, c), `${s.what}: ${c.method} ${c.url}`).toBe(true);
      // The agent's gate stands in front of this list, and takes the same calls.
      for (const c of run.sent) expect(() => ruleFor(c.method, c.url, c.headers), `${s.what}: ${c.method} ${c.url}`).not.toThrow();
      const seen = renames(run.sent);
      expect(seen.some((u) => u.includes(HEX_ID)), s.what).toBe(false);
      if (s.listening) {
        expect(run.outcome, s.what).toBeNull();
        expect(seen, s.what).toHaveLength(1);
        expect(seen[0], s.what).toMatch(PARKED_RENAME);
        // the new container holds the live name and the previous one is gone
        expect(run.live, s.what).not.toBeNull();
        expect(run.live, s.what).not.toBe(HEX_ID);
      } else {
        expect(run.outcome, s.what).toBeInstanceOf(RolledBackError);
        expect(seen, s.what).toHaveLength(2);
        expect(seen[0], s.what).toMatch(PARKED_RENAME);
        expect(seen[1], s.what).toMatch(RESTORE_RENAME);
        // the rollback gave the previous container its live name back
        expect(run.live, s.what).toBe(HEX_ID);
      }
    }
  });

  it("passes the disk breakdown's /system/df read exactly as DockerClient sends it", async () => {
    const list = await rules();
    const sent: Call[] = [];
    const server = createServer((req, res) => {
      sent.push({ method: req.method ?? "", url: req.url ?? "" });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ LayersSize: 0, Images: [], Volumes: [] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const docker = new DockerClient({ host: "127.0.0.1", port: (server.address() as AddressInfo).port }, { cpuCores: 4 });
      await docker.diskUsage(["image", "volume"]);
      await docker.diskUsage(["image"]);
      await docker.diskUsage(["volume"]);
      // No type at all would ask Docker for everything, which the proxy refuses; the client never sends it.
      await expect(docker.diskUsage([])).rejects.toThrow(/at least one object type/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(sent.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /v1.43/system/df?type=image&type=volume",
      "GET /v1.43/system/df?type=image",
      "GET /v1.43/system/df?type=volume",
    ]);
    for (const c of sent) expect(allowed(list, c), c.url).toBe(true);
  });

  it("is what the compose file mounts, with no area-level switches left", async () => {
    const compose = await readFile(COMPOSE, "utf8");
    const m = /^ {2}socket-proxy:\n([\s\S]*?)(?=^ {2}\S|^\S)/m.exec(compose);
    expect(m, "deploy/docker-compose.yml has a socket-proxy service").not.toBeNull();
    const svc = m?.[1] ?? "";
    expect(svc).toContain("./socket-proxy/haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro");
    expect(svc).toContain("/var/run/docker.sock:/var/run/docker.sock:ro");
    for (const area of ["CONTAINERS:", "IMAGES:", "POST:", "EXEC:", "ALLOW_START:", "BUILD:", "SYSTEM:"]) expect(svc, area).not.toContain(area);
    expect(svc).toMatch(/image: [^\s@]+@sha256:[a-f0-9]{64}/);
  });
});
