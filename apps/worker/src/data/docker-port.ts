/** Every create goes through containerSpec(), and the implementation must assertSafeSpec() the exact body it sends. */
import type { Readable, Writable } from "node:stream";
import type { ContainerSpec } from "@dockify/engine";

export interface ExecResult {
  exitCode: number;
  stderr: string;
}

export interface ExecHandle {
  /** Read it or resume() it: the process is held back while nobody takes its output. */
  stdout: Readable;
  stdin: Writable | null;
  /** Settles when the process has exited (polled until Running is false, never a null exit code). */
  done: Promise<ExecResult>;
  kill(): Promise<void>;
}

export interface ContainerMount {
  type: string;
  name: string | null;
  destination: string;
}

export interface ContainerState {
  id: string;
  running: boolean;
  health: "healthy" | "unhealthy" | "starting" | "none";
  labels: Record<string, string>;
  addresses: Record<string, string>;
  mounts?: ContainerMount[];
  /** Config.Env as KEY=value lines. Read for one known key at a time, never logged or kept. */
  env?: string[];
}

export interface ContainerListing {
  id: string;
  names: string[];
  running: boolean;
  labels: Record<string, string>;
}

export interface ImageState {
  id: string;
  repoDigests: string[];
}

export interface DockerPort {
  readonly cpuCores: number | null;
  ensureNetwork(name: string, labels: Record<string, string>, opts?: { internal?: boolean }): Promise<void>;
  ensureVolume(name: string, labels: Record<string, string>): Promise<void>;
  removeVolume(name: string): Promise<void>;
  createContainer(name: string, spec: ContainerSpec): Promise<string>;
  start(id: string): Promise<void>;
  stop(id: string, timeoutSeconds: number): Promise<void>;
  /** volumes: also drop the anonymous volumes only this container used. For throwaway containers. */
  remove(id: string, opts?: { volumes?: boolean }): Promise<void>;
  inspect(idOrName: string): Promise<ContainerState | null>;
  exec(id: string, opts: { cmd: string[]; env?: Record<string, string>; stdin?: boolean; user?: string }): Promise<ExecHandle>;
  attach(id: string, opts: { stdin?: boolean }): Promise<ExecHandle>;
  list(labels: Record<string, string>): Promise<ContainerListing[]>;
  /** By name only, from one dk- name to another: the socket proxy allows nothing else. */
  rename(name: string, newName: string): Promise<void>;
  inspectImage(ref: string): Promise<ImageState | null>;
  pullImage(ref: string, onLine?: (text: string) => void): Promise<void>;
}
