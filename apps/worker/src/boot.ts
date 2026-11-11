/**
 * The worker's start-up, in an order that keeps the edge working whatever else is down:
 *
 *   1. the database, waited for with backoff and logged once per state change (@dockify/db
 *      waitUntilReachable): which server this is comes from there
 *   2. the system routes on that server (edge/routes.ts ensureSystemRoutes), then Docker, waited for
 *      the same way. Traefik keeps serving the files it has until then
 *   3. every route resynced against the live containers, before any job runs
 *   4. the work folder checked: a worker that cannot write it still starts, reports the problem as
 *      a health issue and refuses only the jobs that stage files there (health.ts)
 *
 * main.ts runs these in order, then starts the timers and the job lanes.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Logger {
  info(msg: string, extra?: object): void;
  warn(msg: string, extra?: object): void;
  error(msg: string, extra?: object): void;
}

/** One JSON line per entry on stderr, the shape the rest of the worker already logs. */
export function jsonLogger(write: (line: string) => void = (l) => void process.stderr.write(l)): Logger {
  const at = (level: string) => (msg: string, extra?: object) => write(`${JSON.stringify({ level, msg, ...extra })}\n`);
  return { info: at("info"), warn: at("warn"), error: at("error") };
}

/** A connection that dropped, as Node and node-postgres (57P0x: the server ended the session) report it. */
const DROPPED = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED", "ECONNABORTED", "EHOSTUNREACH", "ENETUNREACH", "ERR_STREAM_PREMATURE_CLOSE", "57P01", "57P02", "57P03"]);

/**
 * True for an error the process is sound after: a connection lost with nobody listening for it. The
 * operation that owned it has failed and nothing else is touched. Anything else is a bug whose
 * damage is unknown.
 */
export function survivable(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && DROPPED.has(code)) return true;
  return e instanceof Error && /^Connection terminated/.test(e.message);
}

interface Proc {
  on(event: "uncaughtException", listener: (e: unknown, origin: string) => void): unknown;
  exit(code: number): unknown;
}

/**
 * The last word on an error nothing caught (an unhandled rejection arrives here too). A dropped
 * connection is logged and survived: exiting would take every running deploy, backup and restore
 * with it. Anything else stops the worker as before, with the cause as the last line logged.
 */
export function guardProcess(log: Logger, proc: Proc = process): void {
  proc.on("uncaughtException", (e, origin) => {
    const detail = { origin, error: reason(e), stack: e instanceof Error ? e.stack : undefined };
    if (survivable(e)) return log.error("a connection dropped with nothing listening for it; the worker carries on", detail);
    log.error(`worker stopping on an uncaught error: ${reason(e)}`, detail);
    proc.exit(1);
  });
}

const reason = (e: unknown): string => {
  const code = typeof e === "object" && e && "code" in e ? String((e as { code: unknown }).code) : "";
  const msg = e instanceof Error ? e.message : String(e);
  return code && !msg.startsWith(code) ? `${code}: ${msg}` : msg;
};

/** Null when this process can create, write and remove a file in `dir` (made if missing), else why not. */
export async function checkWritable(dir: string): Promise<string | null> {
  try {
    await mkdir(dir, { recursive: true });
    const probe = join(dir, `.write-check-${process.pid}`);
    await writeFile(probe, "");
    await rm(probe, { force: true });
    return null;
  } catch (e) {
    return reason(e);
  }
}
