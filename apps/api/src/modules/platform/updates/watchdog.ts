/**
 * Brings back control services that `restart: unless-stopped` will not: a container killed with
 * `docker kill` counts as stopped by hand and stays down, and Docker never restarts an unhealthy one.
 * Idle during an update or a dashboard address change, which stop services themselves.
 */
import { audit } from "../../../audit.ts";
import type { Db } from "@dockify/db";
import { checkInstallTree, installPaths, run, type ControlProbe, type GuardFs, type Runner, type StepsConfig } from "./steps.ts";

export const GRACE_MS = 2 * 60_000;
export const COOLDOWN_MS = 10 * 60_000;
/** The updater cannot wake itself, and one-shot services stay out. */
export const WATCHED = new Set(["postgres", "api", "worker", "agent", "web", "socket-proxy", "proxy", "proxy-direct", "cloudflared", "buildkit"]);
/** A clean answer to SIGTERM (0 from a handler, 143 by default): stopped on purpose, so it stays stopped. */
const DELIBERATE_EXIT = new Set([0, 143]);

export interface ServiceRow {
  service: string;
  state: string;
  health: string;
  exitCode: number;
}

/**
 * `compose ps --format json` prints one object per line from Compose 2.21 on, one array before.
 * A row labelled dockify.managed is a tenant container posing as a service and is never watched.
 */
export function parseComposePs(out: string): ServiceRow[] {
  const t = out.trim();
  if (!t) return [];
  const raw = t.startsWith("[") ? (JSON.parse(t) as unknown[]) : t.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as unknown);
  const rows: ServiceRow[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    if (typeof r.Service !== "string" || typeof r.State !== "string") continue;
    if (typeof r.Labels === "string" && /(?:^|,)dockify\.managed=/.test(r.Labels)) continue;
    rows.push({ service: r.Service, state: r.State, health: typeof r.Health === "string" ? r.Health : "", exitCode: typeof r.ExitCode === "number" ? r.ExitCode : 0 });
  }
  return rows;
}

export type WatchAction = { service: string; action: "start" | "restart"; why: string };

/**
 * A state must hold for GRACE_MS (a recreate in progress is left alone) and a service is touched
 * once per COOLDOWN_MS. `bad` keeps when each state began. Unhealthy services wait for the database:
 * its outage makes them unhealthy too and restarting them would not help.
 */
export function decide(rows: readonly ServiceRow[], bad: Map<string, { kind: string; since: number }>, lastAction: ReadonlyMap<string, number>, now: number, databaseUp: boolean): WatchAction[] {
  const out: WatchAction[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!WATCHED.has(r.service)) continue;
    const down = r.state === "exited" && !DELIBERATE_EXIT.has(r.exitCode);
    const sick = r.state === "running" && r.health === "unhealthy" && (databaseUp || r.service === "postgres");
    if (!down && !sick) continue;
    const kind = down ? "down" : "sick";
    seen.add(r.service);
    const was = bad.get(r.service);
    if (!was || was.kind !== kind) {
      bad.set(r.service, { kind, since: now });
      continue;
    }
    if (now - was.since < GRACE_MS || now - (lastAction.get(r.service) ?? -Infinity) < COOLDOWN_MS) continue;
    out.push(down
      ? { service: r.service, action: "start", why: `exited with code ${r.exitCode} and Docker's restart policy left it down` }
      : { service: r.service, action: "restart", why: "its healthcheck has been failing" });
  }
  for (const k of [...bad.keys()]) if (!seen.has(k)) bad.delete(k);
  return out;
}

export interface WatchdogDeps {
  db: Db;
  probe: Pick<ControlProbe, "databaseOk">;
  log: (line: string) => void;
  exec?: Runner;
  fs?: GuardFs;
  now?: () => number;
}

export function dockerWatchdog(cfg: Pick<StepsConfig, "composeDir">, d: WatchdogDeps) {
  const exec = d.exec ?? run;
  const p = installPaths(cfg.composeDir);
  const bad = new Map<string, { kind: string; since: number }>();
  const lastAction = new Map<string, number>();
  const compose = (args: string[]) => exec("docker", ["compose", "--project-directory", p.dir, "-f", p.compose, "--env-file", p.env, "--env-file", p.releaseEnv, ...args]);
  const busy = async () => {
    const [update, domain] = await Promise.all([
      d.db.releaseUpdate.findFirst({ where: { state: { in: ["running", "waiting"] } }, select: { id: true } }),
      d.db.job.findFirst({ where: { kind: "dashboard_domain_apply", completedAt: null, failedAt: null, lockedUntil: { gt: new Date() } }, select: { id: true } }),
    ]);
    return !!update || !!domain;
  };
  return {
    async tick(): Promise<WatchAction[]> {
      const databaseUp = await d.probe.databaseOk().catch(() => false);
      // With the database down the journal cannot be read, so only the database itself may be touched.
      if (databaseUp && (await busy())) {
        bad.clear();
        return [];
      }
      await checkInstallTree(cfg.composeDir, d.fs);
      const rows = parseComposePs(await compose(["ps", "--all", "--format", "json"]));
      const now = d.now?.() ?? Date.now();
      const actions = decide(databaseUp ? rows : rows.filter((r) => r.service === "postgres"), bad, lastAction, now, databaseUp);
      for (const a of actions) {
        lastAction.set(a.service, now);
        d.log(`watchdog: ${a.action === "start" ? "starting" : "restarting"} ${a.service}: ${a.why}`);
        try {
          await compose(a.action === "start" ? ["start", a.service] : ["restart", "--timeout", "30", a.service]);
        } catch (e) {
          d.log(`watchdog: could not ${a.action} ${a.service}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        await audit(d.db, {
          category: "system", action: "watchdog.recover", verb: `${a.action === "start" ? "started" : "restarted"} the service`,
          targetType: "service", targetId: a.service, targetLabel: a.service, suffix: a.why, actorType: "system", actorName: "Dockify watchdog",
        }).catch(() => undefined);
      }
      return actions;
    },
  };
}
