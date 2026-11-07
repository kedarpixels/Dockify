/**
 * The slice of the Docker Engine the data module uses. The worker's daemon client (behind the
 * socket proxy) implements it; tests use fakes. Every create goes through containerSpec() first,
 * and the implementation must call assertSafeSpec() on the exact body it sends.
 */
import type { Readable, Writable } from "node:stream";
import type { ContainerSpec } from "@dockify/engine";

export interface ExecResult {
  exitCode: number;
  /** Bounded tail of stderr, for the error message. */
  stderr: string;
}

export interface ExecHandle {
  stdout: Readable;
  /** Present only when the exec was started with stdin. Ending it sends EOF. */
  stdin: Writable | null;
  /** Settles when the process has exited (polled until Running is false, never a null exit code). */
  done: Promise<ExecResult>;
  /** Kills the process side of the exec, for aborts. */
  kill(): Promise<void>;
}

/** One mount of a container, as the daemon reports it. */
export interface ContainerMount {
  type: string;
  /** The volume name for a volume mount (64 hex characters for an anonymous one), else null. */
  name: string | null;
  destination: string;
}

export interface ContainerState {
  id: string;
  running: boolean;
  health: "healthy" | "unhealthy" | "starting" | "none";
  labels: Record<string, string>;
  /** Address on each attached network. */
  addresses: Record<string, string>;
  /** Absent from fakes that do not need it. */
  mounts?: ContainerMount[];
  /** Config.Env as KEY=value lines. Read for one known key at a time, never logged or kept. */
  env?: string[];
}

export interface ContainerListing {
  id: string;
  /** Without the leading slash. */
  names: string[];
  running: boolean;
  labels: Record<string, string>;
}

export interface ImageState {
  /** The local image id (sha256:...), what a container is created from. */
  id: string;
  /** repo@sha256:... for each registry it was pulled from. */
  repoDigests: string[];
}

export interface DockerPort {
  /** The server's core count, for the default limit of a container with none (null: not known yet). */
  readonly cpuCores: number | null;
  ensureNetwork(name: string, labels: Record<string, string>, opts?: { internal?: boolean }): Promise<void>;
  ensureVolume(name: string, labels: Record<string, string>): Promise<void>;
  removeVolume(name: string): Promise<void>;
  createContainer(name: string, spec: ContainerSpec): Promise<string>;
  start(id: string): Promise<void>;
  stop(id: string, timeoutSeconds: number): Promise<void>;
  /** volumes: also drop the anonymous volumes only this container used. For throwaway containers. */
  remove(id: string, opts?: { volumes?: boolean }): Promise<void>;
  /** By id or name. Null when there is no such container. */
  inspect(idOrName: string): Promise<ContainerState | null>;
  exec(id: string, opts: { cmd: string[]; env?: Record<string, string>; stdin?: boolean; user?: string }): Promise<ExecHandle>;
  /** Attaches to a created container's stdout before it starts (one-off helpers). */
  attach(id: string, opts: { stdin?: boolean }): Promise<ExecHandle>;
  /** Every container, running or not, carrying all of these labels. */
  list(labels: Record<string, string>): Promise<ContainerListing[]>;
  /** By name only, from one dk- name to another: the socket proxy allows nothing else. */
  rename(name: string, newName: string): Promise<void>;
  /** A local image by id or reference, or null when this server does not have it. */
  inspectImage(ref: string): Promise<ImageState | null>;
  /** Pulls a reference (a tag, or repo@sha256:...). Fails on any error the registry reports. */
  pullImage(ref: string, onLine?: (text: string) => void): Promise<void>;
}
