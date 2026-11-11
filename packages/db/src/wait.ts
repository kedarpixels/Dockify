import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * After a host reboot Docker starts every container at once, so the api and the worker come up before
 * Postgres and the socket proxy. Each waits with backoff and logs an error only for a real outage.
 */
export interface WaitLog {
  info(msg: string, extra?: object): void;
  error(msg: string, extra?: object): void;
}

export interface WaitOptions {
  log: WaitLog;
  signal?: AbortSignal;
  /** How long a failure lasts before it is logged as an error. 60 s by default. */
  sustainedMs?: number;
  /** The longest pause between attempts; the first is 1 s, doubling. 15 s by default. */
  maxDelayMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n").map((l) => l.trim()).filter(Boolean).at(-1)?.slice(0, 300) ?? "unknown error";

/** True once `probe` resolves, false when `signal` aborts first. A first-try success logs nothing. */
export async function waitUntilReachable(what: string, probe: () => Promise<unknown>, o: WaitOptions): Promise<boolean> {
  const now = o.now ?? Date.now;
  const pause = o.sleep ?? ((ms: number, signal?: AbortSignal) => sleep(ms, undefined, { signal }).then(() => undefined));
  const sustained = o.sustainedMs ?? 60_000;
  const maxDelay = o.maxDelayMs ?? 15_000;
  let since: number | null = null;
  let reported = false;
  let delay = 1_000;
  for (;;) {
    if (o.signal?.aborted) return false;
    try {
      await probe();
      if (since !== null) o.log.info(`${what} is reachable`, { waitedMs: now() - since });
      return true;
    } catch (e) {
      if (since === null) {
        since = now();
        o.log.info(`waiting for ${what}`, { reason: message(e) });
      } else if (!reported && now() - since >= sustained) {
        reported = true;
        o.log.error(`${what} has been unreachable for ${Math.round((now() - since) / 1000)} s; still retrying`, { reason: message(e) });
      }
    }
    await pause(delay, o.signal).catch(() => undefined);
    delay = Math.min(delay * 2, maxDelay);
  }
}

/**
 * Resolves once something accepts a TCP connection at the database URL's host and port. Silent by
 * design: it never goes through Prisma, whose client logs every failed connection as an error.
 */
export function tcpProbe(databaseUrl: string, timeoutMs = 3_000): () => Promise<void> {
  const u = new URL(databaseUrl);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const port = Number(u.port || 5432);
  return () =>
    new Promise<void>((resolve, reject) => {
      const s = connect({ host, port });
      const done = (e?: Error) => {
        s.removeAllListeners();
        s.destroy();
        if (e) reject(e);
        else resolve();
      };
      s.setTimeout(timeoutMs, () => done(new Error(`no answer from ${host}:${port} in ${timeoutMs} ms`)));
      s.once("connect", () => done());
      s.once("error", (e) => done(e));
    });
}
