/**
 * A database's two backup tiers: `local` (this server's disk) and `offsite` (an S3 destination), each
 * with its own cron, switch and count to keep. A backup counts in the tier its destination's type
 * names, so nothing on a backup row says which tier took it and nothing can disagree with where the
 * file is. Shared by the api (schedules, Back up now) and the worker (scheduler, retention).
 */
import type { BackupTier, Tx } from "@dockify/db";
import { nextRun } from "./cron.ts";
import { RequestError } from "./requests.ts";

export type Tier = BackupTier;
export const TIERS: readonly Tier[] = ["local", "offsite"];

/** What a tier with no row keeps, and the cron a tier turned on without one gets. */
export const DEFAULT_KEEP = 7;
export const DEFAULT_CRON = "0 3 * * *";
/** The one local destination every local tier writes to. */
export const LOCAL_DESTINATION_NAME = "This server";

export interface TierRow {
  tier: Tier;
  enabled: boolean;
  cron: string | null;
  timezone: string;
  keep: number;
  keepDays: number | null;
  destinationId: string | null;
  lastRunAt: Date | null;
}

export const tierOfType = (type: string | null | undefined): Tier => (type === "s3" ? "offsite" : "local");

export const tierDefaults = (tier: Tier): TierRow => ({ tier, enabled: false, cron: null, timezone: "UTC", keep: DEFAULT_KEEP, keepDays: null, destinationId: null, lastRunAt: null });

/** Both tiers of one database, a missing row read as its defaults. */
export function bothTiers(rows: readonly TierRow[]): Record<Tier, TierRow> {
  return {
    local: rows.find((r) => r.tier === "local") ?? tierDefaults("local"),
    offsite: rows.find((r) => r.tier === "offsite") ?? tierDefaults("offsite"),
  };
}

/**
 * The tier the single schedule an older client reads is: one that is on (offsite first), else one
 * with a cron set, else where the default destination would send a backup.
 */
export function primaryTier(t: Record<Tier, TierRow>, defaultType: "s3" | "local" | null): Tier {
  if (t.offsite.enabled) return "offsite";
  if (t.local.enabled) return "local";
  if (t.offsite.cron) return "offsite";
  if (t.local.cron) return "local";
  return defaultType === "s3" ? "offsite" : "local";
}

/** The tiers that are on, which is what Back up now does when no tier is named. */
export const enabledTiers = (t: Record<Tier, TierRow>): Tier[] => TIERS.filter((k) => t[k].enabled);

/** When a tier next fires, from its last run, or from just before now for a tier that never ran. */
export function tierNextRun(row: Pick<TierRow, "cron" | "timezone" | "lastRunAt">, now: Date): Date | null {
  if (!row.cron) return null;
  try {
    return nextRun(row.cron, row.timezone || "UTC", row.lastRunAt ?? new Date(now.getTime() - 60_000));
  } catch {
    return null;
  }
}

export async function loadTiers(tx: Pick<Tx, "backupSchedule">, appId: string): Promise<Record<Tier, TierRow>> {
  return bothTiers(await tx.backupSchedule.findMany({ where: { appId } }));
}

export async function localDestinationId(tx: Pick<Tx, "backupDestination">): Promise<string> {
  const existing = await tx.backupDestination.findFirst({ where: { type: "local" }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }], select: { id: true } });
  if (existing) return existing.id;
  return (await tx.backupDestination.upsert({ where: { name: LOCAL_DESTINATION_NAME }, update: {}, create: { name: LOCAL_DESTINATION_NAME, type: "local" }, select: { id: true } })).id;
}

/** The S3 destination an offsite tier sends to: its own, else the default one, else the oldest. */
export async function offsiteDestinationId(tx: Pick<Tx, "backupDestination">, own: string | null): Promise<string> {
  if (own) {
    const d = await tx.backupDestination.findUnique({ where: { id: own }, select: { id: true, type: true } });
    if (d?.type === "s3") return d.id;
  }
  const d = await tx.backupDestination.findFirst({ where: { type: "s3" }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }], select: { id: true } });
  if (!d) throw new RequestError(409, "Add an S3 compatible storage destination first, in Settings, Integrations", "NO_DESTINATION");
  return d.id;
}

export const tierDestinationId = (tx: Pick<Tx, "backupDestination">, row: TierRow): Promise<string> =>
  row.tier === "local" ? localDestinationId(tx) : offsiteDestinationId(tx, row.destinationId);
