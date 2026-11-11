// The env var model as pure functions; the database layer only loads and stores.
// App scope beats environment scope, and the phase filter applies last: a runtime-only override
// still hides the environment value from the build.
import { z } from "zod";
import { projects as P } from "@dockify/contracts";

export type Target = "build" | "runtime" | "both";
export type Scope = "environment" | "app";
export type Op = "add" | "change" | "remove";
export type Phase = "build" | "runtime" | "all";

export interface Entry {
  scope: Scope;
  scopeId: string;
  key: string;
  /** Null only when a stored value would not unseal; apply refuses to work on one. */
  value: string | null;
  secret: boolean;
  target: Target;
}

export type EnvSet = Map<string, Entry>;

export const entryId = (scope: Scope, scopeId: string, key: string): string => `${scope}:${scopeId}:${key}`;
export const idOf = (e: Pick<Entry, "scope" | "scopeId" | "key">): string => entryId(e.scope, e.scopeId, e.key);

export function toSet(entries: Iterable<Entry>): EnvSet {
  const m: EnvSet = new Map();
  for (const e of entries) m.set(idOf(e), e);
  return m;
}

export interface ResolvedChange {
  scope: Scope;
  scopeId: string;
  environment: string;
  appId?: string;
  appName?: string;
  key: string;
  op: Op;
  value?: string;
  secret?: boolean;
  target?: Target;
}

/** What a version stores about each change. Never the value. */
export interface ChangeRecord {
  environment: string;
  appId?: string;
  appName?: string;
  key: string;
  op: Op;
  secret: boolean;
  target: Target;
}

export class EnvPlanError extends Error {
  readonly code: string;
  readonly key?: string;
  constructor(code: string, message: string, key?: string) {
    super(message);
    this.name = "EnvPlanError";
    this.code = code;
    if (key !== undefined) this.key = key;
  }
}

export interface Plan {
  next: EnvSet;
  records: ChangeRecord[];
  /**
   * True when the plan writes, removes, unmasks or shadows a secret. The caller then needs a fresh
   * step-up: an override that replaces a secret is the same power as reading it.
   */
  touchesSecret: boolean;
}

/** Throws EnvPlanError on anything inconsistent, including a set of changes that changes nothing. */
export function plan(current: EnvSet, changes: ResolvedChange[], envOfApp: Map<string, string> = new Map()): Plan {
  const next: EnvSet = new Map(current);
  const records: ChangeRecord[] = [];
  const seen = new Set<string>();
  let touchesSecret = false;

  for (const c of changes) {
    const id = entryId(c.scope, c.scopeId, c.key);
    if (seen.has(id)) throw new EnvPlanError("DUPLICATE_CHANGE", `${c.key} is changed twice in one apply`, c.key);
    seen.add(id);
    const before = current.get(id);
    if (before && before.value === null && c.op !== "remove") {
      throw new EnvPlanError("UNREADABLE", `${c.key} could not be unsealed; remove it and add it again`, c.key);
    }
    const record = (e: { secret: boolean; target: Target }): ChangeRecord => ({
      environment: c.environment,
      ...(c.appId ? { appId: c.appId } : {}),
      ...(c.appName ? { appName: c.appName } : {}),
      key: c.key,
      op: c.op,
      secret: e.secret,
      target: e.target,
    });

    // Linking or unlinking a service hands an app its credential: the same power as setting a secret.
    if (P.isEnvRefValue(c.value) || P.isEnvRefValue(before?.value)) touchesSecret = true;

    if (c.op === "add") {
      if (before) throw new EnvPlanError("ALREADY_SET", `${c.key} is already set; change it instead`, c.key);
      if (c.value === undefined) throw new EnvPlanError("VALUE_REQUIRED", `${c.key} needs a value`, c.key);
      // A stored link is not itself secret, so listings can show what it points at; its credential is.
      const e: Entry = { scope: c.scope, scopeId: c.scopeId, key: c.key, value: c.value, secret: P.isEnvRefValue(c.value) ? false : (c.secret ?? true), target: c.target ?? "both" };
      next.set(id, e);
      records.push(record(e));
      if (e.secret) touchesSecret = true;
    } else if (c.op === "change") {
      if (!before) throw new EnvPlanError("NOT_SET", `${c.key} is not set; add it instead`, c.key);
      if (c.value === undefined && c.secret === undefined && c.target === undefined) {
        throw new EnvPlanError("EMPTY_CHANGE", `Nothing to change for ${c.key}`, c.key);
      }
      const value = c.value ?? before.value;
      const e: Entry = { ...before, value, secret: P.isEnvRefValue(value) ? false : (c.secret ?? before.secret), target: c.target ?? before.target };
      if (e.value === before.value && e.secret === before.secret && e.target === before.target) continue;
      next.set(id, e);
      records.push(record(e));
      if (before.secret || e.secret) touchesSecret = true;
    } else {
      if (!before) throw new EnvPlanError("NOT_SET", `${c.key} is not set`, c.key);
      next.delete(id);
      records.push(record(before));
      if (before.secret) touchesSecret = true;
    }
  }
  if (records.length === 0) throw new EnvPlanError("NO_CHANGES", "These changes match what is already set");
  return { next, records, touchesSecret: touchesSecret || shadowsSecret(current, changes, envOfApp) };
}

/**
 * An app override written over an environment secret of the same key counts as touching it.
 * Without the app's environment the check is conservative: any environment secret of that key.
 */
function shadowsSecret(current: EnvSet, changes: ResolvedChange[], envOfApp: Map<string, string>): boolean {
  for (const c of changes) {
    if (c.scope !== "app" || c.op === "remove") continue;
    const envId = envOfApp.get(c.scopeId);
    for (const e of current.values()) {
      if (e.scope === "environment" && e.key === c.key && e.secret && (envId === undefined || e.scopeId === envId)) return true;
    }
  }
  return false;
}

export function diff(from: EnvSet, to: EnvSet, label: (e: Entry) => { environment: string; appId?: string; appName?: string }): ResolvedChange[] {
  const out: ResolvedChange[] = [];
  for (const [id, b] of to) {
    const a = from.get(id);
    if (!a) {
      out.push({ ...label(b), scope: b.scope, scopeId: b.scopeId, key: b.key, op: "add", value: b.value ?? "", secret: b.secret, target: b.target });
    } else if (a.value !== b.value || a.secret !== b.secret || a.target !== b.target) {
      out.push({
        ...label(b), scope: b.scope, scopeId: b.scopeId, key: b.key, op: "change",
        ...(a.value !== b.value && b.value !== null ? { value: b.value } : {}),
        secret: b.secret, target: b.target,
      });
    }
  }
  for (const [id, a] of from) if (!to.has(id)) out.push({ ...label(a), scope: a.scope, scopeId: a.scopeId, key: a.key, op: "remove" });
  return out;
}

const inPhase = (t: Target, phase: Phase): boolean => phase === "all" || t === "both" || t === phase;

export function resolveFor(set: EnvSet, app: { id: string; environmentId: string }, phase: Phase): Map<string, Entry> {
  const winner = new Map<string, Entry>();
  for (const e of set.values()) if (e.scope === "environment" && e.scopeId === app.environmentId) winner.set(e.key, e);
  for (const e of set.values()) if (e.scope === "app" && e.scopeId === app.id) winner.set(e.key, e);
  const out = new Map<string, Entry>();
  for (const [k, e] of winner) if (inPhase(e.target, phase)) out.set(k, e);
  return out;
}

const sameResolved = (a: Map<string, Entry>, b: Map<string, Entry>): boolean => {
  if (a.size !== b.size) return false;
  for (const [k, e] of a) {
    const f = b.get(k);
    if (!f || f.value !== e.value) return false;
  }
  return true;
};

export interface Reach {
  appId: string;
  /** A build-time value changed, so the pinned image cannot be reused. */
  rebuild: boolean;
}

export function affectedApps(before: EnvSet, after: EnvSet, apps: Array<{ id: string; environmentId: string }>): Reach[] {
  const out: Reach[] = [];
  for (const app of apps) {
    const rebuild = !sameResolved(resolveFor(before, app, "build"), resolveFor(after, app, "build"));
    const runtime = !sameResolved(resolveFor(before, app, "runtime"), resolveFor(after, app, "runtime"));
    if (rebuild || runtime) out.push({ appId: app.id, rebuild });
  }
  return out;
}

const SnapshotEntry = z.strictObject({
  scope: z.enum(["environment", "app"]),
  scopeId: z.string().min(1).max(64),
  key: z.string().min(1).max(128),
  value: z.string(),
  secret: z.boolean(),
  target: z.enum(["build", "runtime", "both"]),
});
const Snapshot = z.strictObject({ v: z.literal(1), entries: z.array(SnapshotEntry) });

export function serializeSnapshot(set: EnvSet): string {
  const entries = [...set.values()]
    .filter((e) => e.value !== null)
    .map((e) => ({ scope: e.scope, scopeId: e.scopeId, key: e.key, value: e.value as string, secret: e.secret, target: e.target }))
    .sort((a, b) => idOf(a).localeCompare(idOf(b)));
  return JSON.stringify({ v: 1, entries });
}

export function parseSnapshot(raw: string): EnvSet {
  const parsed = Snapshot.parse(JSON.parse(raw));
  return toSet(parsed.entries);
}

/** Drops entries whose environment or app no longer exists, so a rollback skips what was deleted since. */
export function restrictTo(set: EnvSet, environmentIds: Set<string>, appIds: Set<string>): EnvSet {
  const out: EnvSet = new Map();
  for (const [id, e] of set) {
    if (e.scope === "environment" ? environmentIds.has(e.scopeId) : appIds.has(e.scopeId)) out.set(id, e);
  }
  return out;
}

/**
 * A secret is never unsealed for a listing, step-up or not: the audited per-key env.reveal route
 * is the one path to its plaintext.
 */
export const unsealForListing = (secret: boolean): boolean => !secret;

/** Null for a secret and for a reference, whatever the session's elevation. */
export const listedValue = (e: Pick<Entry, "secret" | "value">): string | null => (e.secret || P.isEnvRefValue(e.value) ? null : e.value);

export interface RefService {
  id: string;
  /** Also the host its connection details use. */
  name: string;
  displayName?: string | null;
  kind: NonNullable<P.EnvRefView["kind"]>;
  environmentId: string;
  redirectTo?: string | null;
}

const STATEFUL: ReadonlySet<string> = new Set(["postgres", "redis", "s3"]);

export const servicesOf = (apps: Array<{ id: string; name: string; displayName?: string | null; kind: string; environmentId: string; serviceRedirectId?: string | null }>): RefService[] =>
  apps.filter((a) => STATEFUL.has(a.kind)).map((a) => ({ id: a.id, name: a.name, ...(a.displayName ? { displayName: a.displayName } : {}), kind: a.kind as RefService["kind"], environmentId: a.environmentId, redirectTo: a.serviceRedirectId ?? null }));

/** Follows a version-change redirect one step only. */
const followRedirect = (svc: RefService, services: RefService[]): RefService => (svc.redirectTo ? (services.find((s) => s.id === svc.redirectTo) ?? svc) : svc);

/** Refuses a service outside the project. `services` must be the variable's own project, nothing wider. */
export function refService(ref: P.EnvRef, services: RefService[]): RefService {
  const svc = services.find((s) => s.id === ref.resourceId);
  if (!svc) throw new EnvPlanError("REF_OUTSIDE_PROJECT", "A variable can only link a database, cache or bucket in its own project");
  if (!P.refFieldAllowed(svc.kind, ref.field)) throw new EnvPlanError("REF_FIELD", `${svc.name} has no ${ref.field} to link`);
  return svc;
}

export const refValueFor = (ref: P.EnvRef, services: RefService[]): string => {
  refService(ref, services);
  return P.encodeEnvRef(ref);
};

export function refView(value: string | null, services: RefService[], envName: (id: string) => string): P.EnvRefView | undefined {
  const ref = P.decodeEnvRef(value);
  if (!ref) return undefined;
  const svc = services.find((s) => s.id === ref.resourceId);
  if (!svc) return { resourceId: ref.resourceId, resourceName: "Deleted service", kind: null, environment: "", field: ref.field, missing: true };
  const now = followRedirect(svc, services);
  const resourceName = now.displayName ? `${now.displayName} (${now.name})` : now.name;
  return { resourceId: svc.id, resourceName, kind: now.kind, environment: envName(now.environmentId), field: ref.field };
}

/**
 * A reference becomes its service's current credential. The service must be in `services` (the
 * app's own project), so a reference to another project's service, however stored, never resolves.
 */
export async function resolveValue(value: string, services: RefService[], open: (svc: RefService) => Promise<P.RefTarget>): Promise<string> {
  if (!P.isEnvRefValue(value)) return value;
  const ref = P.decodeEnvRef(value);
  if (!ref) throw new EnvPlanError("REF_MALFORMED", "A linked variable is malformed; link it again");
  return P.refValue(await open(followRedirect(refService(ref, services), services)), ref.field);
}
