import { z } from "zod";
import { ConfirmText, isReservedServiceName, Iso, RESERVED_NAME_PREFIX, RESERVED_SERVICE_MESSAGE, Uuid } from "./common.ts";
import { StorageProvider } from "./integrations.ts";

export const BackupDatabase = z.object({
  name: z.string(),
  /** The app's display name today, while it has one and still exists. */
  displayName: z.string().optional(),
  projectSlug: z.string(),
  environment: z.string(),
  deletedAt: Iso.nullable().optional(),
});
export const BackupStorageRef = z.object({ id: z.string(), name: z.string(), provider: StorageProvider, bucket: z.string() });
export const BackupEncryption = z.object({ enabled: z.boolean(), fingerprint: z.string().nullable() });
export const RestoreTest = z.object({
  status: z.enum(["passed", "failed", "running", "notTested"]),
  testedAt: Iso.nullable(),
  tables: z.number().nullable(),
  rows: z.number().nullable(),
  error: z.string().nullable(),
});
export const BackupConfig = z.object({
  destinations: z.array(BackupStorageRef.extend({ isDefault: z.boolean(), lastTestedAt: Iso.nullable(), error: z.string().nullable() })),
  encryption: z.object({ enabled: z.boolean(), algorithm: z.string(), fingerprint: z.string().nullable(), createdAt: Iso.nullable() }),
  restoreTests: z.object({ cron: z.string(), nextRunAt: Iso.nullable() }),
});
export const BackupSchedule = z.object({
  id: z.string(),
  resourceId: z.string(),
  database: BackupDatabase,
  cron: z.string(),
  timezone: z.string(),
  retentionDays: z.number(),
  destination: z.enum(["s3", "local"]),
  /** Set for "local": the copies are on this server's own disk and go with it. */
  warning: z.string().optional(),
  storage: BackupStorageRef.nullable(),
  encryption: BackupEncryption,
  enabled: z.boolean(),
  nextRunAt: Iso.nullable(),
  lastRunAt: Iso.nullable(),
});
export const BackupRun = z.object({
  id: z.string(),
  scheduleId: z.string().nullable(),
  resourceId: z.string(),
  database: BackupDatabase,
  status: z.enum(["running", "ready", "failed"]),
  kind: z.enum(["scheduled", "manual", "preDeploy", "preUpdate", "preRestore"]),
  createdAt: Iso,
  finishedAt: Iso.nullable(),
  sizeBytes: z.number().nullable(),
  destination: z.enum(["s3", "local"]),
  /** Set for "local": the copy is on this server's own disk and goes with it. */
  warning: z.string().optional(),
  storage: BackupStorageRef.nullable(),
  encryption: BackupEncryption,
  restoreTest: RestoreTest,
  expired: z.boolean(),
  error: z.string().nullable().optional(),
});

/** Five-field cron, digits and the usual operators only. */
const Cron = z.string().max(100).regex(/^(\S+\s+){4}\S+$/).regex(/^[\d*/,\- ]+$/);
export const SchedulePatchBody = z.strictObject({
  enabled: z.boolean().optional(),
  cron: Cron.optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  destination: z.union([z.enum(["s3", "local"]), Uuid]).optional(),
});
export const RunBackupsBody = z.strictObject({ resourceId: Uuid.optional() });
export const RunBackupsResponse = z.object({ runs: z.array(BackupRun) });
/** The new service's app name, which becomes its DNS alias: the dk- prefix is Dockify's (common.ts AppName). */
export const NewDbName = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,39}$/)
  .refine((v) => !v.startsWith(RESERVED_NAME_PREFIX), `Names starting with ${RESERVED_NAME_PREFIX} are reserved for Dockify`)
  .refine((v) => !isReservedServiceName(v), RESERVED_SERVICE_MESSAGE);
export const RestoreBody = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("new"), name: NewDbName }),
  z.strictObject({ mode: z.literal("replace"), confirm: ConfirmText }),
]);
export const RestoreOutcome = z.object({ ok: z.literal(true), finishedAt: Iso, database: BackupDatabase.extend({ resourceId: z.string() }) });
/** A restore that outlasts the request: follow its job with backups.restoreStatus. */
export const RestoreAccepted = z.object({ jobId: z.string(), resourceId: z.string(), status: z.literal("queued") });
export const RestoreResponse = z.union([RestoreOutcome, RestoreAccepted]);
export const RestoreStatusParams = z.strictObject({ id: Uuid, jobId: Uuid });
export const RestoreStatus = z.union([RestoreOutcome, z.object({ status: z.enum(["running", "failed"]), error: z.string().nullable() })]);
export const OrphanParams = z.strictObject({ resourceId: Uuid });
export const OrphanDeleteResult = z.object({ deleted: z.number(), freedBytes: z.number() });
