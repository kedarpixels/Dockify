import { readSecretValue, type Db, type Tx, type SecretVault } from "@dockify/db";

/**
 * The stored Cloudflare connection, read the one way every edge job reads it. The integration row
 * is kind "cloudflare"; its non-secret config holds the account, the tunnel the installer created
 * for this box, and the zones the owner marked managed.
 */
export interface CloudflareConn {
  token: string;
  accountId: string;
  tunnelId: string | null;
  managedZoneIds: Set<string>;
}

export type ConnResult = { ok: true; conn: CloudflareConn } | { ok: false; reason: string };

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 128 ? v : null);

export function parseCloudflareConfig(config: unknown): { accountId: string | null; tunnelId: string | null; managedZoneIds: Set<string> } {
  const c = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  const zones = Array.isArray(c.managedZoneIds) ? c.managedZoneIds.map(str).filter((z): z is string => !!z) : [];
  return { accountId: str(c.accountId), tunnelId: str(c.tunnelId), managedZoneIds: new Set(zones) };
}

/** Tunnel config edits are read-modify-write: one at a time across every worker. */
export function tunnelLock(db: Pick<Db, "$transaction">) {
  return <T>(fn: () => Promise<T>): Promise<T> =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dockify.cloudflare.tunnel'))`;
      return fn();
    }, { maxWait: 60_000, timeout: 90_000 });
}

export async function loadCloudflare(db: Tx, vault: SecretVault): Promise<ConnResult> {
  const row = await db.integration.findFirst({ where: { kind: "cloudflare", status: { not: "disconnected" } }, orderBy: { createdAt: "asc" } });
  if (!row || !row.secretId) return { ok: false, reason: "Cloudflare is not connected." };
  const cfg = parseCloudflareConfig(row.config);
  if (!cfg.accountId) return { ok: false, reason: "The Cloudflare account is not recorded. Reconnect Cloudflare." };
  let token: string | null;
  try {
    token = await readSecretValue(db, vault, row.secretId);
  } catch {
    return { ok: false, reason: "The stored Cloudflare token could not be unsealed with the loaded key." };
  }
  if (!token) return { ok: false, reason: "The stored Cloudflare token is missing." };
  return { ok: true, conn: { token, accountId: cfg.accountId, tunnelId: cfg.tunnelId, managedZoneIds: cfg.managedZoneIds } };
}
