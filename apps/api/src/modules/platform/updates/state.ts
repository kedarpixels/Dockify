/**
 * The update state in the database, shared by the api handlers and the updater: the stored policy,
 * the verified feed, the journal rows and the status the dashboard reads.
 */
import type { Db, Prisma, ReleaseUpdate, Tx } from "@dockify/db";
import { isTimeZone, runningVersion } from "@dockify/contracts";
import { decideAuto, DEFAULT_WINDOW, minutesOf, nextCheckAt, type UpdatePolicy, type UpdateWindow } from "./policy.ts";
import { bare, chooseRelease, trustedKey, compareVersions, FeedRelease, fetchVerifiedFeed, pendingSecurity, ReleaseFeed, securityInfo, type Channel, type Fetcher, type Images, type VerifiedFeed } from "./release.ts";
import { SignatureError } from "./minisign.ts";
import { plannedSteps, type Journal, type StepId, type StepRow } from "./runner.ts";

/** Updates kept rollback-able: the last good version within this many days, its dump still on disk. */
export const ROLLBACK_DAYS = 7;

export interface UpdateEnv {
  version: string;
  feedBase: string | null;
  publicKey: string | null;
}

/**
 * The updater's view of the update settings. Its version is its image's own (runningVersion): the
 * updater rewrites only release.env, so .env's DOCKIFY_VERSION still names the version before the
 * last in-app update, and reading it would offer that update again or misjudge minFrom.
 */
export function updateEnv(env: NodeJS.ProcessEnv = process.env): UpdateEnv {
  return { version: runningVersion(env), feedBase: env.DOCKIFY_RELEASE_FEED?.trim() || null, publicKey: trustedKey(env) };
}

type Client = Db | Tx;

// ------------------------------------------------------------------ policy

export function parseWindow(raw: unknown): UpdateWindow | null {
  if (raw === null) return null;
  const w = raw as Partial<UpdateWindow> | undefined;
  if (!w || !Array.isArray(w.days) || typeof w.start !== "string" || typeof w.end !== "string") return DEFAULT_WINDOW;
  try {
    minutesOf(w.start);
    minutesOf(w.end);
  } catch {
    return DEFAULT_WINDOW;
  }
  const days = [...new Set(w.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  return { days, start: w.start, end: w.end };
}

export interface StoredPolicy extends UpdatePolicy {
  channel: Channel;
}

export async function readPolicy(db: Client): Promise<StoredPolicy> {
  const i = await db.instance.findUnique({
    where: { id: 1 },
    select: { updateMode: true, updateChannel: true, updateWindow: true, updateTimeZone: true, updateSkipVersion: true, updatePausedUntil: true },
  });
  return {
    mode: i?.updateMode ?? "all",
    channel: i?.updateChannel ?? "stable",
    window: parseWindow(i ? i.updateWindow : DEFAULT_WINDOW),
    timeZone: i && isTimeZone(i.updateTimeZone) ? i.updateTimeZone : "Etc/UTC",
    skipVersion: i?.updateSkipVersion ?? null,
    pausedUntil: i?.updatePausedUntil ?? null,
  };
}

/** The verified feed stored by the last check, re-validated; only a verified feed is ever written. */
export function storedFeed(raw: unknown): VerifiedFeed | null {
  if (!raw || typeof raw !== "object") return null;
  const { sha256, ...rest } = raw as Record<string, unknown>;
  const m = ReleaseFeed.safeParse(rest);
  return m.success && typeof sha256 === "string" && /^[a-f0-9]{64}$/.test(sha256) ? { ...m.data, sha256 } : null;
}

// ------------------------------------------------------------------ checking the feed

export type FeedErrorCode = "UPDATE_SIGNATURE_INVALID" | "UPDATE_FEED_UNREACHABLE" | "UPDATE_FEED_REPLAY" | "UPDATES_NOT_CONFIGURED";
export class FeedError extends Error {
  readonly code: FeedErrorCode;
  constructor(message: string, code: FeedErrorCode) {
    super(message);
    this.code = code;
  }
}

/**
 * Fetches and verifies the channel's feed, refuses a replay of an older signed feed, and stores it.
 * The failure is stored too, so the dashboard shows why the last check did not succeed.
 */
export async function checkFeed(db: Db, env: UpdateEnv, get?: Fetcher, now = new Date()): Promise<VerifiedFeed> {
  if (!env.feedBase || !env.publicKey) {
    throw new FeedError("Updates are not configured: the installer writes DOCKIFY_RELEASE_FEED and DOCKIFY_RELEASE_PUBKEY", "UPDATES_NOT_CONFIGURED");
  }
  const { channel } = await readPolicy(db);
  const seen = await db.instance.findUnique({ where: { id: 1 }, select: { updateFeedSeenAt: true, updateChannel: true, latestRelease: true } });
  let feed: VerifiedFeed;
  try {
    feed = await fetchVerifiedFeed(env.feedBase, channel, env.publicKey, get);
    const prev = storedFeed(seen?.latestRelease);
    // Only compare like with like: switching channel starts a fresh sequence.
    if (prev?.channel === feed.channel && seen?.updateFeedSeenAt && new Date(feed.generatedAt) < seen.updateFeedSeenAt) {
      throw new FeedError("The release feed is older than one already seen (a replay). Nothing was stored.", "UPDATE_FEED_REPLAY");
    }
  } catch (e) {
    const err =
      e instanceof FeedError ? e
      : e instanceof SignatureError ? new FeedError(`The release feed's signature did not verify (${e.message}). Nothing was stored.`, "UPDATE_SIGNATURE_INVALID")
      : new FeedError(`Could not reach the release feed: ${e instanceof Error ? e.message : String(e)}`, "UPDATE_FEED_UNREACHABLE");
    await db.instance.update({ where: { id: 1 }, data: { updateCheckedAt: now, updateNextCheckAt: nextCheckAt(now), updateCheckError: err.message.slice(0, 500) } });
    throw err;
  }
  await db.instance.update({
    where: { id: 1 },
    data: {
      updateCheckedAt: now,
      updateNextCheckAt: nextCheckAt(now),
      updateCheckError: null,
      updateFeedSeenAt: new Date(feed.generatedAt),
      latestRelease: { ...feed } as unknown as Prisma.InputJsonValue,
    },
  });
  return feed;
}

// ------------------------------------------------------------------ journal rows

const PHASE: Record<StepId, ReleaseUpdate["phase"]> = {
  preflight: "preflight", pull: "pull", backup: "backup", migrate: "migrate",
  swap_api: "swap_api", swap_worker: "swap_worker", swap_web: "swap_web", health: "health", rollback: "rollback",
};

const asImages = (v: unknown): Images | null => {
  const o = v as Partial<Images> | null;
  return o && typeof o.control === "string" && typeof o.web === "string" ? { control: o.control, web: o.web } : null;
};
const asSteps = (v: unknown): StepRow[] => (Array.isArray(v) ? (v as StepRow[]).filter((s) => s && typeof s.id === "string") : []);

export function journalOf(r: ReleaseUpdate): Journal {
  return {
    id: r.id,
    kind: r.kind,
    fromVersion: r.fromVersion,
    version: r.version,
    manifestSha256: r.manifestSha256,
    fromImages: asImages(r.fromImages),
    toImages: asImages(r.toImages),
    phase: r.phase,
    state: r.state,
    dumpBackupId: r.dumpBackupId,
    dumpSha256: r.dumpSha256,
    dumpBytes: r.dumpBytes === null ? null : Number(r.dumpBytes),
    migrationStarted: r.migrationStarted,
    rollbackOfId: r.rollbackOfId,
    steps: asSteps(r.steps),
    attempt: r.attempt,
    error: r.error,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
}

/** Every column of the journal, for an upsert that must recreate the row after a dump restore. */
export function rowOf(j: Journal, extra: { trigger: ReleaseUpdate["trigger"]; actorName: string | null }) {
  return {
    kind: j.kind,
    trigger: extra.trigger,
    actorName: extra.actorName,
    fromVersion: j.fromVersion,
    version: j.version,
    manifestSha256: j.manifestSha256,
    fromImages: (j.fromImages ?? undefined) as Prisma.InputJsonValue | undefined,
    toImages: (j.toImages ?? undefined) as Prisma.InputJsonValue | undefined,
    phase: PHASE[j.phase],
    state: j.state,
    dumpBackupId: j.dumpBackupId,
    dumpSha256: j.dumpSha256,
    dumpBytes: j.dumpBytes === null ? null : BigInt(j.dumpBytes),
    migrationStarted: j.migrationStarted,
    rollbackOfId: j.rollbackOfId,
    steps: j.steps as unknown as Prisma.InputJsonValue,
    attempt: j.attempt,
    error: j.error,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
  };
}

export const newJournal = (a: { id: string; kind: Journal["kind"]; from: string; version: string; manifestSha256: string | null; toImages?: Images | null; fromImages?: Images | null; rollbackOfId?: string | null; now: Date }): Journal => ({
  id: a.id,
  kind: a.kind,
  fromVersion: a.from,
  version: a.version,
  manifestSha256: a.manifestSha256,
  fromImages: a.fromImages ?? null,
  toImages: a.toImages ?? null,
  phase: "preflight",
  state: "running",
  dumpBackupId: null,
  dumpSha256: null,
  dumpBytes: null,
  migrationStarted: false,
  rollbackOfId: a.rollbackOfId ?? null,
  steps: plannedSteps(),
  attempt: 1,
  error: null,
  startedAt: a.now,
  finishedAt: null,
});

// ------------------------------------------------------------------ the status the dashboard reads

const STEP_ID: Record<StepId, string> = {
  preflight: "preflight", pull: "pull", backup: "backup", migrate: "migrate",
  swap_api: "swapApi", swap_worker: "swapWorker", swap_web: "swapWeb", health: "health", rollback: "rollback",
};
const STATE = { waiting: "waiting", running: "running", done: "done", failed: "failed", rolled_back: "rolledBack" } as const;

export function toJob(u: ReleaseUpdate) {
  const steps = asSteps(u.steps);
  return {
    id: u.id,
    kind: u.kind,
    trigger: u.trigger === "auto" ? ("auto" as const) : ("manual" as const),
    actor: u.trigger === "auto" ? null : (u.actorName ?? (u.trigger === "cli" ? "dockify update (host)" : null)),
    from: u.fromVersion,
    version: u.version,
    phase: STEP_ID[u.phase] as "preflight",
    state: STATE[u.state],
    startedAt: u.startedAt.toISOString(),
    finishedAt: u.finishedAt?.toISOString() ?? null,
    durationMs: u.finishedAt ? u.finishedAt.getTime() - u.startedAt.getTime() : null,
    dumpId: u.dumpBackupId,
    dumpSha256: u.dumpSha256,
    error: u.error,
    attempt: u.attempt,
    steps: (steps.length ? steps : plannedSteps()).map((s) => ({ ...s, id: STEP_ID[s.id] as "preflight" })),
  };
}

const releaseInfo = (r: FeedRelease) => ({
  version: r.version,
  publishedAt: r.publishedAt,
  minFrom: r.minFrom,
  migration: r.migration,
  critical: r.critical,
  notesUrl: r.notesUrl,
  notes: r.notes,
  signed: true as const,
});

/**
 * The last good version this install can go back to: the newest finished update within
 * ROLLBACK_DAYS whose pre-update dump and previous images are recorded, and which is still the
 * version running (nothing newer was installed over it).
 */
export function rollbackTarget(rows: ReleaseUpdate[], current: string, now: Date) {
  const last = rows.find((r) => r.kind === "update" && r.state === "done");
  if (!last || bare(last.version) !== bare(current)) return null;
  if (!last.dumpBackupId || !last.dumpSha256 || !asImages(last.fromImages) || !last.finishedAt) return null;
  const until = new Date(last.finishedAt.getTime() + ROLLBACK_DAYS * 86_400_000);
  if (until <= now) return null;
  // A rollback of this update already ran: nothing left to return to.
  if (rows.some((r) => r.kind === "rollback" && r.rollbackOfId === last.id && r.state === "done")) return null;
  return { updateId: last.id, version: last.fromVersion, until: until.toISOString() };
}

export async function currentVersion(db: Client, env: UpdateEnv): Promise<string> {
  const i = await db.instance.findUnique({ where: { id: 1 }, select: { releaseVersion: true } });
  return i?.releaseVersion ?? env.version;
}

export async function buildStatus(db: Db, env: UpdateEnv, now = new Date()) {
  const [inst, rows, policy] = await Promise.all([
    db.instance.findUnique({ where: { id: 1 }, select: { releaseVersion: true, updateCheckedAt: true, updateNextCheckAt: true, updateCheckError: true, latestRelease: true } }),
    db.releaseUpdate.findMany({ orderBy: { startedAt: "desc" }, take: 20 }),
    readPolicy(db),
  ]);
  const current = inst?.releaseVersion ?? env.version;
  const feed = storedFeed(inst?.latestRelease);
  const usable = feed && feed.channel === policy.channel ? feed : null;
  const offer = usable ? chooseRelease(usable, current) : { target: null, blocked: null, critical: false };
  const decision = decideAuto(now, policy, offer);
  const autoAt = decision.action === "install" ? now : decision.action === "wait" ? decision.until : null;
  const live = rows.find((r) => r.state === "running" || r.state === "waiting");
  return {
    current,
    channel: policy.channel,
    configured: !!(env.feedBase && env.publicKey),
    feedUrl: env.feedBase,
    checkedAt: inst?.updateCheckedAt?.toISOString() ?? null,
    nextCheckAt: inst?.updateNextCheckAt?.toISOString() ?? null,
    checkError: inst?.updateCheckError ?? null,
    policy: {
      mode: policy.mode,
      channel: policy.channel,
      window: policy.window,
      timeZone: policy.timeZone,
      skipVersion: policy.skipVersion,
      pausedUntil: policy.pausedUntil && policy.pausedUntil > now ? policy.pausedUntil.toISOString() : null,
    },
    latest: offer.target ? { ...releaseInfo(offer.target), critical: offer.critical } : null,
    blocked: offer.blocked,
    autoAt: offer.target && autoAt ? autoAt.toISOString() : null,
    job: live ? toJob(live) : rows[0] ? toJob(rows[0]) : null,
    history: rows.map(toJob),
    rollback: live ? null : rollbackTarget(rows, current, now),
    // From the signed feed only: kept while any pending release is a security release.
    security: securityInfo(usable ? pendingSecurity(usable, current) : null),
  };
}

/** The release `version` from the stored feed, or why it cannot be installed over `current`. */
export function pickStored(feed: VerifiedFeed | null, version: string, current: string): { rel: FeedRelease } | { refused: string } {
  if (!feed) return { refused: "Check for updates first: no verified release feed is stored." };
  const rel = feed.releases.find((r) => bare(r.version) === bare(version));
  if (!rel) return { refused: `${version} is not in the verified release feed. Check for updates first.` };
  if (compareVersions(rel.version, current) <= 0) return { refused: `Refusing a downgrade: ${rel.version} is not newer than ${current}. Use Roll back for the previous version.` };
  if (compareVersions(current, rel.minFrom) < 0) return { refused: `${rel.version} upgrades only from ${rel.minFrom} or newer. Install ${rel.minFrom} first.` };
  return { rel };
}
