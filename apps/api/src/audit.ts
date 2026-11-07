import type { ActivityCategory, ActorType, Prisma, Tx } from "@dockify/db";

export interface AuditEntry {
  category: ActivityCategory;
  action: string;
  verb: string;
  actorType: ActorType;
  actorId?: string | null;
  actorName?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  targetHref?: string | null;
  suffix?: string | null;
  failed?: boolean;
  ip?: string | null;
  userAgent?: string | null;
  gitAuthor?: string | null;
  changes?: Prisma.InputJsonValue;
}

/** Writes one audit row. Failures to audit are logged by the caller's error handler, never hidden. */
export async function audit(db: Tx, e: AuditEntry): Promise<void> {
  await db.activityLog.create({
    data: {
      category: e.category,
      action: e.action,
      verb: e.verb,
      actorType: e.actorType,
      actorId: e.actorId ?? null,
      actorName: e.actorName ?? null,
      targetType: e.targetType ?? null,
      targetId: e.targetId ?? null,
      targetLabel: e.targetLabel ?? null,
      targetHref: e.targetHref ?? null,
      suffix: e.suffix ?? null,
      failed: e.failed ?? false,
      ip: e.ip ?? null,
      userAgent: e.userAgent?.slice(0, 300) ?? null,
      gitAuthor: e.gitAuthor ?? null,
      ...(e.changes === undefined ? {} : { changes: e.changes }),
    },
  });
}
