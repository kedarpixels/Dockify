/** Test support: one user's authenticator columns, with just the Prisma calls mfa.ts makes on them. */

interface Where {
  totpFailedCount?: { lt?: number; gte?: number };
  totpLockouts?: number;
  OR?: Array<{ totpLockedUntil?: { lte: Date } | null; totpLastUsedStep?: { lt: number } | null }>;
}

export function totpUserTable(over: Record<string, unknown> = {}) {
  const row: Record<string, unknown> & { totpFailedCount: number; totpLockouts: number; totpLockedUntil: Date | null; totpLastUsedStep: number | null } = {
    id: "u1", name: "Owner", totpSecretId: null, totpConfirmedAt: new Date(), totpLastUsedStep: null,
    totpFailedCount: 0, totpLockouts: 0, totpLockedUntil: null, ...over,
  };
  const matches = (w: Where): boolean => {
    if (w.totpFailedCount?.lt !== undefined && !(row.totpFailedCount < w.totpFailedCount.lt)) return false;
    if (w.totpFailedCount?.gte !== undefined && !(row.totpFailedCount >= w.totpFailedCount.gte)) return false;
    if (w.totpLockouts !== undefined && w.totpLockouts !== row.totpLockouts) return false;
    for (const o of w.OR ?? []) {
      if (o.totpLockedUntil) return !row.totpLockedUntil || row.totpLockedUntil <= o.totpLockedUntil.lte;
      if (o.totpLastUsedStep) return row.totpLastUsedStep === null || row.totpLastUsedStep < o.totpLastUsedStep.lt;
    }
    return true;
  };
  return {
    row,
    // A snapshot, as Prisma answers: a later write never changes a row already read.
    findUnique: async () => ({ ...row }),
    findUniqueOrThrow: async () => ({ ...row }),
    updateMany: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
      if (!matches(where)) return { count: 0 };
      for (const [k, v] of Object.entries(data)) {
        const inc = v && typeof v === "object" && "increment" in v ? (v as { increment: number }).increment : null;
        row[k] = inc === null ? v : (row[k] as number) + inc;
      }
      return { count: 1 };
    },
  };
}
