/**
 * The agent's calls, one H2 stream each, all on the authenticated link. Only the worker can reach
 * these: it dials nothing here, and the agent starts no request of its own. Every body is parsed with
 * the shared schemas, because the caller may be a compromised control plane.
 */
import { link as L } from "@dockify/contracts";
import { buildImage, cachePruneArgs, duArgs, endWhenDone, pruneArgs, readHost, runPlanStep, scopePruneArgs, type BuildServer, type BuildVar, type Dialer, type RouteStore, reason } from "@dockify/engine";
import { Redactor } from "@dockify/redact";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { constants as h2c, type IncomingHttpHeaders, type ServerHttp2Stream } from "node:http2";
import os from "node:os";
import { join } from "node:path";
import { unpackContext } from "./context-tar-guard.ts";
import type { DockerGate } from "./docker-gate.ts";
import { refuseCollidingNames, RouteRefusal, validateRouteFile, type RouteRules } from "./routes.ts";

export interface AgentDeps {
  gate: DockerGate;
  dial: Dialer;
  routes: RouteStore;
  routeRules: RouteRules;
  /** The addresses tenant containers hold now. A route file naming an address needs one of these. */
  heldAddresses?: () => Promise<ReadonlySet<string>>;
  /** Where the disk readings come from: any path on the filesystem Docker keeps containers on. */
  diskPath: string;
  buildRoot: string;
  build: BuildServer;
  /** The largest context this server takes, whatever the first line asks for. */
  maxContextBytes?: number;
  /** The facts /v1/info answers with, apart from the clock and what the kernel says. */
  facts: { version: string; hostname: string; publicIpv4: string | null; publicIpv6: string | null; dockerVersion: string | null; os: string | null; ingress: "cloudflare_tunnel" | "direct_tls" };
  /** A test's stand-ins for what needs the real BuildKit. */
  buildImage?: typeof buildImage;
  runPlanStep?: typeof runPlanStep;
  buildctl?: (args: string[], timeoutMs: number, maxBuffer: number) => Promise<string>;
}

/** The JSON for every cache record can run to megabytes on a busy builder. */
const CACHE_MAX_BUFFER = 64 * 1024 * 1024;
const TRIM_TIMEOUT_MS = 10 * 60_000;
/** A route change holds many small files at most. */
const ROUTE_BODY_MAX = 16 * 1024 * 1024;
/** Route bodies being read at once: the agent's mem_limit is 512m and a link holds up to 256 streams. */
const ROUTE_BUFFERED_MAX = 64 * 1024 * 1024;
/** Only a pinned address reads like this, and the fixed upstreams, which costs one list. A miss only refuses. */
const NAMES_AN_ADDRESS = /"http:\/\/\d/;

const runBuildctl = (args: string[], timeoutMs: number, maxBuffer: number) =>
  new Promise<string>((resolve, reject) =>
    execFile("buildctl", args, { timeout: timeoutMs, maxBuffer, windowsHide: true }, (e, out) => (e ? reject(e) : resolve(out))),
  );


function json(st: ServerHttp2Stream, status: number, body: unknown): void {
  if (st.destroyed || st.closed) return;
  if (!st.headersSent) st.respond({ ":status": status, "content-type": "application/json" });
  st.end(JSON.stringify(body));
}

let buffered = 0;

async function readJson(st: ServerHttp2Stream, max: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const c of st) {
      const n = (c as Buffer).length;
      if (size + n > max) throw new RouteRefusal("that body is too large");
      if (buffered + n > ROUTE_BUFFERED_MAX) throw new RouteRefusal("too many bodies are being read at once");
      size += n;
      buffered += n;
      chunks.push(c as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    buffered -= size;
  }
}

/**
 * The repository's folder inside an unpacked context, with no link anywhere along it. A link here would
 * make its target the boundary every later check measures from, so a build could read the agent's key.
 */
export async function repositoryFolder(context: string, repoDir: string): Promise<string> {
  const parts = repoDir === "" ? [] : repoDir.split("/");
  if (repoDir.startsWith("/") || repoDir.includes("\\") || repoDir.includes("\0") || parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new Error("the repository folder must be a relative path");
  }
  const notReal = "the repository folder must be a real folder in the context, with no link along its path";
  let dir = context;
  for (const part of parts) {
    dir = join(dir, part);
    const st = await lstat(dir).catch(() => null);
    if (!st?.isDirectory()) throw new Error(notReal);
  }
  if ((await realpath(dir)) !== join(await realpath(context), ...parts)) throw new Error(notReal);
  return dir;
}

/** The first line of a stream, leaving the rest of its bytes for whoever reads next. */
async function readLine(st: ServerHttp2Stream, max: number): Promise<string> {
  let got: Buffer = Buffer.alloc(0);
  for (;;) {
    const nl = got.indexOf(0x0a);
    if (nl !== -1) {
      const rest = got.subarray(nl + 1);
      if (rest.length) st.unshift(rest);
      return got.subarray(0, nl).toString("utf8");
    }
    if (got.length > max) throw new Error("the first line is too long");
    const chunk = st.read() as Buffer | null;
    if (chunk) {
      got = Buffer.concat([got, chunk]);
      continue;
    }
    if (st.readableEnded || st.destroyed) throw new Error("the stream ended before its first line");
    await new Promise<void>((resolve) => {
      const done = () => {
        st.off("readable", done);
        st.off("end", done);
        st.off("close", done);
        resolve();
      };
      st.once("readable", done);
      st.once("end", done);
      st.once("close", done);
    });
  }
}

export function createAgentApi(deps: AgentDeps) {
  const build = deps.buildImage ?? buildImage;
  const plan = deps.runPlanStep ?? runPlanStep;
  const buildctl = deps.buildctl ?? runBuildctl;
  const addr = deps.build.buildkitAddr;
  const maxContext = deps.maxContextBytes ?? L.LINK_LIMITS.contextBytesDefault;

  const info = (): L.AgentInfo => ({
    version: deps.facts.version,
    proto: L.PROTO_CURRENT,
    hostname: deps.facts.hostname,
    publicIpv4: deps.facts.publicIpv4,
    publicIpv6: deps.facts.publicIpv6,
    cores: Math.max(1, os.cpus().length),
    memoryBytes: os.totalmem(),
    dockerVersion: deps.facts.dockerVersion,
    kernel: os.release(),
    os: deps.facts.os,
    ingress: deps.facts.ingress,
    clock: Date.now(),
  });

  /**
   * A build or a read: first line, then the context, then log lines back and one last line. The context
   * unpacks into a folder of its own, so nothing in it can stand where a step writes: `root` holds `ctx`
   * and, beside it, the folders the steps make, where no tar entry ever reached.
   */
  const withContext = async <T extends { repoDir: string; maxBytes: number }>(
    st: ServerHttp2Stream,
    parse: (line: unknown) => T,
    run: (req: T, repo: { root: string; dir: string }, send: (line: L.BuildLine) => void, signal: AbortSignal) => Promise<unknown>,
  ): Promise<void> => {
    const ac = new AbortController();
    st.once("close", () => ac.abort());
    const send = (line: L.BuildLine): void => {
      if (!st.destroyed && !st.closed) st.write(`${JSON.stringify(line)}\n`);
    };
    st.respond({ ":status": 200, "content-type": "application/x-ndjson" });
    const root = join(deps.buildRoot, randomUUID());
    try {
      const req = parse(JSON.parse(await readLine(st, L.LINK_LIMITS.buildHeaderBytes)));
      await mkdir(root, { recursive: true, mode: 0o700 });
      const context = join(root, "ctx");
      await unpackContext(st as AsyncIterable<Buffer>, context, { maxBytes: Math.min(req.maxBytes, maxContext) });
      const result = await run(req, { root, dir: await repositoryFolder(context, req.repoDir) }, send, ac.signal);
      send({ t: "end", result });
    } catch (e) {
      send({ t: "error", m: reason(e), permanent: (e as { permanent?: unknown }).permanent === true });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      if (!st.destroyed) st.end();
    }
  };

  const handleBuild = (st: ServerHttp2Stream) =>
    withContext(st, (l) => L.BuildRequest.parse(l), async (req, repo, send, signal) => {
      const { repoDir: _r, maxBytes: _m, vars, ...rest } = req;
      // Its own redactor: a failed build's reason quotes these lines, and it crosses the link.
      const redactor = new Redactor();
      const log = {
        redactor,
        system: (text: string) => send({ t: "system", m: text.slice(0, 16 * 1024) }),
        add: (stream: "stdout" | "stderr", raw: string) => {
          const text = redactor.line(raw).slice(0, 16 * 1024);
          send({ t: stream, m: text });
          return text;
        },
      };
      return build(deps.build, { ...withoutUndefined(rest), vars: vars as BuildVar[], checkoutDir: repo.dir, checkoutRoot: repo.root }, log, signal);
    });

  const handleDetect = (st: ServerHttp2Stream) =>
    withContext(st, (l) => L.PlanRequest.parse(l), async (req, repo, send, signal) => {
      const out = await plan(addr, { checkoutRoot: repo.root, checkoutDir: repo.dir, rootDir: req.rootDir, vars: req.vars as BuildVar[], overrides: req.overrides, timeoutMs: req.timeoutMs }, (line) => {
        send({ t: "stderr", m: line.slice(0, 16 * 1024) });
        return line;
      }, signal);
      const { contextDir: _c, planDir: _p, ...rest } = out;
      return rest;
    });

  const handleCache = async (st: ServerHttp2Stream) => {
    const req = L.CacheRequest.parse(await readJson(st, 4 * 1024));
    const out = req.op === "du"
      ? await buildctl(duArgs(addr), req.timeoutMs, CACHE_MAX_BUFFER)
      : req.op === "prune"
        ? await buildctl(cachePruneArgs(addr), req.timeoutMs, CACHE_MAX_BUFFER)
        : req.op === "pruneScope"
          ? await buildctl(scopePruneArgs(addr, req.scope), req.timeoutMs, CACHE_MAX_BUFFER)
          : await buildctl(pruneArgs(addr, req.keepBytes), TRIM_TIMEOUT_MS, 1_000_000);
    json(st, 200, { output: out });
  };

  const handleRoutes = async (st: ServerHttp2Stream, method: string, query: URLSearchParams) => {
    if (method === "GET") {
      const name = query.get("name");
      if (name !== null) return json(st, 200, { content: await deps.routes.read(name) });
      return json(st, 200, { files: await deps.routes.snapshot() });
    }
    const change = L.RouteChangeBody.parse(await readJson(st, ROUTE_BODY_MAX));
    const sent = Object.entries(change.writes ?? {});
    const held = sent.some(([, text]) => NAMES_AN_ADDRESS.test(text)) ? await deps.heldAddresses?.() : undefined;
    const rules: RouteRules = held ? { ...deps.routeRules, heldAddresses: held } : deps.routeRules;
    // What goes to the folder is what the validator wrote, never what came over the link.
    const writes = Object.fromEntries(sent.map(([name, text]) => [name, validateRouteFile(text, rules, name)]));
    if (sent.length) refuseCollidingNames(await deps.routes.snapshot(), writes, change.removes ?? []);
    await deps.routes.apply({ writes, ...(change.removes ? { removes: change.removes } : {}) });
    json(st, 200, { ok: true });
  };

  const handleDial = async (st: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
    const raw = headers["x-dial"];
    const target = L.DialRequest.parse(JSON.parse(typeof raw === "string" ? raw : "null"));
    const { timeoutMs, ...to } = target as L.DialRequest & { timeoutMs?: number };
    const ac = new AbortController();
    st.once("close", () => ac.abort());
    const socket = await deps.dial(to as Parameters<Dialer>[0], { ...(timeoutMs ? { timeoutMs } : {}), signal: ac.signal });
    if (st.destroyed || st.closed) return void socket.destroy();
    st.respond({ ":status": 200 });
    socket.on("error", () => st.destroy());
    st.on("error", () => socket.destroy());
    st.once("close", () => socket.destroy());
    endWhenDone(socket, st);
    socket.pipe(st, { end: false });
    st.pipe(socket);
  };

  return function handle(st: ServerHttp2Stream, headers: IncomingHttpHeaders): void {
    st.on("error", () => {});
    const method = String(headers[h2c.HTTP2_HEADER_METHOD] ?? "");
    let url: URL;
    try {
      url = new URL(String(headers[h2c.HTTP2_HEADER_PATH] ?? "/"), "http://link");
    } catch {
      return json(st, 400, { error: "that path is not a path" });
    }
    const failed = (e: unknown) => json(st, e instanceof RouteRefusal || isClientError(e) ? 400 : 502, { error: reason(e) });
    switch (`${method} ${url.pathname}`) {
      case "GET /v1/info":
        return json(st, 200, info());
      case "GET /v1/host":
        return void readHost(deps.diskPath).then((h) => json(st, 200, h), failed);
      case "POST /v1/docker":
        st.respond({ ":status": 200 });
        return deps.gate.handle(st);
      case "POST /v1/dial":
        return void handleDial(st, headers).catch(failed);
      case "GET /v1/routes":
      case "POST /v1/routes":
        return void handleRoutes(st, method, url.searchParams).catch(failed);
      case "POST /v1/build":
        return void handleBuild(st);
      case "POST /v1/build/detect":
        return void handleDetect(st);
      case "POST /v1/build/cache":
        return void handleCache(st).catch(failed);
      default:
        return json(st, 404, { error: "no such call" });
    }
  };
}

const isClientError = (e: unknown) => (e as { name?: string }).name === "ZodError" || e instanceof SyntaxError;

function withoutUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** Everything under the build root is a build that died with the last agent. */
export async function sweepBuildRoot(root: string): Promise<number> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const names = await readdir(root);
  await Promise.all(names.map((n) => rm(join(root, n), { recursive: true, force: true, maxRetries: 3 }).catch(() => {})));
  return names.length;
}
