/**
 * The few read-only Docker Engine calls observability needs, over the socket proxy: list containers (Dockify's own, or by a name or label filter for the control
 * plane's containers), inspect, one-shot stats, and a log follow. Every read has a
 * timeout, because a daemon that accepts the connection and never answers would otherwise wedge the
 * sampler. Nothing here creates, starts or changes a container.
 */
import { request, type IncomingMessage } from "node:http";
import { DockerError, type Endpoint } from "@dockify/engine";

export const LABEL_MANAGED = "dockify.managed";
export const LABEL_APP = "dockify.app";
export const LABEL_ROLE = "dockify.role";

export interface ContainerSummary {
  Id: string;
  Names: string[];
  Labels: Record<string, string>;
  State: string;
  Status: string;
  Created: number;
}

export interface ContainerInspect {
  Id: string;
  RestartCount: number;
  State: { Status: string; Running: boolean; Restarting: boolean; StartedAt: string; Health?: { Status: string } };
  HostConfig?: { Memory?: number; NanoCpus?: number; PidsLimit?: number | null };
}

export interface DockerStats {
  cpu_stats?: { cpu_usage?: { total_usage?: number; percpu_usage?: number[] }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: { usage?: number; limit?: number; stats?: { inactive_file?: number; total_inactive_file?: number } };
  pids_stats?: { current?: number };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
}

export interface DockerReader {
  listManaged(): Promise<ContainerSummary[]>;
  /** Every container, running or not, matching Docker's list filters (name, label). */
  listFiltered(filters: Record<string, string[]>): Promise<ContainerSummary[]>;
  inspect(id: string): Promise<ContainerInspect>;
  stats(id: string): Promise<DockerStats>;
  /** Raw multiplexed log stream (stdout and stderr frames), with timestamps, from `sinceSec`. */
  followLogs(id: string, sinceSec: number, signal: AbortSignal): Promise<IncomingMessage>;
}

const READ_TIMEOUT_MS = 15_000;
/** The same ceiling as the deploy client's readAll: an answer past it is a daemon that cannot be trusted. */
export const MAX_ANSWER_BYTES = 8 * 1024 * 1024;
const ID = /^[a-f0-9]{12,64}$/;

export function createDockerReader(endpoint: Endpoint): DockerReader {
  function open(path: string, signal?: AbortSignal, timeoutMs: number | null = READ_TIMEOUT_MS): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = request({
        ...endpoint,
        path,
        method: "GET",
        ...(signal ? { signal } : {}),
      });
      let timer: NodeJS.Timeout | null = null;
      if (timeoutMs !== null) timer = setTimeout(() => req.destroy(new Error(`docker ${path} timed out`)), timeoutMs);
      req.on("response", (res) => {
        if (timer) clearTimeout(timer);
        if ((res.statusCode ?? 500) >= 400) {
          res.resume();
          // A DockerError, so a 404 reads as the container going away and not as the daemon not answering.
          reject(new DockerError(res.statusCode ?? 500, `docker ${path.split("?")[0]} answered ${res.statusCode}`));
          return;
        }
        resolve(res);
      });
      req.on("error", (e) => {
        if (timer) clearTimeout(timer);
        reject(e);
      });
      req.end();
    });
  }

  async function json<T>(path: string): Promise<T> {
    const res = await open(path);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => res.destroy(new Error(`docker ${path} body timed out`)), READ_TIMEOUT_MS);
    try {
      let size = 0;
      for await (const c of res) {
        size += (c as Buffer).length;
        if (size > MAX_ANSWER_BYTES) {
          res.destroy();
          throw new DockerError(502, `docker ${path.split("?")[0]} answered more than ${MAX_ANSWER_BYTES} bytes`);
        }
        chunks.push(c as Buffer);
      }
    } finally {
      clearTimeout(timer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    } catch {
      // Docker ends a read with an empty body when the container goes away during it. Read as gone.
      throw new DockerError(404, `docker ${path.split("?")[0]} sent an incomplete answer`);
    }
  }

  const checkId = (id: string): string => {
    if (!ID.test(id)) throw new Error("not a container id");
    return id;
  };

  return {
    listManaged: () =>
      json<ContainerSummary[]>(`/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [`${LABEL_MANAGED}=true`] }))}`),
    listFiltered: (filters) => json<ContainerSummary[]>(`/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify(filters))}`),
    inspect: (id) => json<ContainerInspect>(`/containers/${checkId(id)}/json`),
    stats: (id) => json<DockerStats>(`/containers/${checkId(id)}/stats?stream=false`),
    followLogs: (id, sinceSec, signal) =>
      open(`/containers/${checkId(id)}/logs?follow=1&stdout=1&stderr=1&timestamps=1&since=${Math.max(0, Math.floor(sinceSec))}`, signal, null),
  };
}

/** A parked previous container during a swap is `<name>-prev-<base36>`: never sampled as the app. */
export const PARKED = /-prev-[0-9a-z]+$/;

/** One container per app: skips one-offs without the app label and parked leftovers, newest wins. */
export function pickAppContainers(list: ContainerSummary[]): Map<string, ContainerSummary> {
  const byApp = new Map<string, ContainerSummary>();
  for (const c of list) {
    const appId = c.Labels[LABEL_APP];
    if (!appId) continue;
    // Only the container that serves the app counts: role=app for a deployed app (swap.ts) and
    // role=service-<kind> for a managed Postgres, Redis or S3 (data/services.ts). Every other role
    // carries dockify.app too and is newer than the container it belongs to, so it would shadow it:
    // a preview (role=preview, dockify.app inherited from its image label), a release one-off
    // (role=release), and the data module's helpers (role=backup-helper, restore-helper and
    // restore-test, data/pipeline.ts).
    const role = c.Labels[LABEL_ROLE] ?? "";
    if (role !== "app" && !role.startsWith("service-")) continue;
    if (c.Names.some((n) => PARKED.test(n.replace(/^\//, "")))) continue;
    const prev = byApp.get(appId);
    if (!prev || c.Created > prev.Created) byApp.set(appId, c);
  }
  return byApp;
}
