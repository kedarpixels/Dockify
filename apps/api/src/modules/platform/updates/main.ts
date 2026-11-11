/**
 * The updater sidecar. It holds the Docker socket and the install folder but never the master key,
 * and recreates api, worker and web, never itself. Roles: `updater` (daemon), `updater-refresh`
 * (one-off, recreates the updater after an update), `update <cmd>` (the host CLI).
 */
import { hostname } from "node:os";
import { createDb, type Db, type ReleaseUpdate } from "@dockify/db";
import { decideAuto } from "./policy.ts";
import { chooseRelease } from "./release.ts";
import type { RunResult } from "./runner.ts";
import { buildStatus, checkFeed, readPolicy, ROLLBACK_DAYS, updateEnv } from "./state.ts";
import { dockerSteps, loadStepsConfig, parseReleaseEnv, pruneDumps, refreshUpdater, installPaths, run, type ControlProbe, type StepsConfig } from "./steps.ts";
import { beginApply, beginRollback, claimLaneJob, claimUpdateJob, processJob, schedulerTick, settleOrphans, settleSideEffects, UpdateRefused } from "./engine.ts";
import { runDomainSwitch } from "./domain-switch.ts";
import { dockerWatchdog } from "./watchdog.ts";
import { readFile } from "node:fs/promises";

const POLL_MS = 5000;
const TICK_MS = 60_000;
const holder = `updater:${hostname()}:${process.pid}`;
const log = (l: string) => console.log(`dockify-updater: ${l}`);


export function prismaProbe(db: Db): ControlProbe {
  return {
    async databaseOk() {
      await db.$queryRaw`SELECT 1`;
      return true;
    },
    async databaseBytes() {
      const r = await db.$queryRaw<{ n: bigint }[]>`SELECT pg_database_size(current_database()) AS n`;
      return Number(r[0]?.n ?? 0);
    },
    async busy() {
      const j = await db.job.findFirst({
        where: { kind: { in: ["deploy", "restore", "backup", "restore_test"] }, completedAt: null, failedAt: null, lockedUntil: { gt: new Date() } },
        select: { kind: true },
      });
      return j ? (j.kind === "deploy" ? "a deploy" : j.kind === "backup" ? "a backup" : "a restore") : null;
    },
    async workerSeenAt() {
      return (await db.instance.findUnique({ where: { id: 1 }, select: { workerSeenAt: true } }))?.workerSeenAt ?? null;
    },
  };
}

function stepsFor(db: Db, cfg: StepsConfig) {
  return dockerSteps(cfg, { probe: prismaProbe(db), channel: async () => (await readPolicy(db)).channel });
}

async function ownControlImage(cfg: StepsConfig): Promise<string | null> {
  try {
    return parseReleaseEnv(await readFile(installPaths(cfg.composeDir).releaseEnv, "utf8")).control;
  } catch {
    return null;
  }
}

function afterSettle(db: Db, cfg: StepsConfig, own: string | null) {
  return async (u: ReleaseUpdate, res: RunResult) => {
    await settleSideEffects(db, u, res);
    const to = (u.toImages as { control?: string } | null)?.control;
    // The updater runs the control image too, so it moves to the new one last, from outside itself.
    if (res.outcome === "done" && to && own && to !== own) {
      log("recreating the updater on the new image");
      await refreshUpdater(cfg);
    }
  };
}

async function daemon(): Promise<void> {
  const env = updateEnv();
  const cfg = loadStepsConfig(process.env, env.publicKey);
  const db = createDb();
  const steps = stepsFor(db, cfg);
  const own = await ownControlImage(cfg);
  let stop = false;
  for (const s of ["SIGTERM", "SIGINT"] as const) process.once(s, () => { stop = true; });

  let lastTick = 0;
  let lastPrune = 0;
  const watchdog = process.env.DOCKIFY_WATCHDOG?.trim() === "off" ? null : dockerWatchdog(cfg, { db, probe: prismaProbe(db), log });
  const orphans = new Map<string, number>();
  while (!stop) {
    if (Date.now() - lastTick >= TICK_MS) {
      lastTick = Date.now();
      // Before the watchdog: it sits out while a row says running, so a stuck row would turn it off too.
      await settleOrphans({ db, log }, orphans).catch((e: unknown) => log(`could not check for stuck updates: ${String(e)}`));
      await watchdog?.tick().catch((e: unknown) => log(`watchdog failed: ${String(e)}`));
      await schedulerTick({ db, env, log }).then((r) => r !== "idle" && r !== "unconfigured" && log(`scheduler: ${r}`)).catch((e: unknown) => log(`scheduler failed: ${String(e)}`));
      if (Date.now() - lastPrune >= 24 * 3_600_000) {
        lastPrune = Date.now();
        const keep = new Set((await db.releaseUpdate.findMany({ where: { dumpBackupId: { not: null }, startedAt: { gte: new Date(Date.now() - (ROLLBACK_DAYS + 1) * 86_400_000) } }, select: { dumpBackupId: true } }).catch(() => [])).map((r) => r.dumpBackupId!));
        const n = await pruneDumps(cfg.backupDir, keep, new Date(Date.now() - (ROLLBACK_DAYS + 1) * 86_400_000)).catch(() => 0);
        if (n) log(`removed ${n} pre-update dumps older than ${ROLLBACK_DAYS + 1} days`);
      }
    }
    const domainJob = await claimLaneJob(db, holder, "dashboard_domain_apply").catch(() => null);
    if (domainJob) {
      const out = await runDomainSwitch({ db, steps, exec: run, cfg, probe: prismaProbe(db), log }, domainJob, holder).catch((e: unknown) => `failed: ${String(e)}`);
      log(`dashboard domain job ${domainJob.id}: ${out}`);
      continue;
    }
    const job = await claimUpdateJob(db, holder).catch(() => null);
    if (!job) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    const res = await processJob({ db, steps, holder, log, afterSettle: afterSettle(db, cfg, own) }, job);
    log(`job ${job.id}: ${res.outcome}${res.error ? ` (${res.error})` : ""}`);
  }
  await db.$disconnect();
}

async function refresh(): Promise<void> {
  const env = updateEnv();
  const cfg = loadStepsConfig(process.env, env.publicKey);
  const p = installPaths(cfg.composeDir);
  const { checkInstallTree } = await import("./steps.ts");
  await checkInstallTree(cfg.composeDir);
  await run("docker", ["compose", "--project-directory", p.dir, "-f", p.compose, "--env-file", p.env, "--env-file", p.releaseEnv, "up", "-d", "--no-deps", "--force-recreate", "updater"]);
}

const print = (s: string) => process.stdout.write(`${s}\n`);

async function follow(db: Db, id: string): Promise<ReleaseUpdate | null> {
  const seen = new Map<string, string>();
  for (;;) {
    const u = await db.releaseUpdate.findUnique({ where: { id } }).catch(() => null);
    if (u) {
      for (const s of (u.steps as Array<{ id: string; status: string; detail: string | null }>) ?? []) {
        const key = `${s.status}:${s.detail ?? ""}`;
        if (seen.get(s.id) !== key && s.status !== "pending") print(`  ${s.id.padEnd(12)} ${s.status}${s.detail ? `  ${s.detail}` : ""}`);
        seen.set(s.id, key);
      }
      if (u.state !== "running" && u.state !== "waiting") return u;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** Runs the job right here (a one-off updater container), or follows the daemon if it claimed it first. */
async function runHere(db: Db, cfg: StepsConfig, row: ReleaseUpdate): Promise<number> {
  const job = await db.job.findFirst({ where: { kind: "self_update", completedAt: null, failedAt: null, payload: { path: ["updateId"], equals: row.id } }, select: { id: true } });
  const claimed = job ? await claimUpdateJob(db, `cli:${holder}`, job.id) : null;
  let settled: ReleaseUpdate | null;
  if (claimed) {
    const own = await ownControlImage(cfg);
    for (;;) {
      const res = await processJob({ db, steps: stepsFor(db, cfg), holder: `cli:${holder}`, log: print, afterSettle: afterSettle(db, cfg, own) }, claimed);
      if (res.outcome !== "waiting") break;
      print(`  waiting: ${res.error ?? "the server is busy"}; retrying in 60 s`);
      await new Promise((r) => setTimeout(r, 60_000));
      if (!(await claimUpdateJob(db, `cli:${holder}`, claimed.id))) break;
    }
    settled = await db.releaseUpdate.findUnique({ where: { id: row.id } });
  } else {
    print("the updater service picked this job up; following it");
    settled = await follow(db, row.id);
  }
  print(settled ? `${settled.state}: ${settled.fromVersion} -> ${settled.version}${settled.error ? `\n  ${settled.error}` : ""}` : "the update row disappeared");
  return settled?.state === "done" ? 0 : 1;
}

async function cli(args: string[]): Promise<number> {
  const [cmd, arg] = args;
  const env = updateEnv();
  const db = createDb();
  try {
    if (cmd === "status" || cmd === undefined) {
      const s = await buildStatus(db, env);
      print(`Dockify ${s.current} on the ${s.channel} channel; policy ${s.policy.mode}${s.policy.window ? `, window ${s.policy.window.start} to ${s.policy.window.end} ${s.policy.timeZone}` : ", any time"}`);
      print(`last check ${s.checkedAt ?? "never"}${s.checkError ? ` (failed: ${s.checkError})` : ""}`);
      print(s.latest ? `available: ${s.latest.version}${s.latest.critical ? " (security release)" : ""}` : "no newer release");
      if (s.security) {
        print(`security release ${s.security.version}, ${s.security.level}${s.security.cves.length ? `, ${s.security.cves.join(" ")}` : ""}: ${s.security.summary}`);
        if (s.security.advisory) print(`  advisory: ${s.security.advisory}`);
      }
      if (s.blocked) print(`newer: ${s.blocked.version} needs ${s.blocked.minFrom} first`);
      if (s.job) print(`last update: ${s.job.from} -> ${s.job.version}, ${s.job.state}${s.job.error ? `: ${s.job.error}` : ""}`);
      if (s.rollback) print(`can roll back to ${s.rollback.version} until ${s.rollback.until} (update id ${s.rollback.updateId})`);
      return 0;
    }
    if (cmd === "check") {
      const feed = await checkFeed(db, env);
      const offer = chooseRelease(feed, (await buildStatus(db, env)).current);
      print(`verified the ${feed.channel} feed (sha256 ${feed.sha256.slice(0, 16)}, generated ${feed.generatedAt})`);
      print(offer.target ? `available: ${offer.target.version}${offer.critical ? " (security release)" : ""}` : "you run the newest release you can install");
      if (offer.target) print(`automatic install: ${decideAuto(new Date(), await readPolicy(db), offer).reason}`);
      return 0;
    }
    const cfg = loadStepsConfig(process.env, env.publicKey);
    if (cmd === "apply") {
      let version = arg;
      if (!version) {
        const feed = await checkFeed(db, env);
        version = chooseRelease(feed, (await buildStatus(db, env)).current).target?.version;
        if (!version) {
          print("nothing to install");
          return 0;
        }
      }
      const row = await db.$transaction((tx) => beginApply(tx, env, { version: version!, trigger: "cli", actorName: "dockify update (host)" }));
      print(`updating ${row.fromVersion} -> ${row.version}`);
      return await runHere(db, cfg, row);
    }
    if (cmd === "rollback") {
      const target = arg ?? (await buildStatus(db, env)).rollback?.updateId;
      if (!target) {
        print(`nothing to roll back: only the last update within ${ROLLBACK_DAYS} days can be`);
        return 1;
      }
      const row = await db.$transaction((tx) => beginRollback(tx, env, { updateId: target, trigger: "cli", actorName: "dockify update (host)" }));
      print(`rolling back ${row.fromVersion} -> ${row.version} (restores the dump taken before that update)`);
      return await runHere(db, cfg, row);
    }
    print("usage: dockify update status | check | apply [version] | rollback [update-id]");
    return 64;
  } catch (e) {
    print(`error: ${e instanceof UpdateRefused ? e.message : e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

const role = process.argv[2] ?? "daemon";
if (role === "daemon") await daemon();
else if (role === "refresh") await refresh();
else if (role === "cli") process.exitCode = await cli(process.argv.slice(3));
else {
  console.error(`unknown updater role: ${role}`);
  process.exitCode = 64;
}
