/** A ServerRuntime over the link. Every answer is parsed, because a node's answers are hostile input. */
import { relative } from "node:path";
import { constants as h2c } from "node:http2";
import type { Duplex } from "node:stream";
import { link as L } from "@dockify/contracts";
import { DockerClient, packContext, PermanentDeployError, type Builder, type BuildInput, type BuildLog, type BuildResult, type BuildVar, type Dialer, type DialTarget, type HostReading, type PlanInfo, type PlanInput, type RouteChange, type RouteStore } from "@dockify/engine";
import type { EdgeMode } from "../edge/ingress.ts";
import type { ServerRuntime } from "../server/runtime.ts";
import { AgentRefusal, LinkDownError, type ServerLink } from "./session.ts";

const DIAL_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONTEXT = L.LINK_LIMITS.contextBytesDefault;
/** A build's last line holds Railpack's plan, whose schema allows 4 MiB. */
const MAX_ANSWER_LINE = 8 * 1024 * 1024;

const dialer = (link: ServerLink): Dialer => (target: DialTarget, opts = {}) =>
  new Promise<Duplex>((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? DIAL_TIMEOUT_MS;
    const st = link.current.stream("/v1/dial", { "x-dial": JSON.stringify({ ...target, timeoutMs }) });
    let settled = false;
    const fail = (e: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      st.destroy();
      reject(e);
    };
    // The agent's own limit fires first, with its reason; this one covers a link that went quiet.
    const timer = setTimeout(() => fail(Object.assign(new Error(`the dial to ${JSON.stringify(target)} did not answer`), { code: "ETIMEDOUT" })), timeoutMs + 5_000);
    const onAbort = () => fail(new Error("the dial was cancelled"));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    st.on("error", () => fail(new LinkDownError("the link dropped during a dial")));
    st.once("close", () => fail(new LinkDownError("the link dropped during a dial")));
    st.once("response", (h) => {
      const status = Number(h[h2c.HTTP2_HEADER_STATUS]);
      if (status === 200) {
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        return resolve(st);
      }
      let text = "";
      st.setEncoding("utf8");
      st.on("data", (c: string) => {
        if (text.length < 4_096) text += c;
      });
      st.once("end", () => {
        let reason = text;
        try {
          reason = String((JSON.parse(text) as { error?: unknown }).error ?? text);
        } catch {
        }
        fail(status >= 400 && status < 500 ? new AgentRefusal(reason.slice(0, 1_000)) : new Error(reason.slice(0, 1_000) || `the agent answered ${status} to a dial`));
      });
    });
  });

const routeStore = (link: ServerLink): RouteStore => ({
  read: async (name) => (await link.current.call<{ content: unknown }>("GET", `/v1/routes?name=${encodeURIComponent(name)}`)).content as string | null,
  snapshot: async () => (await link.current.call<{ files: Record<string, string> }>("GET", "/v1/routes")).files,
  apply: async (change: RouteChange) => {
    await link.current.call("POST", "/v1/routes", change);
  },
});

async function readAnswer(st: AsyncIterable<unknown>, log: { line(l: Extract<L.BuildLine, { t: "system" | "stdout" | "stderr" }>): void }): Promise<unknown> {
  let partial = "";
  for await (const chunk of st) {
    partial += (chunk as Buffer).toString("utf8");
    if (partial.length > MAX_ANSWER_LINE && !partial.includes("\n")) throw new Error("the agent sent a line too long to be real");
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    for (const raw of lines) {
      if (!raw) continue;
      const parsed = L.BuildLine.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new Error("the agent sent a line this worker cannot read");
      const line = parsed.data;
      if (line.t === "end") return line.result;
      if (line.t === "error") throw line.permanent ? new PermanentDeployError(line.m) : new Error(line.m);
      log.line(line);
    }
  }
  throw new LinkDownError("the link dropped during a build");
}

/** First line, then the context's tar, then the answer. A cancel ends the stream, which ends the build. */
async function sendContext(link: ServerLink, path: string, first: unknown, root: string, signal: AbortSignal, onLine: (l: Extract<L.BuildLine, { t: "system" | "stdout" | "stderr" }>) => void): Promise<unknown> {
  signal.throwIfAborted();
  const st = link.current.stream(path);
  const onAbort = () => st.destroy(new Error("the build was stopped"));
  signal.addEventListener("abort", onAbort, { once: true });
  let lost: Error | null = null;
  st.on("error", (e: Error) => {
    lost ??= e;
  });
  try {
    await new Promise<void>((resolve, reject) => st.write(`${JSON.stringify(first)}\n`, (e) => (e ? reject(e) : resolve())));
    const pack = packContext(root);
    pack.on("error", (e: Error) => st.destroy(e));
    pack.pipe(st);
    return await readAnswer(st, { line: onLine });
  } catch (e) {
    signal.throwIfAborted();
    if (e instanceof PermanentDeployError || e instanceof LinkDownError) throw e;
    if (lost) throw new LinkDownError(`the link dropped during a build: ${(lost as Error).message}`);
    throw e;
  } finally {
    signal.removeEventListener("abort", onAbort);
    st.destroy();
  }
}

/** Exactly what the agent's schema takes: a resolved variable also says where it came from. */
const varsOut = (vars: readonly BuildVar[]) => vars.map(({ key, value, isSecret, target }) => ({ key, value, isSecret, target }));

function builder(link: ServerLink, maxContextBytes: number): Builder {
  const cache = async (req: L.CacheRequest, timeoutMs?: number): Promise<string> =>
    (await link.current.call<{ output: string }>("POST", "/v1/build/cache", req, { timeoutMs: (timeoutMs ?? 10 * 60_000) + 5_000 })).output;
  return {
    async build(input: BuildInput, log: BuildLog, signal: AbortSignal): Promise<BuildResult> {
      if (!input.checkoutRoot) throw new Error("a build needs the checkout's root folder");
      // The same values leave this process in the first line, and every line coming back is redacted here too.
      log.redactor.conceal(input.vars.filter((v) => v.isSecret).map((v) => v.value));
      const { checkoutDir, checkoutRoot, ...rest } = input;
      const first = { ...rest, vars: varsOut(input.vars), repoDir: relative(checkoutRoot, checkoutDir).replaceAll("\\", "/"), maxBytes: maxContextBytes };
      const result = await sendContext(link, "/v1/build", first, checkoutRoot, signal, (l) => {
        if (l.t === "system") log.system(l.m);
        else log.add(l.t, l.m);
      });
      return L.BuildResultBody.parse(result) as BuildResult;
    },
    async plan(input: PlanInput, onLine, signal): Promise<PlanInfo> {
      const first = {
        repoDir: relative(input.checkoutRoot, input.checkoutDir).replaceAll("\\", "/"),
        rootDir: input.rootDir,
        vars: varsOut(input.vars),
        overrides: input.overrides,
        timeoutMs: input.timeoutMs,
        maxBytes: maxContextBytes,
      };
      const result = await sendContext(link, "/v1/build/detect", first, input.checkoutRoot, signal, (l) => {
        onLine(l.m);
      });
      return L.PlanBody.parse(result) as unknown as PlanInfo;
    },
    cacheUsage: (timeoutMs) => cache({ op: "du", timeoutMs }, timeoutMs),
    pruneCache: (timeoutMs) => cache({ op: "prune", timeoutMs }, timeoutMs),
    pruneCacheScope: (scope, timeoutMs) => cache({ op: "pruneScope", scope, timeoutMs }, timeoutMs),
    trimCache: (keepBytes) => cache({ op: "trim", keepBytes }),
  };
}

export function createRemoteRuntime(o: { link: ServerLink; mode: EdgeMode; cpuCores: number; maxContextBytes?: number }): ServerRuntime {
  const { link } = o;
  return {
    serverId: link.serverId,
    // Each call is one stream; no agent, so node:http uses createConnection as it is.
    docker: new DockerClient({ createConnection: () => link.current.stream("/v1/docker") }, { cpuCores: o.cpuCores }),
    routes: routeStore(link),
    host: async () => L.HostAnswer.parse(await link.current.call("GET", "/v1/host")) as HostReading,
    dial: dialer(link),
    builder: builder(link, o.maxContextBytes ?? DEFAULT_MAX_CONTEXT),
    mode: o.mode,
    cpuCores: o.cpuCores,
  };
}

export async function readAgentInfo(link: ServerLink): Promise<L.AgentInfo> {
  return L.AgentInfo.parse(await link.current.call("GET", "/v1/info"));
}
