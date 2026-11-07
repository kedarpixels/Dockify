/**
 * Database rows to contract shapes. Pure, so the shapes are pinned by tests against the zod
 * schemas the web parses with.
 */
import { iso, type backups as B } from "@dockify/contracts";
import type { z } from "zod";
import { LOCAL_WARNING, nextRun } from "./shared.ts";

type BackupRun = z.infer<typeof B.BackupRun>;
type BackupSchedule = z.infer<typeof B.BackupSchedule>;
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
}


const PROVIDERS = new Set(["r2", "s3", "minio", "custom"]);

export function storageRef(d: DestinationRow | null): StorageRef | null {
  if (!d || d.type !== "s3" || !d.integration) return null;
  const cfg = (d.integration.config ?? {}) as { provider?: string; bucket?: string };
  const provider = PROVIDERS.has(cfg.provider ?? "") ? (cfg.provider as StorageRef["provider"]) : "custom";
  return { id: d.id, name: d.name, provider, bucket: cfg.bucket ?? "" };
}

/**
 * `deletedAt` comes from the snapshot (markBackupsOrphaned writes it when the app is deleted). A row
 * orphaned without that call still reads as deleted, dated by its own time as a lower bound.
 */
export function database(snapshot: unknown, deletedSince: Date | null): BackupRun["database"] {
  const s = (snapshot ?? {}) as { name?: string; projectSlug?: string; environment?: string; deletedAt?: string | null };
  return {
    name: s.name ?? "unknown",
    projectSlug: s.projectSlug ?? "",
    environment: s.environment ?? "",
    deletedAt: s.deletedAt ?? (deletedSince ? deletedSince.toISOString() : null),
  };
}

/** The contract's camelCase kinds for the schema's snake_case triggers. */
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
    database: database(b.appSnapshot, b.appId === null ? (b.finishedAt ?? b.createdAt) : null),
    status: b.status,
    kind: KIND[b.trigger],
    createdAt: b.createdAt.toISOString(),
    finishedAt: iso(b.finishedAt),
    sizeBytes: b.sizeBytes === null ? null : Number(b.sizeBytes),
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

export interface ScheduleAppIn {
  id: string;
  name: string;
  backupEnabled: boolean;
  backupCron: string | null;
  backupTimezone: string;
  backupRetentionDays: number;
  backupLastRunAt: Date | null;
  createdAt: Date;
  environment: { name: string; project: { slug: string } };
  backupDestination: DestinationRow | null;
}

export const DEFAULT_CRON = "0 3 * * *";

export function scheduleNext(app: Pick<ScheduleAppIn, "backupEnabled" | "backupCron" | "backupTimezone" | "backupLastRunAt" | "createdAt">, now = new Date()): string | null {
  if (!app.backupEnabled || !app.backupCron) return null;
  try {
    const from = app.backupLastRunAt && app.backupLastRunAt > now ? app.backupLastRunAt : now;
    return nextRun(app.backupCron, app.backupTimezone || "UTC", from).toISOString();
  } catch {
    return null;
  }
}

/**
 * A service's schedule. The app's own destination wins; without one, the instance default is
 * shown, which is where the worker will send it.
 */
export function toSchedule(app: ScheduleAppIn, fingerprint: string | null, fallback: DestinationRow | null, now = new Date()): BackupSchedule {
  const dest = app.backupDestination ?? fallback;
  return {
    id: app.id,
    resourceId: app.id,
    database: { name: app.name, projectSlug: app.environment.project.slug, environment: app.environment.name, deletedAt: null },
    cron: app.backupCron ?? DEFAULT_CRON,
    timezone: app.backupTimezone,
    retentionDays: app.backupRetentionDays,
    destination: dest?.type === "s3" ? "s3" : "local",
    ...(dest?.type === "s3" ? {} : { warning: LOCAL_WARNING }),
    storage: storageRef(dest),
    encryption: { enabled: true, fingerprint },
    enabled: app.backupEnabled,
    nextRunAt: scheduleNext(app, now),
    lastRunAt: iso(app.backupLastRunAt),
  };
}
