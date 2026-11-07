/**
 * Env resolution for one deployment: project, then environment, then app (later wins). The result
 * is sealed into one env_snapshot secret on the Deployment, so a retry or a rollback runs with
 * exactly the config that deployment shipped with, and an undecryptable value fails before any
 * expensive build.
 */
import { projects as P } from "@dockify/contracts";
import { openServiceCredentials, readSecretValue, readSecretValues, ServiceCredentialsError, storeSecret, type Db, type SecretVault, type ServiceCredentials } from "@dockify/db";
import type { BuildVar } from "@dockify/engine";
import { PermanentDeployError } from "@dockify/engine";

export type ResolvedVar = BuildVar;

const RANK = { project: 0, environment: 1, app: 2 } as const;

/** Pure merge: higher scope wins per key, output sorted by key so snapshots are stable. */
export function mergeScopes(rows: Array<ResolvedVar & { scope: keyof typeof RANK }>): ResolvedVar[] {
  const byKey = new Map<string, ResolvedVar & { scope: keyof typeof RANK }>();
  for (const r of rows) {
    const cur = byKey.get(r.key);
    if (!cur || RANK[r.scope] >= RANK[cur.scope]) byKey.set(r.key, r);
  }
  return [...byKey.values()]
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map(({ key, value, isSecret, target }) => ({ key, value, isSecret, target }));
}

export function runtimeEnv(vars: ResolvedVar[], port: number | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of vars) if (v.target !== "build") out[v.key] = v.value;
  if (port !== null && out.PORT === undefined) out.PORT = String(port);
  return out;
}

/** Opens every value of one app's scopes in a single vault call: one audited open per resolution. */
export async function resolveEnv(db: Db, vault: SecretVault, ids: { projectId: string; environmentId: string; appId: string }): Promise<ResolvedVar[]> {
  const rows = await db.envVar.findMany({
    where: {
      OR: [
        { scopeType: "project", scopeId: ids.projectId },
        { scopeType: "environment", scopeId: ids.environmentId },
        { scopeType: "app", scopeId: ids.appId },
      ],
    },
  });
  if (!rows.length) return [];
  let values: Map<string, string | null>;
  try {
    values = await readSecretValues(db, vault, rows.map((r) => r.secretId));
  } catch (e) {
    throw new PermanentDeployError(`env vars cannot be opened: ${e instanceof Error ? e.message : String(e)}`);
  }
  const out: Array<ResolvedVar & { scope: keyof typeof RANK }> = [];
  for (const r of rows) {
    const value = values.get(r.secretId) ?? null;
    if (value === null) throw new PermanentDeployError(`env var ${r.key} (${r.scopeType} scope) cannot be decrypted; set it again before deploying`);
    if (P.isEnvRefValue(value)) {
      out.push({ key: r.key, value: await resolveRef(db, vault, r.key, value, ids.projectId), isSecret: true, target: r.target, scope: r.scopeType });
      continue;
    }
    out.push({ key: r.key, value, isSecret: r.isSecret, target: r.target, scope: r.scopeType });
  }
  return mergeScopes(out);
}

/**
 * A linked variable's value now: the service's current credential, so a rotated password reaches
 * the app on this deploy. Only a service in the deploying app's own project resolves; anything
 * else fails the deploy rather than hand one tenant's credential to another. The credentials are
 * read by the shared reader (@dockify/db), which also reads an older install's bare password, so
 * a stored value never fails a deploy with a raw JSON error.
 */
async function resolveRef(db: Db, vault: SecretVault, key: string, stored: string, projectId: string): Promise<string> {
  const ref = P.decodeEnvRef(stored);
  const select = { id: true, name: true, kind: true, passwordSecretId: true, serviceRedirectId: true, environment: { select: { projectId: true } } } as const;
  let svc = ref ? await db.app.findUnique({ where: { id: ref.resourceId }, select }) : null;
  // A version change switched this service's links to a new one. One step only: the new service never redirects.
  if (svc?.serviceRedirectId) svc = await db.app.findUnique({ where: { id: svc.serviceRedirectId }, select });
  if (!ref || !svc || svc.environment.projectId !== projectId || (svc.kind !== "postgres" && svc.kind !== "redis" && svc.kind !== "s3")) {
    throw new PermanentDeployError(`env var ${key} links a service that is not in this project; link it again or remove it`);
  }
  if (!P.refFieldAllowed(svc.kind, ref.field)) throw new PermanentDeployError(`env var ${key} links a field ${svc.name} does not have`);
  let creds: ServiceCredentials;
  try {
    creds = (await openServiceCredentials(db, vault, svc)).credentials;
  } catch (e) {
    const why = e instanceof ServiceCredentialsError ? e.message : "they could not be opened";
    throw new PermanentDeployError(`env var ${key} links ${svc.name}, whose credentials cannot be read: ${why}`);
  }
  return P.refValue({ kind: svc.kind, host: svc.name, port: P.REF_PORTS[svc.kind], ...creds }, ref.field);
}

export async function sealSnapshot(db: Db, vault: SecretVault, deploymentId: string, vars: ResolvedVar[]): Promise<string> {
  return db.$transaction(async (tx) => {
    const id = await storeSecret(tx, vault, { kind: "env_snapshot", ownerType: "deployment", ownerId: deploymentId }, JSON.stringify({ v: 1, vars }), null);
    await tx.deployment.update({ where: { id: deploymentId }, data: { envSecretId: id } });
    return id;
  });
}

export async function openSnapshot(db: Db, vault: SecretVault, secretId: string): Promise<ResolvedVar[]> {
  let raw: string | null;
  try {
    raw = await readSecretValue(db, vault, secretId);
  } catch {
    raw = null;
  }
  if (!raw) throw new PermanentDeployError("the env snapshot of this deployment cannot be opened");
  const parsed = JSON.parse(raw) as { v: number; vars: ResolvedVar[] };
  return parsed.vars;
}

export interface RollbackEnv {
  vars: ResolvedVar[];
  /** Secret keys whose rollback-target value differs from today's: today's value is used. */
  secretsKeptCurrent: string[];
  /** Keys the target shipped with that no longer exist: they stay removed. */
  notRestored: string[];
}

/**
 * The env a rollback runs with. Only the image and plain (non-secret) values roll back. A rollback
 * is a deploy-scope action, so it must never undo an env change that needed more: a rotated secret
 * keeps its current value and a removed variable (secret or not) stays removed. Rolling env itself
 * back is env.rollback, which is elevated and audited. Pure, sorted by key like mergeScopes.
 */
export function rollbackEnv(snapshot: ResolvedVar[], current: ResolvedVar[]): RollbackEnv {
  const old = new Map(snapshot.map((v) => [v.key, v]));
  const now = new Set(current.map((v) => v.key));
  const secretsKeptCurrent: string[] = [];
  const vars = current.map((cur) => {
    const prev = old.get(cur.key);
    if (!prev) return cur;
    // A hook key runs code before the app starts, so like a secret it keeps its current value: a
    // rollback, which a deploy token can ask for, must not bring back one an admin has since changed.
    if (cur.isSecret || prev.isSecret || P.isDangerousEnvKey(cur.key)) {
      if (prev.value !== cur.value || prev.isSecret !== cur.isSecret) secretsKeptCurrent.push(cur.key);
      return cur;
    }
    return { key: cur.key, value: prev.value, isSecret: false, target: prev.target };
  });
  const notRestored = snapshot.filter((v) => !now.has(v.key)).map((v) => v.key);
  return { vars: [...vars].sort((a, b) => (a.key < b.key ? -1 : 1)), secretsKeptCurrent, notRestored };
}
