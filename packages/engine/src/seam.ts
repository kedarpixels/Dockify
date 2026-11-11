/**
 * The parts of a server every module reaches through, as types. The worker's ServerRuntime is made of
 * these; the agent implements the same ones on the machine itself.
 */
import type { Duplex } from "node:stream";
import type { BuildInput, BuildLog, BuildResult } from "./build.ts";
import type { PlanInfo, PlanInput } from "./railpack.ts";

/** A container on one of its networks, or the server's own proxy by port. Never a raw address. */
export type DialTarget = { container: string; network: string; port: number } | { proxy: 80 | 443 | 8080 | 8082 };

/** Resolves once connected. Rejects when nothing answers within the timeout. */
export type Dialer = (target: DialTarget, opts?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<Duplex>;

/** One change to the route folder: nothing moves until every write is staged, then removes, then the writes in order, each by rename. */
export interface RouteChange {
  writes?: Record<string, string>;
  removes?: string[];
}

/** The proxy's route files, by file name (no folders). System files are in here too. */
export interface RouteStore {
  read(name: string): Promise<string | null>;
  snapshot(): Promise<Record<string, string>>;
  apply(change: RouteChange): Promise<void>;
}

/** BuildKit on the server. The address of the daemon is the server's own business. */
export interface Builder {
  build(input: BuildInput, log: BuildLog, signal: AbortSignal): Promise<BuildResult>;
  /** Railpack's read of a repository, in the BuildKit sandbox, without building it. */
  plan(input: PlanInput, onLine: (line: string) => string | null, signal: AbortSignal): Promise<PlanInfo>;
  /** Each answers with buildctl's own output, which the disk module parses. */
  cacheUsage(timeoutMs: number): Promise<string>;
  pruneCache(timeoutMs: number): Promise<string>;
  /** Empties one scope's cache mounts, when the preview that owned them goes. */
  pruneCacheScope(scope: string, timeoutMs: number): Promise<string>;
  trimCache(keepBytes: number): Promise<string>;
}
