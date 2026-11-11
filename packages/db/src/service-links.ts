/** A hand typed connection string is not a link and is not found here. */
import type { SecretAccess, Tx } from "./index.ts";
import { readSecretValues } from "./index.ts";

/** Stored link values start with a NUL and name the service id (contracts/env-refs.ts). */
const refersTo = (value: string | null, serviceId: string): boolean => !!value && value.startsWith("\u0000") && value.includes(serviceId);

/** The apps of a service's environment that run code and link to it, directly or from a shared variable. */
export async function linkedApps(db: Tx, access: SecretAccess, service: { id: string; environmentId: string }): Promise<Array<{ id: string; name: string; displayName?: string | null }>> {
  const apps = await db.app.findMany({
    where: { environmentId: service.environmentId, kind: { in: ["frontend", "backend", "bot"] } },
    select: { id: true, name: true, displayName: true },
    orderBy: { name: "asc" },
  });
  if (!apps.length) return [];
  const rows = await db.envVar.findMany({
    where: { OR: [{ scopeType: "environment", scopeId: service.environmentId }, { scopeType: "app", scopeId: { in: apps.map((a) => a.id) } }] },
    select: { scopeType: true, scopeId: true, secretId: true },
  });
  if (!rows.length) return [];
  const values = await readSecretValues(db, access, rows.map((r) => r.secretId));
  const hits = rows.filter((r) => refersTo(values.get(r.secretId) ?? null, service.id));
  if (hits.some((r) => r.scopeType === "environment")) return apps;
  const own = new Set(hits.map((r) => r.scopeId));
  return apps.filter((a) => own.has(a.id));
}
