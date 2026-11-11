// Database rows to contract shapes. Pure.
import { iso, type backups as B } from "@dockify/contracts";
import type { z } from "zod";
import { bothTiers, DEFAULT_CRON, LOCAL_WARNING, localTierWarning, nextRun, primaryTier, tierOfType, type TierRow } from "./shared.ts";

type BackupRun = z.infer<typeof B.BackupRun>;
type BackupSchedule = z.infer<typeof B.BackupSchedule>;
type BackupTierSchedule = z.infer<typeof B.BackupTierSchedule>;
type StorageRef = z.infer<typeof B.BackupStorageRef>;

export interface DestinationRow {
  id: string;
  name: string;
  type: "local" | "s3";
  isDefault: boolean;
  integration: { name: string; config: unknown; lastCheckedAt: Date | null; error: string | null } | null;
}

export interface BackupRowIn {
  id: string;
  appId: string | null;
  sourceAppId: string;
  appSnapshot: unknown;
  trigger: "schedule" | "manual" | "pre_deploy" | "pre_update" | "pre_restore";
  status: "running" | "ready" | "failed";
  createdAt: Date;
  finishedAt: Date | null;
  sizeBytes: bigint | null;
  encrypted: boolean;
  keyFingerprint: string | null;
  error: string | null;
  restoreTestStatus: "passed" | "failed" | "running" | "not_tested";
  restoreTestedAt: Date | null;
  restoreTestTables: number | null;
  restoreTestRows: bigint | null;
  restoreTestError: string | null;
  expiredAt: Date | null;
  destination: DestinationRow | null;
  /** The app today, while it exists: its display name is the one shown. */
  app?: { displayName: string | null } | null;
}


const PROVIDERS = new Set(["r2", "s3", "minio", "custom"]);

export function storageRef(d: DestinationRow | null): StorageRef | null {
  if (!d || d.type !== "s3" || !d.integration) return null;
  const cfg = (d.integration.config ?? {}) as { provider?: string; bucket?: string };
  const provider = PROVIDERS.has(cfg.provider ?? "") ? (cfg.provider as StorageRef["provider"]) : "custom";
  return { id: d.id, name: d.name, provider, bucket: cfg.bucket ?? "" };
}

/** A row orphaned without markBackupsOrphaned has no `deletedAt` in its snapshot: it still reads as deleted, dated by its own time as a lower bound. */
export function database(snapshot: unknown, deletedSince: Date | null): BackupRun["database"] {
  const s = (snapshot ?? {}) as { name?: string; projectSlug?: string; environment?: string; deletedAt?: string | null };
  return {
    name: s.name ?? "unknown",
    projectSlug: s.projectSlug ?? "",
    environment: s.environment ?? "",
    deletedAt: s.deletedAt ?? (deletedSince ? deletedSince.toISOString() : null),
  };
}

const KIND: Record<BackupRowIn["trigger"], BackupRun["kind"]> = {
  schedule: "scheduled",
  manual: "manual",
  pre_deploy: "preDeploy",
  pre_update: "preUpdate",
  pre_restore: "preRestore",
};
const TEST: Record<BackupRowIn["restoreTestStatus"], BackupRun["restoreTest"]["status"]> = {
  passed: "passed",
  failed: "failed",
  running: "running",
  not_tested: "notTested",
};

export function toRun(b: BackupRowIn): BackupRun {
  return {
    id: b.id,
    scheduleId: b.trigger === "schedule" ? b.sourceAppId : null,
    resourceId: b.sourceAppId,
    database: { ...database(b.appSnapshot, b.appId === null ? (b.finishedAt ?? b.createdAt) : null), ...(b.app?.displayName ? { displayName: b.app.displayName } : {}) },
    status: b.status,
    kind: KIND[b.trigger],
    createdAt: b.createdAt.toISOString(),
    finishedAt: iso(b.finishedAt),
    sizeBytes: b.sizeBytes === null ? null : Number(b.sizeBytes),
    tier: tierOfType(b.destination?.type),
    destination: b.destination?.type === "s3" ? "s3" : "local",
    // A local copy is on this server's own disk: every answer that lists one says so.
    ...(b.destination?.type === "s3" ? {} : { warning: LOCAL_WARNING }),
    storage: storageRef(b.destination),
    encryption: { enabled: b.encrypted, fingerprint: b.keyFingerprint },
    restoreTest: {
      status: TEST[b.restoreTestStatus],
      testedAt: iso(b.restoreTestedAt),
      tables: b.restoreTestTables,
      rows: b.restoreTestRows === null ? null : Number(b.restoreTestRows),
      error: b.restoreTestError,
    },
    expired: b.expiredAt !== null,
    error: b.error,
  };
}

/** A Viewer or read token learns that a backup exists, when, and how it went. Destination names, buckets, the key fingerprint and error text are an admin's. */
const limitedRef = (s: StorageRef | null): StorageRef | null => (s ? { id: s.id, name: "Offsite storage", provider: "custom", bucket: "" } : null);

export function limitRun(r: BackupRun): BackupRun {
  return { ...r, storage: limitedRef(r.storage), encryption: { ...r.encryption, fingerprint: null }, restoreTest: { ...r.restoreTest, error: null }, error: null };
}

export function limitSchedule(s: BackupSchedule): BackupSchedule {
  const tier = (t: BackupTierSchedule): BackupTierSchedule => ({ ...t, storage: limitedRef(t.storage) });
  return { ...s, storage: limitedRef(s.storage), encryption: { ...s.encryption, fingerprint: null }, tiers: { local: tier(s.tiers.local), offsite: tier(s.tiers.offsite) } };
}

export interface ScheduleAppIn {
  id: string;
  name: string;
  displayName?: string | null;
  createdAt: Date;
  environment: { name: string; project: { slug: string } };
  backupSchedules: TierRow[];
}

export interface ScheduleContext {
  fingerprint: string | null;
  /** Every S3 destination, the default first, then the oldest: the order an offsite tier picks in. */
  s3: DestinationRow[];
  /** The default destination's type, which places a database with no schedule yet. */
  defaultType: "s3" | "local" | null;
  localAllowed: boolean;
}

export { DEFAULT_CRON };

/** The next run of a tier that is on, never in the past: a tier the worker is about to fire reads "now". */
export function tierNext(row: Pick<TierRow, "enabled" | "cron" | "timezone" | "lastRunAt">, now = new Date()): string | null {
  if (!row.enabled || !row.cron) return null;
  try {
    const from = row.lastRunAt && row.lastRunAt > now ? row.lastRunAt : now;
    return nextRun(row.cron, row.timezone || "UTC", from).toISOString();
  } catch {
    return null;
  }
}

/** Where an offsite tier sends: its own S3 destination, else the default one, else the oldest. */
export const offsiteDestination = (row: Pick<TierRow, "destinationId">, s3: readonly DestinationRow[]): DestinationRow | null =>
  s3.find((d) => d.id === row.destinationId) ?? s3[0] ?? null;

/** About how many days of backups a tier keeps, for older clients that read retention in days. */
export function approxRetentionDays(row: Pick<TierRow, "cron" | "timezone" | "keep" | "keepDays">, now = new Date()): number {
  let span = row.keep;
  try {
    let t = now;
    for (let i = 0; i < row.keep; i++) t = nextRun(row.cron ?? DEFAULT_CRON, row.timezone || "UTC", t);
    span = Math.ceil((t.getTime() - now.getTime()) / 86_400_000);
  } catch {
    // A cron that never fires: the count stands in for days.
  }
  return Math.max(1, row.keepDays ?? 0, span);
}

export function toTier(row: TierRow, c: ScheduleContext, now = new Date()): BackupTierSchedule {
  const offsite = row.tier === "offsite";
  const dest = offsite ? offsiteDestination(row, c.s3) : null;
  return {
    tier: row.tier,
    enabled: row.enabled,
    cron: row.cron ?? DEFAULT_CRON,
    timezone: row.timezone,
    keep: row.keep,
    keepDays: row.keepDays,
    destination: offsite ? "s3" : "local",
    storage: storageRef(dest),
    available: offsite ? dest !== null : c.localAllowed,
    nextRunAt: tierNext(row, now),
    lastRunAt: iso(row.lastRunAt),
  };
}

/** Both tiers, plus the flat fields an older client reads, taken from the tier that is on (offsite first). */
export function toSchedule(app: ScheduleAppIn, c: ScheduleContext, now = new Date()): BackupSchedule {
  const rows = bothTiers(app.backupSchedules);
  const offsite = toTier(rows.offsite, c, now);
  // The disk warning only where it applies: while no copy of this database goes offsite.
  const stuck = !(offsite.enabled && offsite.available);
  const local = { ...toTier(rows.local, c, now), ...(stuck ? { warning: localTierWarning(c.s3.length > 0) } : {}) };
  const main = primaryTier(rows, c.defaultType) === "offsite" ? offsite : local;
  const nexts = [local.nextRunAt, offsite.nextRunAt].filter((x): x is string => !!x).sort();
  const lasts = [local.lastRunAt, offsite.lastRunAt].filter((x): x is string => !!x).sort();
  return {
    id: app.id,
    resourceId: app.id,
    database: { name: app.name, ...(app.displayName ? { displayName: app.displayName } : {}), projectSlug: app.environment.project.slug, environment: app.environment.name, deletedAt: null },
    cron: main.cron,
    timezone: main.timezone,
    retentionDays: approxRetentionDays(rows[main.tier], now),
    destination: main.destination,
    ...(local.warning ? { warning: local.warning } : {}),
    storage: main.storage,
    encryption: { enabled: true, fingerprint: c.fingerprint },
    enabled: local.enabled || offsite.enabled,
    nextRunAt: nexts[0] ?? null,
    lastRunAt: lasts.at(-1) ?? null,
    tiers: { local, offsite },
  };
}
