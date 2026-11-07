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
