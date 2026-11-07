/**
 * The readiness gate before any route flip. A container passes only when it is running, not
 * crash-looping, its own HEALTHCHECK (if any) is not unhealthy, and, when the app has a port, a TCP
 * connect (plus an HTTP GET when a health path is set) to it on the environment network succeeds.
 * "Running for a few seconds" alone is accepted only for apps with no port.
 */
import { requestOver } from "../server/http-over.ts";
import type { Dialer } from "../server/runtime.ts";
import type { ContainerInfo } from "@dockify/engine";

export interface HealthConfig {
  port: number | null;
  path: string | null;
  expectedStatus: number;
  /** Per probe. */
  timeoutSeconds: number;
  /** Failures inside the grace window do not count against the deploy. */
  graceSeconds: number;
  intervalSeconds: number;
  /** Total time after the grace window before giving up. */
  windowSeconds: number;
  hostHeader?: string | null;
}

export interface ProbeDeps {
  inspect(): Promise<ContainerInfo>;
  /** The container's address on its network, read from an inspect. */
  addressOf(info: ContainerInfo): string | null;
  tcp(host: string, port: number, timeoutMs: number): Promise<boolean>;
  http(host: string, port: number, path: string, timeoutMs: number, hostHeader: string | null): Promise<number | null>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
}

export interface Readiness {
  ok: boolean;
  /** Completes "Container ...". */
  detail: string;
  info: ContainerInfo | null;
  address: string | null;
  /** The last non-zero exit code seen: a restarted container reads 0 again once it runs. */
  exitCode?: number | null;
}

/** Without a port there is nothing to dial; staying up this long is the only signal left. */
export const SETTLE_MS = 3_000;

export async function waitUntilReady(cfg: HealthConfig, deps: ProbeDeps, signal: AbortSignal): Promise<Readiness> {
  const started = deps.now();
  const graceEnd = started + cfg.graceSeconds * 1000;
  const deadline = graceEnd + cfg.windowSeconds * 1000;
  const cadenceMs = Math.max(250, Math.min(cfg.intervalSeconds, 2) * 1000);
  let baseRestarts: number | null = null;
  let lastProbe = "no probe ran yet";
  let lastExit: number | null = null;

  for (;;) {
    if (signal.aborted) return { ok: false, detail: "was cancelled before it became ready", info: null, address: null };
    const info = await deps.inspect();
    const st = info.State;
    const restarts = info.RestartCount ?? 0;
    baseRestarts ??= restarts;
    if (st.ExitCode) lastExit = st.ExitCode;

    if (st.Restarting || restarts > baseRestarts) {
      const times = restarts - baseRestarts;
      return { ok: false, detail: `is crash-looping${times > 0 ? ` (restarted ${times} ${times === 1 ? "time" : "times"})` : ""}${lastExit ? `, last exit code ${lastExit}` : ""}`, info, address: null, exitCode: lastExit };
    }
    if (!st.Running) {
      return { ok: false, detail: `exited (${st.Status}${st.ExitCode ? `, exit code ${st.ExitCode}` : ""}${st.Error ? `: ${st.Error}` : ""})`, info, address: null, exitCode: lastExit };
    }
    const health = st.Health?.Status;
    if (health === "unhealthy") {
      const last = st.Health?.Log?.at(-1)?.Output?.trim();
      return { ok: false, detail: `failed its own HEALTHCHECK${last ? `: ${last.slice(0, 300)}` : ""}`, info, address: null };
    }

    const address = deps.addressOf(info);
    const t = deps.now();
    if (cfg.port === null) {
      if (health === "healthy") return { ok: true, detail: "is running and its HEALTHCHECK passed", info, address };
      if (!health && t - started >= Math.max(SETTLE_MS, cfg.graceSeconds * 1000)) {
        return { ok: true, detail: "is running (no port, so no probe)", info, address };
      }
    } else if (!address) {
      lastProbe = "the container has no address on its network";
    } else if (health !== "starting") {
      const ms = cfg.timeoutSeconds * 1000;
      if (!(await deps.tcp(address, cfg.port, ms))) {
        lastProbe = `nothing is listening on port ${cfg.port}`;
      } else if (cfg.path) {
        const status = await deps.http(address, cfg.port, cfg.path, ms, cfg.hostHeader ?? null);
        if (status === cfg.expectedStatus) return { ok: true, detail: `answered GET ${cfg.path} with ${status}`, info, address };
        lastProbe = status === null ? `GET ${cfg.path} did not answer within ${cfg.timeoutSeconds}s` : `GET ${cfg.path} answered ${status}, expected ${cfg.expectedStatus}`;
      } else {
        return { ok: true, detail: `accepted a connection on port ${cfg.port}`, info, address };
      }
    }

    if (t >= deadline) {
      const waited = Math.round((t - started) / 1000);
      return { ok: false, detail: `was not ready after ${waited}s: ${health === "starting" ? "its HEALTHCHECK was still starting" : lastProbe}`, info, address };
    }
    await deps.sleep(cadenceMs, signal).catch(() => {});
  }
}

/**
 * The two probes of one container, over the server's dialer. `host` is only what a request with no
 * domain of its own says in its Host header: the container's address, as it always read.
 */
export function dialProbes(dial: Dialer, container: string, network: string, signal: AbortSignal): Pick<ProbeDeps, "tcp" | "http"> {
  return {
    async tcp(_host, port, timeoutMs) {
      const socket = await dial({ container, network, port }, { timeoutMs, signal }).catch(() => null);
      socket?.destroy();
      return !!socket;
    },
    async http(host, port, path, timeoutMs, hostHeader) {
      const socket = await dial({ container, network, port }, { timeoutMs, signal }).catch(() => null);
      if (!socket) return null;
      return new Promise((resolve) => {
        const req = requestOver(socket, { host, port, path, method: "GET", timeoutMs, headers: { "User-Agent": "Dockify-Readiness", ...(hostHeader ? { Host: hostHeader } : {}) } }, (res) => {
          resolve(res.statusCode ?? null);
          // The status is the answer. An endless body must not keep this connection, and so the network, open.
          req.destroy();
        });
        req.on("error", () => resolve(null));
        req.end();
      });
    },
  };
}
