import { readFile } from "node:fs/promises";
import { dashboardDomain as D } from "@dockify/contracts";
import { Prisma, type Db } from "@dockify/db";
import { heartbeat, type Claimed } from "./engine.ts";
import { isPlainHost, publicHostOf } from "./env-file.ts";
import type { Service, UpdateSteps } from "./runner.ts";
import { installPaths, type ControlProbe, type Runner, type StepsConfig } from "./steps.ts";

/**
 * The dashboard's change of address runs in the updater, the one process that holds the Docker
 * socket and outlives the services it recreates. The api's boot records the change, not this file.
 * Every step is safe to repeat, so a lease taken over after a crash carries on.
 */

const SERVICES: Service[] = ["api", "worker", "web"];
const WAIT_RETRY_MS = 30_000;
const WAIT_MAX_MS = 2 * 3_600_000;
const ENV_WRITER = "/app/apps/api/src/modules/platform/updates/env-file.ts";

export interface DomainSwitchDeps {
  db: Db;
  steps: Pick<UpdateSteps, "swap" | "healthy" | "currentImages">;
  exec: Runner;
  cfg: Pick<StepsConfig, "composeDir">;
  probe: Pick<ControlProbe, "busy">;
  log: (line: string) => void;
  now?: () => Date;
}

/** The throwaway root container: no network, no capability but CHOWN, only the install folder mounted. */
export function envWriterArgs(dir: string, image: string, host: string): string[] {
  return [
    "run", "--rm", "--network", "none", "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "CHOWN",
    "--security-opt", "no-new-privileges", "--read-only", "-v", `${dir}:/install`, "--entrypoint", "node", image, ENV_WRITER, "/install", host,
  ];
}

const finish = (db: Db, id: string) => db.$executeRaw`UPDATE jobs SET "completedAt" = now(), "lockedUntil" = NULL, "lockedBy" = NULL WHERE id = ${id}::uuid`;
const giveUp = (db: Db, id: string, why: string) => db.$executeRaw`UPDATE jobs SET "failedAt" = now(), "lastError" = ${why.slice(0, 500)}, "lockedUntil" = NULL, "lockedBy" = NULL WHERE id = ${id}::uuid`;
/** Requeues without spending an attempt. */
const later = (db: Db, id: string, ms: number) =>
  db.$executeRaw`UPDATE jobs SET attempts = GREATEST(attempts - 1, 0), "runAfter" = now() + ${ms}::double precision * interval '1 millisecond', "lockedUntil" = NULL, "lockedBy" = NULL WHERE id = ${id}::uuid`;

/** The returned string is only for the log. */
export async function runDomainSwitch(deps: DomainSwitchDeps, job: Claimed, holder: string): Promise<string> {
  const { db, steps, exec, cfg, log } = deps;
  const payload = (job.payload && typeof job.payload === "object" ? job.payload : {}) as { host?: unknown };
  const host = typeof payload.host === "string" ? payload.host : "";
  if (!isPlainHost(host)) {
    await giveUp(db, job.id, "The job does not name a plain hostname");
    return "refused: not a plain hostname";
  }
  const row = await db.instance.findUnique({ where: { id: 1 }, select: { dashboardDomain: true, dashboardLastChange: true, createdAt: true } });
  const pending = D.readPendingDomain(row?.dashboardDomain);
  const now = deps.now?.() ?? new Date();

  // Recreating the worker would stop a deploy, backup or restore in flight, so wait for it.
  const busy = await deps.probe.busy();
  if (busy) {
    const since = pending ? Date.parse(pending.requestedAt) : now.getTime();
    if (now.getTime() - since < WAIT_MAX_MS) {
      await later(db, job.id, WAIT_RETRY_MS);
      return `waiting: ${busy} is in flight`;
    }
    return failed(deps, job, host, pending, `The dashboard stayed where it is: ${busy} was still running after two hours.`);
  }

  const stop = heartbeat(db, job.id, holder);
  try {
    const envFile = installPaths(cfg.composeDir).env;
    const before = publicHostOf(await readFile(envFile, "utf8"));
    const images = await steps.currentImages();
    if (before !== host) {
      log(`moving the dashboard from ${before ?? "unknown"} to ${host}`);
      await exec("docker", envWriterArgs(cfg.composeDir, images.control, host));
    }
    const since = deps.now?.() ?? new Date();
    try {
      for (const s of SERVICES) await steps.swap(s, since);
      const bad = await steps.healthy(since);
      if (bad) throw new Error(bad);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      log(`the switch failed (${why}); going back to ${before ?? "the old address"}`);
      if (before && isPlainHost(before) && before !== host) {
        try {
          await exec("docker", envWriterArgs(cfg.composeDir, images.control, before));
          const back = deps.now?.() ?? new Date();
          for (const s of SERVICES) await steps.swap(s, back);
        } catch (e2) {
          // .env may name either host by now, so nothing here can say where the dashboard is.
          const lost = e2 instanceof Error ? e2.message : String(e2);
          log(`going back failed too: ${lost}`);
          return failed(deps, job, host, pending, `The switch failed (${why}) and going back to ${before} failed too (${lost}). Check DOCKIFY_PUBLIC_URL in .env, then run: sudo dockify admin set-domain <host>`, row?.dashboardLastChange);
        }
      }
      return failed(deps, job, host, pending, `The dashboard went back to ${before ?? "its old address"}: ${why}`, row?.dashboardLastChange);
    }
    await finish(db, job.id);
    log(`the dashboard now answers on ${host}`);
    return "done";
  } catch (e) {
    return failed(deps, job, host, pending, `The dashboard stayed where it is: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    stop();
  }
}

/**
 * A rollback boots the api on the new host and again on the old, so its boot recorded the failed
 * name as an address the dashboard left. That entry and that last change are taken back here.
 */
async function failed(deps: DomainSwitchDeps, job: Claimed, host: string, pending: D.PendingDomain | null, why: string, lastChange?: unknown): Promise<string> {
  const { db, log } = deps;
  const message = why.slice(0, 300);
  log(message);
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dockify.dashboard.domain'))`;
    const row = await tx.instance.findUnique({ where: { id: 1 }, select: { dashboardPreviousHosts: true } });
    const next = pending ? { ...pending, phase: "failed" as const, error: message } : null;
    await tx.instance.update({
      where: { id: 1 },
      data: {
        dashboardDomain: next ? (next as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        dashboardPreviousHosts: (row?.dashboardPreviousHosts ?? []).filter((h) => h !== host),
        ...(lastChange === undefined ? {} : { dashboardLastChange: lastChange === null ? Prisma.DbNull : (lastChange as Prisma.InputJsonValue) }),
      },
    });
  });
  await giveUp(db, job.id, message);
  return `failed: ${message}`;
}
