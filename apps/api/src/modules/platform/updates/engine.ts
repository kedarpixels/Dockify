/**
 * The update engine: the `update` job lane, leased, claimed only by the updater sidecar (and by
 * the `dockify update` CLI, which runs one job in a one-off updater container). The api enqueues;
 * the scheduler tick here checks the feed every 6 hours with jitter and enqueues automatic
 * installs in the maintenance window.
 *
 * Lease: a claim holds the job for LEASE_SECONDS and a heartbeat renews it while the job runs. If
 * the updater dies, the next claimant takes the job over once the lease lapses and resumes the
 * journal from its recorded phase (runner.ts). A job may be taken over MAX_ATTEMPTS times.
 */
import { defaultServerId, enqueue, enqueueTx, type Db, type Prisma, type ReleaseUpdate } from "@dockify/db";

type Tx = Prisma.TransactionClient;
import { audit } from "../../../audit.ts";
import { decideAuto } from "./policy.ts";
import { archOf, bare, chooseRelease, imagesFor, pendingSecurity, type Fetcher, type Images, type PendingSecurity, type VerifiedFeed } from "./release.ts";
import { runUpdate, type Journal, type RunResult, type StepId, type UpdateRecorder, type UpdateSteps } from "./runner.ts";
import { checkFeed, currentVersion, journalOf, newJournal, pickStored, readPolicy, ROLLBACK_DAYS, rollbackTarget, rowOf, storedFeed, type UpdateEnv } from "./state.ts";

export const LEASE_SECONDS = 120;
export const HEARTBEAT_MS = 30_000;
export const MAX_ATTEMPTS = 3;
export const WAIT_RETRY_MS = 60_000;
export const UPDATE_DEDUPE_KEY = "self_update";

/** The job payload. Everything else lives in the release_updates row (the journal). */
export interface SelfUpdatePayload {
  updateId: string;
}

export type Trigger = "manual" | "auto" | "cli";

// ------------------------------------------------------------------ enqueueing (api, scheduler, CLI)

export class UpdateRefused extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export async function lockUpdates(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dockify.update'))`;
}

export interface StartInput {
  kind: "update" | "rollback";
  trigger: Trigger;
  actorName: string | null;
  from: string;
  version: string;
  manifestSha256: string | null;
  toImages?: Images | null;
  fromImages?: Images | null;
  rollbackOfId?: string | null;
  now?: Date;
}

/** Creates the journal row and its job in one transaction. Refuses while another update is live. */
export async function startUpdateTx(tx: Tx, input: StartInput): Promise<ReleaseUpdate> {
  await lockUpdates(tx);
  if (await tx.releaseUpdate.findFirst({ where: { state: { in: ["running", "waiting"] } }, select: { id: true } })) {
    throw new UpdateRefused("An update is already running", "UPDATE_RUNNING");
  }
  const now = input.now ?? new Date();
  const id = crypto.randomUUID();
  const j = newJournal({ id, kind: input.kind, from: input.from, version: input.version, manifestSha256: input.manifestSha256, toImages: input.toImages ?? null, fromImages: input.fromImages ?? null, rollbackOfId: input.rollbackOfId ?? null, now });
  const row = await tx.releaseUpdate.create({ data: { id, ...rowOf(j, { trigger: input.trigger, actorName: input.actorName }) } });
  const payload: SelfUpdatePayload = { updateId: id };
  await enqueueTx(tx, { kind: "self_update", lane: "update", payload: { ...payload }, dedupeKey: UPDATE_DEDUPE_KEY, maxAttempts: MAX_ATTEMPTS });
  return row;
}

// ------------------------------------------------------------------ claiming

export interface Claimed {
  id: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

/** Claims the oldest runnable update job (or exactly `jobId`), taking over a lapsed lease. */
export async function claimUpdateJob(db: Db, holder: string, jobId?: string): Promise<Claimed | null> {
  return claimLaneJob(db, holder, "self_update", jobId);
}

/** The same claim for any job kind on the update lane. */
export async function claimLaneJob(db: Db, holder: string, kind: "self_update" | "dashboard_domain_apply", jobId?: string): Promise<Claimed | null> {
  const rows = jobId
    ? await db.$queryRaw<Claimed[]>`
        UPDATE jobs SET attempts = attempts + 1,
          "lockedUntil" = now() + ${LEASE_SECONDS}::double precision * interval '1 second', "lockedBy" = ${holder}
        WHERE id = ${jobId}::uuid AND lane = 'update'::"JobLane" AND "completedAt" IS NULL AND "failedAt" IS NULL
          AND ("lockedUntil" IS NULL OR "lockedUntil" < now())
        RETURNING id, payload, attempts, "maxAttempts"`
    : await db.$queryRaw<Claimed[]>`
        UPDATE jobs SET attempts = attempts + 1,
          "lockedUntil" = now() + ${LEASE_SECONDS}::double precision * interval '1 second', "lockedBy" = ${holder}
        WHERE id = (
          SELECT id FROM jobs
          WHERE lane = 'update'::"JobLane" AND kind = ${kind}::"JobKind" AND "completedAt" IS NULL AND "failedAt" IS NULL
            AND "runAfter" <= now() AND ("lockedUntil" IS NULL OR "lockedUntil" < now())
          ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, payload, attempts, "maxAttempts"`;
  return rows[0] ?? null;
}

/** Renews the lease while the job runs. A restore that rewound the jobs table simply finds no row. */
export function heartbeat(db: Db, jobId: string, holder: string, every = HEARTBEAT_MS): () => void {
  const t = setInterval(() => {
    void db.$executeRaw`UPDATE jobs SET "lockedUntil" = now() + ${LEASE_SECONDS}::double precision * interval '1 second'
      WHERE id = ${jobId}::uuid AND "lockedBy" = ${holder} AND "completedAt" IS NULL AND "failedAt" IS NULL`.catch(() => undefined);
  }, every);
  t.unref?.();
  return () => clearInterval(t);
}

// ------------------------------------------------------------------ recording

const STEP_LABEL: Record<StepId, string> = {
  preflight: "preflight checks", pull: "pull and verify the signed images", backup: "back up the control-plane database",
  migrate: "run migrations", swap_api: "swap the api", swap_worker: "swap the worker", swap_web: "swap the web",
  health: "health checks", rollback: "roll back",
};

/**
 * Writes the journal with an upsert after every transition and one audit row per step. Around a
 * dump restore it keeps the update history: release_updates rows and the update audit rows are
 * read before the restore and written back after, so the record of what happened survives the
 * database going back in time. The running job comes back with them, still leased to its holder:
 * RESTORE_SCRIPT closes every update job in the dump, and a rollback's own job is newer than the dump,
 * but minutes of swaps are still to come and a crash during them must leave a job to take over.
 */
export function dbRecorder(db: Db, meta: { trigger: Trigger; actorName: string | null; lease?: { job: Claimed; holder: string } }, log: (l: string) => void = (l) => console.log(`dockify-updater: ${l}`), now: () => Date = () => new Date()): UpdateRecorder {
  let kept: { updates: ReleaseUpdate[]; activity: Prisma.ActivityLogCreateManyInput[] } | null = null;
  const actor = { actorType: "system" as const, actorId: null, actorName: meta.trigger === "auto" ? "Automatic updates" : (meta.actorName ?? "dockify update") };
  const saveTo = async (client: Db | Tx, j: Journal) => {
    const data = rowOf(j, meta);
    await client.releaseUpdate.upsert({ where: { id: j.id }, update: data, create: { id: j.id, ...data } });
  };
  const save = (j: Journal) => saveTo(db, j);
  return {
    save,
    async audit(j, step, status, detail) {
      await audit(db, {
        category: "system",
        action: `update.${step}`,
        verb: status === "failed" ? `failed to ${STEP_LABEL[step]} for` : status === "skipped" ? `skipped ${STEP_LABEL[step]} for` : `completed ${STEP_LABEL[step]} for`,
        targetType: "release",
        targetId: j.id,
        targetLabel: j.version,
        suffix: detail ? detail.slice(0, 300) : `attempt ${j.attempt}`,
        failed: status === "failed",
        ...actor,
      }).catch((e: unknown) => log(`audit write failed: ${String(e)}`));
    },
    async beforeRestore() {
      const since = new Date(Date.now() - (ROLLBACK_DAYS + 1) * 86_400_000);
      const [updates, activity] = await Promise.all([
        db.releaseUpdate.findMany({ where: { startedAt: { gte: since } } }),
        db.activityLog.findMany({ where: { category: "system", action: { startsWith: "update." }, at: { gte: since } } }),
      ]);
      kept = { updates, activity: activity.map((a) => ({ ...a, changes: (a.changes ?? undefined) as Prisma.InputJsonValue | undefined })) };
      // pg_restore drops the schema under every connection; this one reconnects after.
      await db.$disconnect();
    },
    async afterRestore(j) {
      if (kept) {
        for (const u of kept.updates) {
          if (u.id === j.id) continue;
          const { id, ...rest } = u;
          const data = { ...rest, fromImages: (rest.fromImages ?? undefined) as Prisma.InputJsonValue | undefined, toImages: (rest.toImages ?? undefined) as Prisma.InputJsonValue | undefined, steps: rest.steps as Prisma.InputJsonValue };
          await db.releaseUpdate.upsert({ where: { id }, update: data, create: { id, ...data } });
        }
        if (kept.activity.length) await db.activityLog.createMany({ data: kept.activity, skipDuplicates: true });
        kept = null;
      }
      await db.$transaction(async (tx) => {
        await saveTo(tx, j);
        if (!meta.lease) return;
        const { job, holder } = meta.lease;
        const lease = { lockedBy: holder, lockedUntil: new Date(Date.now() + LEASE_SECONDS * 1000), attempts: job.attempts, completedAt: null, failedAt: null };
        await tx.job.upsert({
          where: { id: job.id },
          update: lease,
          create: { id: job.id, kind: "self_update", lane: "update", payload: job.payload as Prisma.InputJsonValue, dedupeKey: UPDATE_DEDUPE_KEY, maxAttempts: job.maxAttempts, ...lease },
        });
      });
    },
    async finish(version, skipVersion) {
      await db.instance.update({ where: { id: 1 }, data: { releaseVersion: version, ...(skipVersion ? { updateSkipVersion: skipVersion } : {}) } });
    },
    log,
    now,
  };
}

// ------------------------------------------------------------------ running one job

export interface ProcessDeps {
  db: Db;
  steps: UpdateSteps;
  holder: string;
  log?: (l: string) => void;
  now?: () => Date;
  /** After a job settles: the offsite copy, notifications, and recreating the updater itself. */
  afterSettle?: (row: ReleaseUpdate, res: RunResult) => Promise<void>;
  heartbeatMs?: number;
}

/** Runs one claimed job to its next stop: settled, or waiting for a busy server. Idempotent on takeover. */
export async function processJob(d: ProcessDeps, job: Claimed): Promise<RunResult> {
  const { db } = d;
  const p = job.payload as Partial<SelfUpdatePayload> | null;
  const row = p?.updateId ? await db.releaseUpdate.findUnique({ where: { id: p.updateId } }) : null;
  if (!row) {
    await db.job.updateMany({ where: { id: job.id }, data: { failedAt: new Date(), lockedUntil: null, lastError: "the update row is missing" } });
    return { outcome: "failed", error: "the update row is missing" };
  }
  const j = journalOf(row);
  const live = j.state === "running" || j.state === "waiting";
  if (live) j.attempt = Math.max(j.attempt, job.attempts);
  const rec = dbRecorder(db, { trigger: row.trigger, actorName: row.actorName, lease: { job, holder: d.holder } }, d.log, d.now);

  // A takeover past the attempt cap does not run again blind: it settles through a rollback.
  if (live && job.attempts > job.maxAttempts) {
    j.error = `the updater stopped ${job.maxAttempts} times during ${j.phase}`;
    // The backup step stops api and worker before there is a dump: they still have to come back.
    if (j.dumpBackupId || j.phase === "backup") j.phase = "rollback";
    else {
      j.state = "failed";
      j.finishedAt = new Date();
      j.error += ". Nothing was changed.";
      // run() returns at once for a settled state, and a row left running blocks every later update.
      await rec.save(j);
    }
  }

  const restoreTarget = j.kind === "rollback" && j.rollbackOfId
    ? await db.releaseUpdate.findUnique({ where: { id: j.rollbackOfId }, select: { dumpBackupId: true, dumpSha256: true } }).then((t) => (t?.dumpBackupId && t.dumpSha256 ? { id: t.dumpBackupId, sha256: t.dumpSha256 } : null))
    : null;

  const stop = heartbeat(db, job.id, d.holder, d.heartbeatMs);
  let res: RunResult;
  try {
    res = await runUpdate(j, d.steps, rec, { restoreTarget });
  } catch (e) {
    res = { outcome: "failed", error: e instanceof Error ? e.message : String(e) };
  } finally {
    stop();
  }

  if (res.outcome === "waiting") {
    // Not an attempt: the next claim is a fresh look at a server that was busy.
    await db.job.updateMany({ where: { id: job.id }, data: { lockedUntil: null, lockedBy: null, attempts: { decrement: 1 }, runAfter: new Date(Date.now() + WAIT_RETRY_MS), lastError: res.error ?? "waiting" } });
    return res;
  }
  const now = new Date();
  // updateMany: a restored dump may predate this job's row; there is then nothing to settle.
  await db.job.updateMany({
    where: { id: job.id },
    data: res.outcome === "done" ? { completedAt: now, lockedUntil: null } : { failedAt: now, lockedUntil: null, lastError: (res.error ?? res.outcome).slice(0, 500) },
  });
  const settled = await db.releaseUpdate.findUnique({ where: { id: j.id } });
  if (settled && d.afterSettle) await d.afterSettle(settled, res).catch((e: unknown) => d.log?.(`after-settle failed: ${String(e)}`));
  return res;
}

// ------------------------------------------------------------------ notifications and the offsite copy

export type NotifyEvent = "available" | "updated" | "failed" | "rolled_back";

export interface UpdateNotifyPayload {
  event: NotifyEvent;
  version: string;
  from: string | null;
  error: string | null;
  updateId: string | null;
}

/** One Discord and email delivery, by the worker (it holds the vault). The bell reads the rows. */
export async function enqueueNotify(db: Db, p: UpdateNotifyPayload): Promise<void> {
  await enqueue(db, {
    kind: "update_notify",
    lane: "maintenance",
    payload: { ...p },
    dedupeKey: `update_notify:${p.event}:${p.updateId ?? p.version}`,
    maxAttempts: 5,
  });
}

/** The security_notify job: one email to every admin about a newly seen security release (worker, security-notify.ts). */
export interface SecurityNotifyPayload extends PendingSecurity {
  /** The version this install ran when the updater first saw the release. */
  current: string;
}

/**
 * Records that the admins were told about `sec` and queues their email, in one transaction, so a
 * crash between the two neither loses the email nor sends it twice. The bell needs no delivery:
 * the api derives its notice from the stored feed (notices.ts).
 */
export async function noteSecurityRelease(db: Db, sec: PendingSecurity, current: string): Promise<void> {
  const payload: SecurityNotifyPayload = { ...sec, current: bare(current) };
  await db.$transaction(async (tx) => {
    await tx.instance.update({ where: { id: 1 }, data: { securityNoticeVersion: sec.version } });
    await enqueueTx(tx, { kind: "security_notify", lane: "maintenance", payload: { ...payload }, dedupeKey: `security_notify:${sec.version}`, maxAttempts: 5 });
  });
}

/** The nil uuid stands for "the control plane" where a backup row needs an app id. */
export const CONTROL_PLANE_SOURCE = "00000000-0000-0000-0000-000000000000";

/**
 * Once the stack is back, the pre-update dump goes to the backup destination too: a Backup row
 * with the dump's id, copied (encrypted, like every backup) by the worker from the shared volume.
 */
export async function enqueueOffsiteCopy(db: Db, u: ReleaseUpdate): Promise<void> {
  if (!u.dumpBackupId || !u.dumpSha256) return;
  if (await db.backup.findUnique({ where: { id: u.dumpBackupId }, select: { id: true } })) return;
  const dest = await db.backupDestination.findFirst({ where: { isDefault: true }, select: { id: true } });
  await db.$transaction(async (tx) => {
    await tx.backup.create({
      data: {
        id: u.dumpBackupId!,
        sourceAppId: CONTROL_PLANE_SOURCE,
        appSnapshot: { name: "Dockify control plane", kind: "control_plane", projectSlug: "dockify", environment: "control plane", updateId: u.id, dumpSha256: u.dumpSha256 },
        kind: "control_plane",
        trigger: "pre_update",
        status: "running",
        destinationId: dest?.id ?? null,
        encrypted: true,
      },
    });
    await enqueueTx(tx, { kind: "backup", lane: "data", serverId: await defaultServerId(tx), payload: { backupId: u.dumpBackupId! }, dedupeKey: `backup:${u.dumpBackupId}`, maxAttempts: 5 });
  });
}

/** The default after-settle: audit the outcome, copy the dump offsite, notify. */
export async function settleSideEffects(db: Db, u: ReleaseUpdate, res: RunResult): Promise<void> {
  const label = u.kind === "rollback" ? "rolled back to" : "updated to";
  await audit(db, {
    category: "system",
    action: u.kind === "rollback" ? "update.rollback" : "update.finish",
    verb: res.outcome === "done" ? label : res.outcome === "rolled_back" ? "rolled back the update to" : "failed the update to",
    targetType: "release",
    targetId: u.id,
    targetLabel: u.version,
    suffix: res.outcome === "done" ? `from ${u.fromVersion}` : (res.error ?? "").slice(0, 300),
    failed: res.outcome !== "done",
    actorType: "system",
    actorName: u.trigger === "auto" ? "Automatic updates" : (u.actorName ?? "dockify update"),
  });
  await enqueueOffsiteCopy(db, u);
  const event: NotifyEvent = res.outcome === "done" ? "updated" : res.outcome === "rolled_back" ? "rolled_back" : "failed";
  await enqueueNotify(db, { event, version: u.version, from: u.fromVersion, error: res.error ?? null, updateId: u.id });
}

// ------------------------------------------------------------------ the scheduler tick

export interface TickDeps {
  db: Db;
  env: UpdateEnv;
  fetcher?: Fetcher;
  now?: Date;
  log?: (l: string) => void;
}

/**
 * Every minute in the updater: check the feed when it is due (6 hours plus jitter), notify once per
 * new version, email every admin once per new security release, and enqueue an automatic install
 * when the policy and the window say so. Returns what it did, for the log and the tests.
 */
export async function schedulerTick(d: TickDeps): Promise<"unconfigured" | "idle" | "notified" | "installing" | "waiting" | "check-failed"> {
  const { db, env } = d;
  const now = d.now ?? new Date();
  if (!env.feedBase || !env.publicKey) return "unconfigured";
  const inst = await db.instance.findUnique({
    where: { id: 1 },
    select: { updateNextCheckAt: true, latestRelease: true, updateNotifiedVersion: true, securityNoticeVersion: true, setupCompletedAt: true },
  });
  if (!inst?.setupCompletedAt) return "idle";

  let feed = storedFeed(inst.latestRelease);
  const policy = await readPolicy(db);
  const check = async (): Promise<VerifiedFeed | null> => {
    try {
      return await checkFeed(db, env, d.fetcher, now);
    } catch (e) {
      d.log?.(`check failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };
  const due = !inst.updateNextCheckAt || inst.updateNextCheckAt <= now || !feed || feed.channel !== policy.channel;
  if (due) feed = await check();
  if (!feed) return "check-failed";
  const current = await currentVersion(db, env);
  const offer = chooseRelease(feed, current);

  let did: "idle" | "notified" = "idle";
  // The first sight of a security release (from the signed feed only) emails every admin once,
  // even when no release can be installed straight away.
  const sec = pendingSecurity(feed, current);
  if (sec && bare(inst.securityNoticeVersion ?? "") !== sec.version) {
    await noteSecurityRelease(db, sec, current);
    did = "notified";
  }
  if (!offer.target) return did;

  if (inst.updateNotifiedVersion !== offer.target.version) {
    await db.instance.update({ where: { id: 1 }, data: { updateNotifiedVersion: offer.target.version } });
    await enqueueNotify(db, { event: "available", version: offer.target.version, from: current, error: null, updateId: null });
    did = "notified";
  }

  const decision = decideAuto(now, policy, offer);
  if (decision.action !== "install") return decision.action === "wait" ? "waiting" : did;
  // A version that already failed or rolled back here, whoever started it, is not retried on its own.
  const tried = await db.releaseUpdate.findFirst({ where: { version: offer.target.version, kind: "update", state: { in: ["failed", "rolled_back"] } }, select: { id: true } });
  if (tried) return did;
  // The stored feed can be hours old, and resolve() refuses a feed that changed since the approval:
  // the failure would then block this version for good. Start from the feed as it is now.
  if (!due) {
    feed = await check();
    if (!feed) return "check-failed";
    if (chooseRelease(feed, current).target?.version !== offer.target.version) return did;
  }
  const manifestSha256 = feed.sha256;
  try {
    await db.$transaction((tx) =>
      startUpdateTx(tx, { kind: "update", trigger: "auto", actorName: null, from: current, version: offer.target!.version, manifestSha256, now }),
    );
  } catch (e) {
    if (e instanceof UpdateRefused) return did;
    throw e;
  }
  d.log?.(`automatic install of ${offer.target.version}: ${decision.reason}`);
  return "installing";
}

// ------------------------------------------------------------------ a live row with no job

/**
 * Settles a journal row that says running with no open job behind it: nothing would ever finish it,
 * and it blocks every later update and the watchdog. It takes a crash in the moment between a restore
 * and its job coming back, or a row an older updater left stuck. It is settled, never replayed: the
 * row may be days old, and repeating its restore would discard everything since. `seen` holds when
 * each row was first found so, because a run with a live process crosses that moment in a second.
 */
export async function settleOrphans(d: { db: Db; log?: (l: string) => void; now?: Date }, seen: Map<string, number>): Promise<number> {
  const { db } = d;
  const now = d.now ?? new Date();
  const live = await db.releaseUpdate.findMany({ where: { state: { in: ["running", "waiting"] } } });
  let settled = 0;
  for (const row of live) {
    const open = await db.job.findFirst({ where: { kind: "self_update", completedAt: null, failedAt: null, payload: { path: ["updateId"], equals: row.id } }, select: { id: true } });
    if (open) {
      seen.delete(row.id);
      continue;
    }
    const first = seen.get(row.id) ?? now.getTime();
    seen.set(row.id, first);
    if (now.getTime() - first < LEASE_SECONDS * 1000) continue;
    seen.delete(row.id);
    const j = journalOf(row);
    j.state = "failed";
    j.finishedAt = now;
    j.error = `${j.error ? `${j.error}; ` : ""}the updater lost this ${j.kind} during ${j.phase} and cannot resume it. Run: sudo dockify redeploy, then check the version it reports.`.slice(0, 500);
    await dbRecorder(db, { trigger: row.trigger, actorName: row.actorName }, d.log).save(j);
    await settleSideEffects(db, { ...row, state: "failed", error: j.error, finishedAt: now }, { outcome: "failed", error: j.error }).catch((e: unknown) => d.log?.(`after-settle failed: ${String(e)}`));
    d.log?.(`settled update ${row.id}: ${j.error}`);
    settled++;
  }
  return settled;
}

// ------------------------------------------------------------------ starting an update or a rollback

/** Validates `version` against the stored, verified feed and starts it. Shared by the api and the CLI. */
export async function beginApply(tx: Tx, env: UpdateEnv, input: { version: string; trigger: Trigger; actorName: string | null }): Promise<ReleaseUpdate> {
  await lockUpdates(tx);
  const inst = await tx.instance.findUnique({ where: { id: 1 }, select: { latestRelease: true, updateChannel: true } });
  const feed = storedFeed(inst?.latestRelease);
  if (feed && inst && feed.channel !== inst.updateChannel) throw new UpdateRefused("The channel changed since the last check. Check for updates first.", "UPDATE_NOT_VERIFIED");
  const current = await currentVersion(tx, env);
  const picked = pickStored(feed, input.version, current);
  if ("refused" in picked) throw new UpdateRefused(picked.refused, /downgrade|not newer/i.test(picked.refused) ? "UPDATE_NOT_NEWER" : /upgrades only/.test(picked.refused) ? "UPDATE_UNSUPPORTED_PATH" : "UPDATE_NOT_VERIFIED");
  return startUpdateTx(tx, { kind: "update", trigger: input.trigger, actorName: input.actorName, from: current, version: picked.rel.version, manifestSha256: feed!.sha256 });
}

/** Starts a rollback of `updateId`: its pre-update dump and its previous images. Last good version only, within 7 days. */
export async function beginRollback(tx: Tx, env: UpdateEnv, input: { updateId: string; trigger: Trigger; actorName: string | null; now?: Date }): Promise<ReleaseUpdate> {
  await lockUpdates(tx);
  const rows = await tx.releaseUpdate.findMany({ orderBy: { startedAt: "desc" }, take: 50 });
  const current = await currentVersion(tx, env);
  const target = rollbackTarget(rows, current, input.now ?? new Date());
  if (!target || target.updateId !== input.updateId) {
    throw new UpdateRefused(`Only the last update, within ${ROLLBACK_DAYS} days and with its pre-update dump, can be rolled back`, "ROLLBACK_UNAVAILABLE");
  }
  const u = rows.find((r) => r.id === input.updateId)!;
  // The recorded fromImages is a DB field, so a tampered row could pin an attacker image through
  // the updater (which holds docker.sock). Pin the signed feed's own digests for that version
  // instead, and refuse if the version is no longer verifiable.
  const inst = await tx.instance.findFirst({ select: { latestRelease: true } });
  const rel = storedFeed(inst?.latestRelease)?.releases.find((r) => bare(r.version) === bare(u.fromVersion));
  if (!rel) {
    throw new UpdateRefused(`Cannot roll back to ${u.fromVersion}: it is no longer in the verified release feed. Check for updates first.`, "ROLLBACK_UNVERIFIED");
  }
  const images = imagesFor(rel, archOf());
  const prev = u.fromImages as unknown as Images;
  if (prev.control !== images.control || prev.web !== images.web) {
    throw new UpdateRefused("The recorded rollback images do not match the signed release feed", "ROLLBACK_IMAGE_MISMATCH");
  }
  return startUpdateTx(tx, {
    kind: "rollback", trigger: input.trigger, actorName: input.actorName, from: current, version: u.fromVersion,
    manifestSha256: null, toImages: images, rollbackOfId: u.id, now: input.now,
  });
}
