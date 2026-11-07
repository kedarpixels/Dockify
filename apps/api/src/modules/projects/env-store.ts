/**
 * Loads and stores a project's env set. Every value is sealed in `secrets` (one row per value,
 * owner env_var:<envVar id>); each applied version also seals a full snapshot (owner
 * env_version:<version id>), which is what rollback restores from.
 *
 * Apply is optimistic: the project's envVersion moves only if it still equals the caller's
 * baseVersion, inside the transaction that writes the rows, so two tabs cannot both win.
 */
import { randomUUID } from "node:crypto";
import { projects as P } from "@dockify/contracts";
import type { Keyring } from "@dockify/crypto";
import { openServiceCredentials, readSecretValue, storeSecret, type ActorType, type EnvVersionSource, type Prisma, type Tx } from "@dockify/db";
import { HttpError } from "../../errors.ts";
import {
  affectedApps, entryId, EnvPlanError, idOf, plan, serializeSnapshot, type ChangeRecord, type Entry, type EnvSet, type RefService, type ResolvedChange,
} from "./env-model.ts";
import { requestRedeploys } from "./jobs.ts";

export interface StoredEntry extends Entry {
  rowId: string;
  secretId: string;
  updatedAt: Date;
  updatedBy: string | null;
}

export interface ProjectScope {
  projectId: string;
  environments: Array<{ id: string; name: string }>;
  apps: Array<{ id: string; name: string; environmentId: string; kind: string; serviceRedirectId?: string | null }>;
}

export async function loadScope(tx: Tx, projectId: string): Promise<ProjectScope> {
  const environments = await tx.environment.findMany({ where: { projectId }, select: { id: true, name: true }, orderBy: { createdAt: "asc" } });
  const apps = await tx.app.findMany({
    where: { environmentId: { in: environments.map((e) => e.id) } },
    select: { id: true, name: true, environmentId: true, kind: true, serviceRedirectId: true },
    orderBy: { createdAt: "asc" },
  });
  return { projectId, environments, apps };
}

/**
 * Every stored entry of a project. Only values `unseal` approves are opened; the rest stay null,
 * so a masked view never decrypts a secret it will not show. Apply passes `true`.
 */
export async function loadEntries(
  tx: Tx, ring: Keyring, scope: ProjectScope, unseal: boolean | ((secret: boolean) => boolean),
): Promise<Map<string, StoredEntry>> {
  const rows = await tx.envVar.findMany({
    where: {
      OR: [
        { scopeType: "environment", scopeId: { in: scope.environments.map((e) => e.id) } },
        { scopeType: "app", scopeId: { in: scope.apps.map((a) => a.id) } },
      ],
    },
    orderBy: { key: "asc" },
  });
  const out = new Map<string, StoredEntry>();
  for (const r of rows) {
    if (r.scopeType === "project") continue;
    let value: string | null = null;
    if (typeof unseal === "function" ? unseal(r.isSecret) : unseal) {
      try {
        value = await readSecretValue(tx, ring, r.secretId);
      } catch {
        value = null;
      }
    }
    const e: StoredEntry = {
      scope: r.scopeType, scopeId: r.scopeId, key: r.key, value, secret: r.isSecret, target: r.target,
      rowId: r.id, secretId: r.secretId, updatedAt: r.updatedAt, updatedBy: r.updatedBy,
    };
    out.set(idOf(e), e);
  }
  return out;
}

/**
 * A service's current credentials, opened for a reference: the audited reveal, never a listing.
 * Read by the shared reader (@dockify/db), the same one the worker deploys with, so the value
 * revealed is the value a linked app gets, in either stored shape.
 */
export async function openRefTarget(tx: Tx, ring: Keyring, svc: RefService): Promise<P.RefTarget> {
  const app = await tx.app.findUnique({ where: { id: svc.id }, select: { id: true, name: true, kind: true, passwordSecretId: true } });
  const creds = app ? await openServiceCredentials(tx, ring, app).then((p) => p.credentials).catch(() => null) : null;
  if (!creds) throw new EnvPlanError("REF_UNREADABLE", `${svc.name} has no readable credentials yet`);
  return { kind: svc.kind, host: svc.name, port: P.REF_PORTS[svc.kind], ...creds };
}

export interface Writer {
  actorType: ActorType;
  actorId: string | null;
  actorName: string | null;
  source: EnvVersionSource;
}

export interface ApplyInput {
  baseVersion: number | "current";
  changes: ResolvedChange[];
  redeploy: boolean;
  writer: Writer;
  restoredFrom?: number;
  /** Called with the plan before anything is written: the handler's step-up check. */
  authorize: (touchesSecret: boolean) => void;
}

export interface ApplyResult {
  version: number;
  records: ChangeRecord[];
  deploymentIds: string[];
}

const ownerOf = (rowId: string) => ({ kind: "env_var" as const, ownerType: "env_var", ownerId: rowId });

/** Runs inside the caller's transaction. Throws HttpError 409 on a stale baseVersion. */
export async function applyChanges(tx: Prisma.TransactionClient, ring: Keyring, scope: ProjectScope, input: ApplyInput): Promise<ApplyResult> {
  // The row lock this update takes serialises every apply on the project.
  const project = await tx.project.findUniqueOrThrow({ where: { id: scope.projectId }, select: { envVersion: true } });
  const base = input.baseVersion === "current" ? project.envVersion : input.baseVersion;
  const bumped = await tx.project.updateMany({ where: { id: scope.projectId, envVersion: base }, data: { envVersion: { increment: 1 } } });
  if (bumped.count !== 1) {
    const now = await tx.project.findUniqueOrThrow({ where: { id: scope.projectId }, select: { envVersion: true } });
    throw new HttpError(409, "Someone applied env changes after you loaded them. Reload and review the diff again.", "ENV_CONFLICT", { version: now.envVersion });
  }
  const version = base + 1;

  const stored = await loadEntries(tx, ring, scope, true);
  const current: EnvSet = new Map(stored);
  const envOfApp = new Map(scope.apps.map((a) => [a.id, a.environmentId]));
  const p = plan(current, input.changes, envOfApp);
  input.authorize(p.touchesSecret);

  for (const c of input.changes) {
    const id = entryId(c.scope, c.scopeId, c.key);
    const before = stored.get(id);
    const after = p.next.get(id);
    if (!before && after) {
      const rowId = randomUUID();
      const secretId = await storeSecret(tx, ring, ownerOf(rowId), after.value ?? "");
      await tx.envVar.create({
        data: {
          id: rowId, scopeType: after.scope, scopeId: after.scopeId, key: after.key, secretId, isSecret: after.secret, target: after.target,
          updatedById: input.writer.actorId, updatedBy: input.writer.actorName,
        },
      });
    } else if (before && after) {
      if (before.value === after.value && before.secret === after.secret && before.target === after.target) continue;
      const data: Prisma.EnvVarUncheckedUpdateInput = {
        isSecret: after.secret, target: after.target, updatedById: input.writer.actorId, updatedBy: input.writer.actorName,
      };
      if (after.value !== before.value) data.secretId = await storeSecret(tx, ring, ownerOf(before.rowId), after.value ?? "");
      await tx.envVar.update({ where: { id: before.rowId }, data });
      if (data.secretId) await tx.secret.delete({ where: { id: before.secretId } });
    } else if (before && !after) {
      // Deleting the sealed value cascades to the env_vars row.
      await tx.secret.delete({ where: { id: before.secretId } });
    }
  }

  const reach = affectedApps(current, p.next, scope.apps);
  const deploymentIds = input.redeploy ? await requestRedeploys(tx, reach, input.writer) : [];

  const versionId = randomUUID();
  const snapshotSecretId = await storeSecret(tx, ring, { kind: "env_version", ownerType: "env_version", ownerId: versionId }, serializeSnapshot(p.next), null);
  await tx.envVersion.create({
    data: {
      id: versionId,
      projectId: scope.projectId,
      version,
      actorType: input.writer.actorType,
      actorId: input.writer.actorId,
      actorName: input.writer.actorName,
      source: input.writer.source,
      restoredFrom: input.restoredFrom ?? null,
      changes: p.records as unknown as Prisma.InputJsonValue,
      redeployed: deploymentIds.length,
      snapshotSecretId,
    },
  });
  return { version, records: p.records, deploymentIds };
}

/** Every secret id a set of env rows, versions and app credentials hold: for teardown. */
export async function secretIdsFor(tx: Tx, scope: { environmentIds: string[]; appIds: string[]; projectId?: string }): Promise<string[]> {
  const vars = await tx.envVar.findMany({
    where: {
      OR: [
        { scopeType: "environment", scopeId: { in: scope.environmentIds } },
        { scopeType: "app", scopeId: { in: scope.appIds } },
        ...(scope.projectId ? [{ scopeType: "project" as const, scopeId: scope.projectId }] : []),
      ],
    },
    select: { secretId: true },
  });
  const apps = await tx.app.findMany({ where: { id: { in: scope.appIds } }, select: { passwordSecretId: true } });
  const deps = await tx.deployment.findMany({ where: { appId: { in: scope.appIds }, envSecretId: { not: null } }, select: { envSecretId: true } });
  const versions = scope.projectId ? await tx.envVersion.findMany({ where: { projectId: scope.projectId }, select: { snapshotSecretId: true } }) : [];
  return [
    ...vars.map((v) => v.secretId),
    ...apps.flatMap((a) => (a.passwordSecretId ? [a.passwordSecretId] : [])),
    ...deps.flatMap((d) => (d.envSecretId ? [d.envSecretId] : [])),
    ...versions.map((v) => v.snapshotSecretId),
  ];
}
