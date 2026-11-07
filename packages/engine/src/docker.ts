/**
 * A small Docker Engine API client over node:http. It talks to the socket proxy (DOCKER_HOST
 * tcp://...) in production or a unix socket in development, and exposes only the calls the deploy
 * engine makes. Every container create goes through containerSpec() and assertSafeSpec() first.
 */
import { createHash } from "node:crypto";
import { request, type IncomingMessage } from "node:http";
import type { Duplex, Readable } from "node:stream";
import { assertSafeSpec, containerSpec, type ContainerInput } from "./container-spec.ts";

export class DockerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DockerError";
    this.status = status;
  }
}

export const isNotFound = (e: unknown) => e instanceof DockerError && e.status === 404;
export const isNotModified = (e: unknown) => e instanceof DockerError && e.status === 304;
export const isConflict = (e: unknown) => e instanceof DockerError && e.status === 409;

export interface ContainerState {
  Status: string;
  Running: boolean;
  Restarting: boolean;
  Paused?: boolean;
  /** ISO time; year 1 for a container that never started. */
  StartedAt?: string;
  ExitCode: number;
  Error?: string;
  Health?: { Status: string; Log?: Array<{ Output?: string }> };
}

export interface ContainerInfo {
  Id: string;
  Name: string;
  Image: string;
  RestartCount: number;
  State: ContainerState;
  Config: { Labels: Record<string, string> | null; Env?: string[] | null; User?: string };
  /** The namespaces and privileges the container really runs with; the terminal checks these. */
  HostConfig?: { Privileged?: boolean; NetworkMode?: string; PidMode?: string; IpcMode?: string; UTSMode?: string; UsernsMode?: string };
  /** Aliases: the ones given at create. DNSNames (API 1.44 and later): every name Docker's DNS answers there. */
  NetworkSettings: { Networks: Record<string, { IPAddress: string; Aliases?: string[] | null; DNSNames?: string[] | null }> };
}

export interface ContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  State: string;
  /** Unix seconds. */
  Created?: number;
  Labels: Record<string, string>;
  /** The networks it is on, stopped or not. */
  NetworkSettings?: { Networks?: Record<string, unknown> | null } | null;
}

export interface ImageInfo {
  Id: string;
  RepoTags: string[] | null;
  RepoDigests: string[] | null;
  Size: number;
  Created: string;
  Config?: { Labels?: Record<string, string> | null; Entrypoint?: string[] | null; ExposedPorts?: Record<string, unknown> | null };
}

export interface ImageSummary {
  Id: string;
  RepoTags: string[] | null;
  Labels: Record<string, string> | null;
  Size: number;
  Created: number;
}

/** One image in Docker's disk accounting (GET /system/df), which counts containers and shared bytes. */
export interface DiskUsageImage {
  Id: string;
  /** The image this one was built on, empty for pulled and loaded images. */
  ParentId?: string;
  RepoTags?: string[] | null;
  RepoDigests?: string[] | null;
  Labels?: Record<string, string> | null;
  /** Unix seconds. */
  Created: number;
  Size: number;
  /** Bytes in layers this image shares with any other image, or -1 when Docker did not count them. */
  SharedSize: number;
  /** Containers, running or stopped, created from this image, or -1 when Docker did not count them. */
  Containers: number;
}

export interface DiskUsageVolume {
  Name: string;
  Labels?: Record<string, string> | null;
  /** Size is -1 when the volume driver cannot report one. */
  UsageData?: { Size: number; RefCount: number } | null;
}

/** The parts of GET /system/df that Dockify reads. */
export interface DiskUsage {
  /** Bytes every image layer takes on disk, each layer counted once however many images share it. */
  LayersSize?: number;
  Images?: DiskUsageImage[] | null;
  Volumes?: DiskUsageVolume[] | null;
}

/** The object types the socket proxy lets the worker ask /system/df about. */
export type DiskUsageType = "image" | "volume";

/** What the deploy engine needs from the daemon. Tests pass a fake. */
export interface DockerApi {
  inspectContainer(idOrName: string): Promise<ContainerInfo>;
  listContainers(labels: Record<string, string>): Promise<ContainerSummary[]>;
  createContainer(name: string, input: ContainerInput): Promise<string>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string, timeoutSeconds: number): Promise<void>;
  /** volumes: also drop the anonymous volumes only this container used. For throwaway containers. */
  removeContainer(id: string, opts?: { volumes?: boolean }): Promise<void>;
  renameContainer(id: string, name: string): Promise<void>;
  waitContainer(id: string, signal: AbortSignal): Promise<number>;
  /** Demultiplexed output; follow keeps the stream open until the container exits. */
  logs(id: string, follow: boolean): Promise<Readable>;
  inspectImage(ref: string): Promise<ImageInfo>;
  listImages(labels: Record<string, string>, dangling?: boolean): Promise<ImageSummary[]>;
  removeImage(id: string): Promise<void>;
  pullImage(ref: string, auth: string | null, onLine: (text: string) => void, signal: AbortSignal): Promise<void>;
  loadImage(tar: Readable, signal: AbortSignal): Promise<void>;
  ensureNetwork(name: string, labels: Record<string, string>, opts?: { internal?: boolean }): Promise<void>;
  connectNetwork(network: string, container: string): Promise<void>;
  disconnectNetwork(network: string, container: string): Promise<void>;
  ensureVolume(name: string, labels: Record<string, string>): Promise<void>;
  /** A volume that is already gone is fine; one a container still uses throws a conflict. */
  removeVolume(name: string): Promise<void>;
}

/** One network as GET /networks/<name> reports it: Containers holds only attached running containers. */
export interface NetworkInfo {
  Name: string;
  Containers?: Record<string, { Name?: string }> | null;
}

export interface Endpoint {
  socketPath?: string;
  host?: string;
  port?: number;
  /** Carries every request over a stream this makes, in place of a socket path or an address. */
  createConnection?: () => Duplex;
}

/** DOCKER_HOST as unix:///path or tcp://host:port. Defaults to the local socket. */
export function parseDockerHost(raw: string | undefined): Endpoint {
  const v = raw?.trim();
  if (!v) return { socketPath: "/var/run/docker.sock" };
  if (v.startsWith("unix://")) return { socketPath: v.slice("unix://".length) };
  const m = /^tcp:\/\/([a-zA-Z0-9.-]+):(\d{1,5})$/.exec(v);
  if (!m) throw new Error(`DOCKER_HOST ${v} must be unix:///path or tcp://host:port`);
  return { host: m[1]!, port: Number(m[2]) };
}

const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Splits Docker's multiplexed attach and logs framing (8 byte header: stream, 0, 0, 0, size BE)
 * into stdout and stderr chunks. Keeps a partial frame across calls.
 */
export class Demuxer {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer, emit: (stream: "stdout" | "stderr", data: Buffer) => void): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 8) {
      const size = this.buf.readUInt32BE(4);
      // Docker's frames are far below this. A header claiming more would buffer for as long as bytes come.
      if (size > MAX_FRAME_BYTES) throw new DockerError(502, "Docker sent a frame too large to be real");
      if (this.buf.length < 8 + size) break;
      const kind = this.buf[0] === 2 ? "stderr" : "stdout";
      emit(kind, this.buf.subarray(8, 8 + size));
      this.buf = this.buf.subarray(8 + size);
    }
  }
}

const API = "/v1.43";
/** Every environment network starts with this (deploy/containers.ts envNetwork). */
export const ENV_NETWORK_PREFIX = "dockify-env-";
/** A preview's own network is this and the preview's id. The shared fork network starts the same way. */
export const PREVIEW_NETWORK_PREFIX = "dockify-pv-";

/**
 * Linux caps interface names at 15 characters, so the bridge is "dk-" plus 12 hex characters of a
 * hash of the network name: stable per network and always matched by the installer's dk-+ rule.
 */
export const bridgeName = (network: string): string => `dk-${createHash("sha256").update(network).digest("hex").slice(0, 12)}`;
const qs = (q: Record<string, string | number | boolean | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};
const labelFilter = (labels: Record<string, string>, extra: Record<string, string[]> = {}) =>
  JSON.stringify({ label: Object.entries(labels).map(([k, v]) => `${k}=${v}`), ...extra });

async function readAll(res: IncomingMessage, cap = 8 * 1024 * 1024): Promise<string> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of res) {
    n += (c as Buffer).length;
    if (n > cap) throw new DockerError(502, "Docker response too large");
    parts.push(c as Buffer);
  }
  return Buffer.concat(parts).toString("utf8");
}

/** The `message` of a daemon error body ({"message":"..."}), or the body itself when it is plain text. */
export function daemonMessage(text: string): string {
  try {
    const m = (JSON.parse(text) as { message?: unknown }).message;
    return typeof m === "string" && m ? m : text;
  } catch {
    return text;
  }
}

export class DockerClient implements DockerApi {
  private readonly endpoint: Endpoint;
  /** The server's core count, or null when it is not known yet. */
  readonly cpuCores: number | null;
  constructor(endpoint: Endpoint, opts: { cpuCores: number | null }) {
    this.endpoint = endpoint;
    this.cpuCores = opts.cpuCores;
  }

  /** The endpoint this client dials; the data module's engine port reuses it for hijacked streams. */
  get target(): Endpoint {
    return this.endpoint;
  }

  raw(method: string, path: string, body?: unknown, opts: { signal?: AbortSignal; headers?: Record<string, string> } = {}): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const isStream = body !== undefined && typeof (body as Readable).pipe === "function";
      const payload = body === undefined || isStream ? undefined : Buffer.from(JSON.stringify(body));
      const req = request(
        {
          ...this.endpoint,
          method,
          path: `${API}${path}`,
          headers: {
            ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
            ...(isStream ? { "Content-Type": "application/x-tar" } : {}),
            ...opts.headers,
          },
          signal: opts.signal,
        },
        resolve,
      );
      req.on("error", reject);
      if (isStream) (body as Readable).pipe(req);
      else req.end(payload);
    });
  }

  async call<T>(method: string, path: string, body?: unknown, okEmpty = false, signal?: AbortSignal): Promise<T> {
    const res = await this.raw(method, path, body, signal ? { signal } : {});
    const text = await readAll(res);
    const status = res.statusCode ?? 500;
    if (status === 304) throw new DockerError(304, "not modified");
    if (status >= 400) {
      let msg = text;
      try {
        msg = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        // plain text body
      }
      throw new DockerError(status, msg.slice(0, 500));
    }
    if (okEmpty || !text) return undefined as T;
    return JSON.parse(text) as T;
  }

  /**
   * Reads a JSON-lines progress stream (pull, load) and fails on an errorDetail line. A refusal before
   * the stream starts (404 for an unknown image, for example) carries the daemon's message, never its
   * raw JSON body.
   */
  private async progress(res: IncomingMessage, onLine: (t: string) => void): Promise<void> {
    if ((res.statusCode ?? 500) >= 400) throw new DockerError(res.statusCode ?? 500, daemonMessage(await readAll(res)).slice(0, 500));
    let partial = "";
    let failure: string | null = null;
    for await (const c of res) {
      partial += (c as Buffer).toString("utf8");
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      if (partial.length > 64 * 1024) partial = "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line) as { status?: string; stream?: string; error?: string; id?: string };
          if (j.error) failure = j.error;
          const t = (j.stream ?? (j.status ? `${j.id ? `${j.id}: ` : ""}${j.status}` : "")).trim();
          if (t) onLine(t);
        } catch {
          onLine(line.slice(0, 2000));
        }
      }
    }
    if (failure) throw new DockerError(500, failure.slice(0, 500));
  }

  inspectContainer(id: string) {
    return this.call<ContainerInfo>("GET", `/containers/${encodeURIComponent(id)}/json`);
  }
  listContainers(labels: Record<string, string>) {
    return this.call<ContainerSummary[]>("GET", `/containers/json${qs({ all: true, filters: labelFilter(labels) })}`);
  }
  async createContainer(name: string, input: ContainerInput): Promise<string> {
    const spec = containerSpec({ ...input, name }, this.cpuCores);
    assertSafeSpec(spec);
    const out = await this.call<{ Id: string }>("POST", `/containers/create${qs({ name })}`, spec);
    return out.Id;
  }
  async startContainer(id: string) {
    await this.call("POST", `/containers/${encodeURIComponent(id)}/start`, undefined, true);
  }
  async stopContainer(id: string, t: number) {
    await this.call("POST", `/containers/${encodeURIComponent(id)}/stop${qs({ t })}`, undefined, true);
  }
  async removeContainer(id: string, opts: { volumes?: boolean } = {}) {
    await this.call("DELETE", `/containers/${encodeURIComponent(id)}${qs({ force: true, v: opts.volumes ?? false })}`, undefined, true);
  }
  async renameContainer(id: string, name: string) {
    await this.call("POST", `/containers/${encodeURIComponent(id)}/rename${qs({ name })}`, undefined, true);
  }
  async waitContainer(id: string, signal: AbortSignal): Promise<number> {
    const res = await this.raw("POST", `/containers/${encodeURIComponent(id)}/wait`, undefined, { signal });
    const text = await readAll(res);
    if ((res.statusCode ?? 500) >= 400) throw new DockerError(res.statusCode ?? 500, text.slice(0, 500));
    return (JSON.parse(text) as { StatusCode: number }).StatusCode;
  }
  async logs(id: string, follow: boolean): Promise<Readable> {
    const res = await this.raw("GET", `/containers/${encodeURIComponent(id)}/logs${qs({ stdout: true, stderr: true, follow, tail: follow ? undefined : 500 })}`);
    if ((res.statusCode ?? 500) >= 400) throw new DockerError(res.statusCode ?? 500, (await readAll(res)).slice(0, 500));
    return res;
  }
  inspectImage(ref: string) {
    return this.call<ImageInfo>("GET", `/images/${encodeURIComponent(ref)}/json`);
  }
  listImages(labels: Record<string, string>, dangling?: boolean) {
    const extra: Record<string, string[]> = dangling === undefined ? {} : { dangling: [String(dangling)] };
    return this.call<ImageSummary[]>("GET", `/images/json${qs({ filters: labelFilter(labels, extra) })}`);
  }
  async removeImage(id: string) {
    await this.call("DELETE", `/images/${encodeURIComponent(id)}${qs({ noprune: false })}`, undefined, true);
  }
  /**
   * Docker's own disk accounting for the object types named, and only those. The socket proxy
   * allows nothing else: container sizes walk every writable layer, and Docker's build cache is
   * empty here because builds run in Dockify's own BuildKit.
   */
  async diskUsage(types: readonly DiskUsageType[], signal?: AbortSignal): Promise<DiskUsage> {
    if (!types.length) throw new Error("diskUsage needs at least one object type");
    return this.call<DiskUsage>("GET", `/system/df?${types.map((t) => `type=${t}`).join("&")}`, undefined, false, signal);
  }
  async pullImage(ref: string, auth: string | null, onLine: (t: string) => void, signal: AbortSignal) {
    const res = await this.raw("POST", `/images/create${qs({ fromImage: ref })}`, undefined, {
      signal,
      ...(auth ? { headers: { "X-Registry-Auth": auth } } : {}),
    });
    await this.progress(res, onLine);
  }
  async loadImage(tar: Readable, signal: AbortSignal) {
    const res = await this.raw("POST", `/images/load${qs({ quiet: true })}`, tar, { signal });
    await this.progress(res, () => {});
  }
  async ensureNetwork(name: string, labels: Record<string, string>, opts: { internal?: boolean } = {}) {
    try {
      await this.call("GET", `/networks/${encodeURIComponent(name)}`);
      return;
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    try {
      await this.call("POST", "/networks/create", {
        Name: name, Driver: "bridge", Internal: opts.internal ?? false, Attachable: false, Labels: labels, CheckDuplicate: true,
        // The host firewall drops tenant traffic to host ports by interface (INPUT -i dk-+).
        Options: { "com.docker.network.bridge.name": bridgeName(name) },
      });
    } catch (e) {
      if (!isConflict(e)) throw e;
    }
  }
  async connectNetwork(network: string, container: string) {
    try {
      await this.call("POST", `/networks/${encodeURIComponent(network)}/connect`, { Container: container }, true);
    } catch (e) {
      // Already attached is success.
      if (!(e instanceof DockerError && (e.status === 403 || /already exists/i.test(e.message)))) throw e;
    }
  }
  async disconnectNetwork(network: string, container: string) {
    try {
      await this.call("POST", `/networks/${encodeURIComponent(network)}/disconnect`, { Container: container, Force: true }, true);
    } catch (e) {
      if (!isNotFound(e) && !(e instanceof DockerError && /is not connected/i.test(e.message))) throw e;
    }
  }
  /** The name-filtered list the socket proxy allows; names only, since the list omits attached containers. */
  async listEnvNetworks(): Promise<string[]> {
    const rows = await this.call<Array<{ Name: string }>>("GET", `/networks?filters=${encodeURIComponent(JSON.stringify({ name: [ENV_NETWORK_PREFIX] }))}`);
    return rows.map((n) => n.Name).filter((n) => n.startsWith(ENV_NETWORK_PREFIX));
  }
  async listPreviewNetworks(): Promise<string[]> {
    const rows = await this.call<Array<{ Name: string }>>("GET", `/networks?filters=${encodeURIComponent(JSON.stringify({ name: [PREVIEW_NETWORK_PREFIX] }))}`);
    return rows.map((n) => n.Name).filter((n) => n.startsWith(PREVIEW_NETWORK_PREFIX));
  }
  inspectNetwork(name: string) {
    return this.call<NetworkInfo>("GET", `/networks/${encodeURIComponent(name)}`);
  }
  async removeNetwork(name: string) {
    await this.call("DELETE", `/networks/${encodeURIComponent(name)}`, undefined, true);
  }
  async ensureVolume(name: string, labels: Record<string, string>) {
    await this.call("POST", "/volumes/create", { Name: name, Labels: labels });
  }
  async removeVolume(name: string) {
    await this.call("DELETE", `/volumes/${encodeURIComponent(name)}`, undefined, true).catch((e: unknown) => {
      if (!isNotFound(e)) throw e;
    });
  }
}
