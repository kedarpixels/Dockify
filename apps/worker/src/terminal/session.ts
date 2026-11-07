/**
 * The worker's half of the web terminal: one interactive process inside one tenant container.
 *
 * What makes it safe to expose, in the order it runs:
 *   1. The target is never a name from the caller. The caller sends an app id, which must be a uuid
 *      with a row in the database, and the container name is derived from it: dk-<app id>.
 *   2. assertTerminalTarget checks what Docker reports about that container (below). Its labels are
 *      not ones an image can forge: containerSpec() writes every key an image could use to claim
 *      them into the create body, blank unless Dockify set it, and a key in the body beats the image's.
 *   3. An exec is inert until started. Docker's answer to "what does this exec run in" is compared with
 *      the id checked in step 2, so a swap or a rename between the two steps refuses instead of
 *      landing somewhere else. The socket proxy allows exec on dk- names only.
 *   4. The command is the constant SHELL_COMMAND, with no User and no Privileged key: the process is
 *      the container's own configured user with the container's own capabilities. Docker reports that
 *      inherited user on the exec, so step 3 also holds it to the container's own.
 *   5. Bytes pass through. Nothing here reads, logs or stores them, apart from removing the one marker
 *      our own command prints first.
 *
 * Docker has no call that ends an exec, and closing a TTY exec's stream leaves its process running, so
 * every close signals the shell by the pid it reported, and asks Docker whether that exec is still
 * running before each signal, so the signal can never reach a process that reused the number.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { safeEqual } from "@dockify/crypto";
import { terminal as T } from "@dockify/contracts";
import type { Db } from "@dockify/db";
import type { ContainerInfo } from "@dockify/engine";
import { canonicalName, LABEL } from "../deploy/containers.ts";

const { encodeFrame, FRAME, FrameDecoder, TERMINAL, TerminalResizeMessage } = T;

export interface ExecInfo {
  ID?: string;
  ContainerID: string;
  Running: boolean;
  ExitCode: number | null;
  Privileged?: boolean;
  ProcessConfig?: { privileged?: boolean; user?: string; tty?: boolean };
}

export interface ExecBody {
  AttachStdin: boolean;
  AttachStdout: boolean;
  AttachStderr: boolean;
  Tty: boolean;
  Cmd: string[];
  Env?: string[];
  ConsoleSize?: [number, number];
}

/** What the terminal needs from the daemon, and nothing else. Tests pass a fake. */
export interface TerminalDocker {
  inspect(name: string): Promise<ContainerInfo | null>;
  createExec(name: string, body: ExecBody): Promise<string>;
  inspectExec(id: string): Promise<ExecInfo>;
  attachExec(id: string): Promise<{ stream: Duplex; head: Buffer }>;
  startDetached(id: string): Promise<void>;
  resizeExec(id: string, cols: number, rows: number): Promise<void>;
}

/** Why a terminal cannot open. `http` is what the api is told; the message never leaves the worker. */
export class TerminalRefused extends Error {
  readonly http: number;
  readonly code: "disabled" | "not_found" | "not_running" | "refused";
  constructor(http: number, code: TerminalRefused["code"], message: string) {
    super(message);
    this.name = "TerminalRefused";
    this.http = http;
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const SHELL_PID = /^[1-9][0-9]{0,9}$/;
/** An app container, or a managed service (data/services.ts). A release one-off, helper or preview is neither. */
const ROLE = /^(?:app|service-[a-z0-9]+)$/;
/** Set by Compose on a control-plane container, blank on every tenant container. */
const COMPOSE_LABELS = ["com.docker.compose.project", "com.docker.compose.service", "com.docker.compose.oneoff", "com.docker.compose.container-number"];
const PREVIEW_LABELS = ["dockify.preview", "dockify.preview.app"];

const refuse = (why: string): never => {
  throw new TerminalRefused(403, "refused", why);
};

/**
 * Pure: is this exactly the running tenant container of this app? Returns its id, the one thing later
 * steps compare against. Every check names something Docker reports, not something a caller claimed.
 *
 * Why a spoofed label cannot pass, against each way of getting one:
 *   LABEL in the image       containerSpec() puts dockify.app, dockify.environment, dockify.role, the
 *                            preview keys and the Compose keys in every create body; Docker merges an
 *                            image's labels only under keys the body did not set.
 *   Another tenant's image   claims dockify.app=<victim>: its body sets dockify.app to its own id, and
 *                            the name below is the victim's, which only the victim's deploy can hold.
 *   A preview of the victim  has a dk-pv- name, a blank dockify.app and preview labels.
 *   A parked or one-off copy has a longer name (dk-<id>-prev-..., dk-<id>-release-...).
 *   A control container      has no dk- name, and the proxy lets nothing rename one into it; a
 *                            hand-made impostor still fails the Compose check.
 */
export function assertTerminalTarget(info: ContainerInfo, app: { id: string; environmentId: string }): string {
  const labels = info.Config?.Labels ?? {};
  if (!CONTAINER_ID.test(info.Id ?? "")) refuse("the daemon reported no container id");
  if (info.Name !== `/${canonicalName(app.id)}`) refuse("the container is not the app's own");
  if (labels["dockify.managed"] !== "true") refuse("the container is not managed by Dockify");
  if (labels[LABEL.app] !== app.id) refuse("the container belongs to another app");
  if (labels[LABEL.environment] !== app.environmentId) refuse("the container belongs to another environment");
  if (!ROLE.test(labels[LABEL.role] ?? "")) refuse("the container is not an app or a service");
  for (const k of COMPOSE_LABELS) if (labels[k]) refuse("the container claims to be a Compose service");
  for (const k of PREVIEW_LABELS) if (labels[k]) refuse("the container belongs to a preview");
  const host = info.HostConfig ?? refuse("the daemon reported no host config");
  if (host.Privileged) refuse("the container is privileged");
  if (!/^dockify[-_]/.test(host.NetworkMode ?? "")) refuse("the container is not on a Dockify network");
  for (const mode of [host.PidMode, host.UTSMode, host.UsernsMode]) if (mode) refuse("the container shares a host namespace");
  if (host.IpcMode && host.IpcMode !== "private" && host.IpcMode !== "none") refuse("the container shares a host namespace");
  if (!info.State?.Running || info.State.Restarting || info.State.Paused) throw new TerminalRefused(409, "not_running", "the container is not running");
  return info.Id;
}

/**
 * Pure: Docker's account of an exec must name the checked container, with no added privilege and no
 * user but the container's own: an exec with no User reports the image's USER here (Docker 29 does).
 */
export function assertExecBound(exec: ExecInfo, containerId: string, containerUser: string | undefined): void {
  if (exec.ContainerID !== containerId) refuse("the exec landed in another container");
  if (exec.Privileged || exec.ProcessConfig?.privileged) refuse("the exec is privileged");
  if ((exec.ProcessConfig?.user ?? "") !== (containerUser ?? "")) refuse("the exec names another user");
}

const MARK = "\x1edockify-pid:";
const MARK_END = "\x1e";
/**
 * A constant: nothing from a request or a repository is ever part of it. It reports its own pid, then
 * becomes bash if the image has it, else sh. `exec` keeps the pid. A hostile image's sh can print any
 * number it likes, and the only effect is a signal inside its own container as its own user.
 */
export const SHELL_COMMAND: readonly string[] = ["/bin/sh", "-c", String.raw`printf '\036dockify-pid:%s\036' "$$"; if command -v bash >/dev/null 2>&1; then exec bash; fi; exec sh`];

/** Exit codes of a command that could not start: not found, and found but not runnable. */
const NO_SHELL_EXIT = new Set([126, 127]);

/** The first bytes of a session, until the marker has gone by. Holds at most MARK_LIMIT bytes back. */
const MARK_LIMIT = 256;
export class PidFilter {
  pid: string | null = null;
  private held: Buffer | null = Buffer.alloc(0);

  /** Bytes to pass on, possibly none. */
  push(chunk: Buffer): Buffer {
    if (this.held === null) return chunk;
    const all = Buffer.concat([this.held, chunk]);
    const start = all.indexOf(MARK);
    const end = start >= 0 ? all.indexOf(MARK_END, start + MARK.length) : -1;
    if (start >= 0 && end >= 0) {
      const pid = all.subarray(start + MARK.length, end).toString("latin1");
      this.pid = SHELL_PID.test(pid) ? pid : null;
      this.held = null;
      return Buffer.concat([all.subarray(0, start), all.subarray(end + 1)]);
    }
    if (all.length > MARK_LIMIT) {
      this.held = null;
      return all;
    }
    this.held = all;
    return Buffer.alloc(0);
  }

  /** Gives up on the marker: whatever was held goes out as it came. */
  flush(): Buffer {
    const out = this.held ?? Buffer.alloc(0);
    this.held = null;
    return out;
  }
}

export interface OpenedExec {
  execId: string;
  containerId: string;
  name: string;
  stream: Duplex;
  head: Buffer;
}

/** A verified exec for the app, not started until every check has passed. */
export async function openExec(deps: { db: Db; docker: TerminalDocker }, appId: string, size: { cols: number; rows: number }): Promise<OpenedExec> {
  if (!UUID.test(appId)) throw new TerminalRefused(400, "refused", "not an app id");
  const instance = await deps.db.instance.findUnique({ where: { id: 1 }, select: { terminalEnabled: true } });
  if (!instance?.terminalEnabled) throw new TerminalRefused(403, "disabled", "the terminal is turned off");
  const app = await deps.db.app.findUnique({ where: { id: appId }, select: { id: true, environmentId: true } });
  if (!app) throw new TerminalRefused(404, "not_found", "no such app");
  const name = canonicalName(app.id);
  const info = await deps.docker.inspect(name);
  if (!info) throw new TerminalRefused(409, "not_running", "the app has no container");
  const containerId = assertTerminalTarget(info, app);
  const execId = await deps.docker.createExec(name, {
    AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true,
    Cmd: [...SHELL_COMMAND], Env: ["TERM=xterm-256color"], ConsoleSize: [size.rows, size.cols],
  });
  assertExecBound(await deps.docker.inspectExec(execId), containerId, info.Config.User);
  const { stream, head } = await deps.docker.attachExec(execId);
  return { execId, containerId, name, stream, head };
}

/**
 * The hangup. A TTY exec's shell leads its own session, and busybox ash, unlike bash, does not pass a
 * hangup on to its background jobs, so `sleep 9999 &` outlived the tab on every Alpine image. This
 * hangs up the whole session by reading /proc, in plain sh because a slim image has no pkill. `nohup`
 * still survives, as the docs say. Constant: only the checked pid arrives, as $0.
 */
export const HANGUP_SCRIPT = 'kill -HUP "$0"; for d in /proc/[0-9]*; do read -r l < "$d/stat" 2>/dev/null || continue; l="${l##*) }"; set -- $l; [ "$4" = "$0" ] && kill -HUP "${d##*/}" 2>/dev/null; done; exit 0';

/** Runs one signal inside the container, through the same checks. No stream, no input, nothing read back. */
async function signalShell(docker: TerminalDocker, exec: Pick<OpenedExec, "execId" | "containerId" | "name">, pid: string, signal: "HUP" | "KILL"): Promise<void> {
  const state = await docker.inspectExec(exec.execId);
  if (!state.Running || !SHELL_PID.test(pid)) return;
  const current = await docker.inspect(exec.name);
  if (current?.Id !== exec.containerId) return;
  const script = signal === "HUP" ? HANGUP_SCRIPT : `kill -${signal} "$0"`;
  const id = await docker.createExec(exec.name, { AttachStdin: false, AttachStdout: false, AttachStderr: false, Tty: false, Cmd: ["/bin/sh", "-c", script, pid] });
  assertExecBound(await docker.inspectExec(id), exec.containerId, current.Config.User);
  await docker.startDetached(id);
}

export interface ChannelTerminalDeps {
  db: Db;
  docker: TerminalDocker;
  token: string;
  log?: (msg: string, extra?: object) => void;
  /** How long a shell has to go after a hangup; tests shorten it. */
  hangupMs?: number;
  /** How long a close waits for the shell's pid when it has not printed it yet. */
  markerWaitMs?: number;
  totalMs?: number;
}

const REQUEST = /^\/terminal\/([0-9a-f-]{36})\?cols=(\d{1,3})&rows=(\d{1,3})$/;

function answer(socket: Duplex, status: number, code: string): void {
  const body = JSON.stringify({ code });
  socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

/**
 * Serves terminals on the worker's control-network channel, next to the data browser. Returns the way
 * to end them all when the worker stops, which a server's close would otherwise wait on for good.
 */
export function attachTerminalChannel(server: Server, deps: ChannelTerminalDeps): { closeAll(): Promise<void>; count(appId?: string): number } {
  const live = new Map<Duplex, { appId: string; close(): Promise<void> }>();
  const countFor = (appId?: string) => (appId ? [...live.values()].filter((s) => s.appId === appId).length : live.size);

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || !deps.token || !safeEqual(auth.slice(7), deps.token)) return answer(socket, 401, "unauthenticated");
    const m = REQUEST.exec(req.url ?? "");
    const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
    if (req.method !== "GET" || !m || upgrade !== "dockify-terminal") return answer(socket, 404, "not_found");
    const size = TerminalResizeMessage.safeParse({ t: "resize", cols: Number(m[2]), rows: Number(m[3]) });
    if (!size.success) return answer(socket, 400, "bad_size");
    const appId = m[1]!;
    if (countFor() >= TERMINAL.workerMaxTotal || countFor(appId) >= TERMINAL.workerMaxPerApp) return answer(socket, 429, "too_many");
    // Held from here, so a burst of requests cannot pass the ceiling while each one awaits the daemon.
    live.set(socket, { appId, close: async () => void socket.destroy() });
    void (async () => {
      let exec: OpenedExec;
      try {
        exec = await openExec(deps, appId, size.data);
      } catch (e) {
        live.delete(socket);
        if (e instanceof TerminalRefused) {
          deps.log?.("terminal refused", { appId, reason: e.message });
          return answer(socket, e.http, e.code);
        }
        deps.log?.("terminal failed to open", { appId, error: e instanceof Error ? e.message.slice(0, 300) : "unknown" });
        return answer(socket, 502, "failed");
      }
      // Attaching has already started the shell, so a browser that left meanwhile must still end it. It may
      // show only as an end already read: this server's sockets stay half open.
      if (socket.destroyed || socket.readableEnded) {
        void pump(deps, socket, head, exec, () => live.delete(socket))();
        return;
      }
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dockify-terminal\r\n\r\n");
      live.set(socket, { appId, close: pump(deps, socket, head, exec, () => live.delete(socket)) });
    })();
  };
  server.on("upgrade", onUpgrade);

  return {
    count: countFor,
    async closeAll() {
      server.off("upgrade", onUpgrade);
      await Promise.all([...live.values()].map((s) => s.close().catch(() => {})));
    },
  };
}

/** Moves bytes both ways until either side ends, then makes sure the shell ends too. Returns the way to close it. */
function pump(deps: ChannelTerminalDeps, socket: Duplex, head: Buffer, exec: OpenedExec, onDone: () => void): () => Promise<void> {
  const { docker } = deps;
  const decoder = new FrameDecoder();
  const filter = new PidFilter();
  let ended = false;
  let closing: Promise<void> | null = null;

  const send = (chunk: Buffer) => {
    if (!chunk.length || socket.destroyed) return;
    if (!socket.write(encodeFrame(FRAME.data, chunk))) {
      exec.stream.pause();
      socket.once("drain", () => exec.stream.resume());
    }
  };
  const markerTimer = setTimeout(() => send(filter.flush()), 2_000);
  markerTimer.unref();

  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      clearTimeout(markerTimer);
      clearTimeout(deadline);
      onDone();
      socket.destroy();
      // The shell prints its pid first thing: a close before that waits for it, or it could not be signalled.
      const wait = deps.markerWaitMs ?? 2_000;
      for (const start = Date.now(); !ended && !filter.pid && Date.now() - start < wait;) await new Promise((r) => setTimeout(r, 25));
      const pid = filter.pid;
      if (!ended && pid) {
        await signalShell(docker, exec, pid, "HUP").catch((e: unknown) => deps.log?.("terminal hangup failed", { error: e instanceof Error ? e.message.slice(0, 200) : "unknown" }));
        await new Promise((r) => setTimeout(r, deps.hangupMs ?? 2_000));
        await signalShell(docker, exec, pid, "KILL").catch(() => {});
      }
      exec.stream.destroy();
    })();
    return closing;
  };
  const deadline = setTimeout(() => void close(), deps.totalMs ?? TERMINAL.workerTotalMs);
  deadline.unref();

  const finish = async () => {
    if (ended || closing) return;
    ended = true;
    clearTimeout(markerTimer);
    const state = await docker.inspectExec(exec.execId).catch(() => null);
    const code = state?.ExitCode ?? null;
    const reason = filter.pid === null && code !== null && NO_SHELL_EXIT.has(code) ? "no_shell" : "exited";
    // What a shell that never started left behind is the runtime's own error, not the app's output.
    if (reason === "exited") send(filter.flush());
    if (!socket.destroyed) socket.end(encodeFrame(FRAME.end, JSON.stringify({ reason, exitCode: code })));
    void close();
  };

  const onFrame = (type: number, payload: Buffer) => {
    if (type === FRAME.data) {
      if (!exec.stream.write(payload)) {
        socket.pause();
        exec.stream.once("drain", () => socket.resume());
      }
    } else if (type === FRAME.resize) {
      let parsed: ReturnType<typeof TerminalResizeMessage.safeParse> | null = null;
      try {
        parsed = TerminalResizeMessage.safeParse(JSON.parse(payload.toString("utf8")));
      } catch {
        // A frame that is not JSON is a protocol error, handled the same as one that fails the schema.
      }
      if (!parsed?.success) return void close();
      void docker.resizeExec(exec.execId, parsed.data.cols, parsed.data.rows).catch(() => {});
    } else {
      void close();
    }
  };

  const feed = (chunk: Buffer) => {
    try {
      decoder.push(chunk, onFrame);
    } catch {
      void close();
    }
  };

  socket.on("data", feed);
  // An http server's sockets stay half open, so the far side leaving shows up as "end" and never as "close".
  socket.on("end", () => void close());
  socket.on("close", () => void close());
  socket.on("error", () => void close());
  exec.stream.on("data", (c: Buffer) => send(filter.push(c)));
  exec.stream.on("end", () => void finish());
  exec.stream.on("close", () => void finish());
  exec.stream.on("error", () => void finish());
  if (exec.head.length) send(filter.push(exec.head));
  if (head.length) feed(head);
  return close;
}
