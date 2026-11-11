/**
 * The data module's DockerPort over the worker's Docker Engine client (behind the socket proxy).
 * Simple calls reuse DockerClient; exec and attach hijack the connection for a raw duplex stream,
 * demultiplex it, and report the exit code only once Docker says the process stopped running.
 */
import { request, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { PassThrough, type Writable } from "node:stream";
import { assertSafeSpec, type ContainerSpec } from "@dockify/engine";
import { Demuxer, DockerError, isNotFound, type DockerClient, type Endpoint } from "@dockify/engine";
import type { ContainerListing, ContainerState, DockerPort, ExecHandle, ExecResult, ImageState } from "./docker-port.ts";

const API = "/v1.43";
const STDERR_TAIL = 4 * 1024;
const EXEC_POLL_MS = 200;
/** What a killed exec reports when its process has not exited: the code of a SIGKILL. */
const KILLED_EXIT = 137;
/** A managed service image is a few tens of MB; a pull that runs this long is stuck. */
const PULL_TIMEOUT_MS = 15 * 60_000;

/** Keeps the last `cap` bytes of stderr for an error message. */
export class Tail {
  private buf = Buffer.alloc(0);
  private readonly cap: number;
  constructor(cap = STDERR_TAIL) {
    this.cap = cap;
  }
  push(b: Buffer): void {
    this.buf = Buffer.concat([this.buf, b]);
    if (this.buf.length > this.cap) this.buf = this.buf.subarray(this.buf.length - this.cap);
  }
  text(): string {
    return this.buf.toString("utf8");
  }
}

/** Splits a hijacked multiplexed stream into a stdout stream and a bounded stderr tail. */
export function wireDemux(source: NodeJS.ReadableStream, head: Buffer | null): { stdout: PassThrough; stderr: Tail; ended: Promise<void> } {
  const stdout = new PassThrough();
  const stderr = new Tail();
  const demux = new Demuxer();
  let waiting = false;
  const emit = (stream: "stdout" | "stderr", data: Buffer) => {
    if (stream === "stderr") return stderr.push(data);
    // A reader that is gone takes nothing; a full one pauses the source, so a dump is never held
    // in memory faster than it is written out.
    if (stdout.destroyed || stdout.write(data) || waiting) return;
    waiting = true;
    source.pause();
    stdout.once("drain", () => {
      waiting = false;
      source.resume();
    });
  };
  // A reader destroyed while the source is paused would leave it paused for good.
  stdout.once("close", () => source.resume());
  if (head?.length) demux.push(head, emit);
  const ended = new Promise<void>((resolve) => {
    source.on("data", (c: Buffer) => demux.push(c, emit));
    source.on("end", () => resolve());
    source.on("close", () => resolve());
    source.on("error", (e: Error) => {
      stdout.destroy(e);
      resolve();
    });
  });
  void ended.then(() => stdout.end());
  return { stdout, stderr, ended };
}

interface InspectLike {
  Id: string;
  State: { Running: boolean; Health?: { Status: string } };
  Config: { Labels: Record<string, string> | null; Env?: string[] | null };
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
  Mounts?: Array<{ Type?: string; Name?: string; Destination?: string }> | null;
}

export function toState(info: InspectLike): ContainerState {
  const h = info.State.Health?.Status;
  const addresses: Record<string, string> = {};
  for (const [net, v] of Object.entries(info.NetworkSettings.Networks ?? {})) if (v.IPAddress) addresses[net] = v.IPAddress;
  return {
    id: info.Id,
    running: info.State.Running,
    health: h === "healthy" || h === "unhealthy" || h === "starting" ? h : "none",
    labels: info.Config.Labels ?? {},
    addresses,
    ...(info.Mounts ? { mounts: info.Mounts.map((m) => ({ type: m.Type ?? "", name: m.Name || null, destination: m.Destination ?? "" })) } : {}),
    ...(info.Config.Env ? { env: info.Config.Env } : {}),
  };
}

type Hijacked = { socket: Socket | IncomingMessage; head: Buffer | null; writable: boolean };

/** POST with Upgrade: tcp; resolves the raw duplex (or the plain response on an old engine). */
export function hijackDocker(target: Endpoint, path: string, body: unknown): Promise<Hijacked> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body ?? {}));
    const req = request({
      ...target,
      method: "POST",
      path: `${API}${path}`,
      headers: { "Content-Type": "application/json", "Content-Length": payload.length, Connection: "Upgrade", Upgrade: "tcp" },
    });
    req.on("upgrade", (_res, socket, head) => resolve({ socket, head, writable: true }));
    req.on("response", (res) => {
      if ((res.statusCode ?? 500) >= 400) {
        let text = "";
        res.on("data", (c: Buffer) => {
          if (text.length < 500) text += c.toString("utf8");
        });
        res.on("end", () => reject(new DockerError(res.statusCode ?? 500, text.slice(0, 500) || "hijack refused")));
        return;
      }
      resolve({ socket: res, head: null, writable: false });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

export class EngineDataPort implements DockerPort {
  private readonly client: DockerClient;
  constructor(client: DockerClient) {
    this.client = client;
  }

  get cpuCores() {
    return this.client.cpuCores;
  }

  private hijack(path: string, body: unknown): Promise<Hijacked> {
    return hijackDocker(this.client.target, path, body);
  }

  ensureNetwork(name: string, labels: Record<string, string>, opts?: { internal?: boolean }) {
    return this.client.ensureNetwork(name, labels, opts);
  }
  ensureVolume(name: string, labels: Record<string, string>) {
    return this.client.ensureVolume(name, labels);
  }
  async removeVolume(name: string) {
    await this.client.removeVolume(name);
  }
  async createContainer(name: string, spec: ContainerSpec): Promise<string> {
    // The body sent is exactly the one checked.
    assertSafeSpec(spec);
    const out = await this.client.call<{ Id: string }>("POST", `/containers/create?name=${encodeURIComponent(name)}`, spec);
    return out.Id;
  }
  start(id: string) {
    return this.client.startContainer(id);
  }
  stop(id: string, timeoutSeconds: number) {
    return this.client.stopContainer(id, timeoutSeconds);
  }
  remove(id: string, opts?: { volumes?: boolean }) {
    return this.client.removeContainer(id, opts);
  }
  async inspect(idOrName: string): Promise<ContainerState | null> {
    try {
      return toState(await this.client.inspectContainer(idOrName));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
  async list(labels: Record<string, string>): Promise<ContainerListing[]> {
    const rows = await this.client.listContainers(labels);
    return rows.map((c) => ({ id: c.Id, names: c.Names.map((n) => n.replace(/^\//, "")), running: c.State === "running", labels: c.Labels ?? {} }));
  }
  rename(name: string, newName: string) {
    return this.client.renameContainer(name, newName);
  }
  async inspectImage(ref: string): Promise<ImageState | null> {
    try {
      const info = await this.client.inspectImage(ref);
      return { id: info.Id, repoDigests: info.RepoDigests ?? [] };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
  async pullImage(ref: string, onLine: (text: string) => void = () => {}): Promise<void> {
    await this.client.pullImage(ref, null, onLine, AbortSignal.timeout(PULL_TIMEOUT_MS));
  }

  async exec(id: string, opts: { cmd: string[]; env?: Record<string, string>; stdin?: boolean; user?: string }): Promise<ExecHandle> {
    const created = await this.client.call<{ Id: string }>("POST", `/containers/${encodeURIComponent(id)}/exec`, {
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: !!opts.stdin,
      Tty: false,
      Cmd: opts.cmd,
      // Values go in the exec environment, never on the command line.
      Env: Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
      ...(opts.user ? { User: opts.user } : {}),
    });
    const execId = encodeURIComponent(created.Id);
    const h = await this.hijack(`/exec/${execId}/start`, { Detach: false, Tty: false });
    const io = wireDemux(h.socket, h.head);
    let killed = false;
    const done = (async (): Promise<ExecResult> => {
      await io.ended;
      for (;;) {
        const s = await this.client.call<{ Running: boolean; ExitCode: number | null }>("GET", `/exec/${execId}/json`);
        if (!s.Running && s.ExitCode !== null) return { exitCode: s.ExitCode, stderr: io.stderr.text() };
        // Docker leaves the process running when its stream closes (it ends at its next read or
        // write), so a killed exec is not waited for: one blocked on a lock would never report.
        if (killed) return { exitCode: KILLED_EXIT, stderr: io.stderr.text() };
        await new Promise((r) => setTimeout(r, EXEC_POLL_MS));
      }
    })();
    // Every caller awaits it; this only keeps a failure after a caller gave up from being unhandled.
    done.catch(() => {});
    return {
      stdout: io.stdout,
      stdin: opts.stdin && h.writable ? (h.socket as Socket as Writable) : null,
      done,
      kill: async () => {
        killed = true;
        h.socket.destroy();
      },
    };
  }

  async attach(id: string, opts: { stdin?: boolean }): Promise<ExecHandle> {
    const cid = encodeURIComponent(id);
    const h = await this.hijack(`/containers/${cid}/attach?stream=1&stdout=1&stderr=1&stdin=${opts.stdin ? 1 : 0}`, {});
    const io = wireDemux(h.socket, h.head);
    const done = (async (): Promise<ExecResult> => {
      await io.ended;
      const r = await this.client.call<{ StatusCode: number }>("POST", `/containers/${cid}/wait`);
      return { exitCode: r.StatusCode, stderr: io.stderr.text() };
    })();
    return {
      stdout: io.stdout,
      stdin: opts.stdin && h.writable ? (h.socket as Socket as Writable) : null,
      done,
      kill: async () => {
        await this.client.call("POST", `/containers/${cid}/kill`, undefined, true).catch(() => {});
        h.socket.destroy();
      },
    };
  }
}
