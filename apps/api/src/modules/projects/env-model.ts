/**
 * The env var model as pure functions: a project's variables are one set of entries, each at
 * environment scope or at app scope (a per-app override). Apply, diff, rollback and "which apps
 * does this change reach" are all computed here, so the database layer only loads and stores.
 *
 * Precedence is the old single resolver's rule: app beats environment. The phase filter applies
 * last, so a runtime-only override still hides the environment value from the build as well.
 */
import { z } from "zod";
import { projects as P } from "@dockify/contracts";

export type Target = "build" | "runtime" | "both";
export type Scope = "environment" | "app";
export type Op = "add" | "change" | "remove";
export type Phase = "build" | "runtime" | "all";

export interface Entry {
  scope: Scope;
  /** The environment id or the app id. */
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

/** A change after the handler resolved environment names and app ids to scope ids. */
export interface ResolvedChange {
  scope: Scope;
  scopeId: string;
  /** For records: the environment name, and the app when the change is an override. */
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
   * step-up: an override that replaces a secret is the same power as reading it (audit 02-api H).
   */
  touchesSecret: boolean;
}

/** Applies staged changes to the current set. Throws EnvPlanError on anything inconsistent. */
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

/** The changes that turn `from` into `to`, used by rollback and by environment copy. */
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

/** The variables one app receives in a phase: environment entries, overridden by app entries. */
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

/** The apps whose effective variables differ between two sets, and whether each needs a rebuild. */
export function affectedApps(before: EnvSet, after: EnvSet, apps: Array<{ id: string; environmentId: string }>): Reach[] {
  const out: Reach[] = [];
  for (const app of apps) {
    const rebuild = !sameResolved(resolveFor(before, app, "build"), resolveFor(after, app, "build"));
    const runtime = !sameResolved(resolveFor(before, app, "runtime"), resolveFor(after, app, "runtime"));
    if (rebuild || runtime) out.push({ appId: app.id, rebuild });
  }
  return out;
}

// ------------------------------------------------------------------ snapshots

const SnapshotEntry = z.strictObject({
  scope: z.enum(["environment", "app"]),
  scopeId: z.string().min(1).max(64),
  key: z.string().min(1).max(128),
  value: z.string(),
  secret: z.boolean(),
  target: z.enum(["build", "runtime", "both"]),
});
const Snapshot = z.strictObject({ v: z.literal(1), entries: z.array(SnapshotEntry) });

/** The full state after a version, sealed as one env_version secret. */
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

/** Keeps only entries whose environment or app still exists. Rollback skips what was deleted since. */
export function restrictTo(set: EnvSet, environmentIds: Set<string>, appIds: Set<string>): EnvSet {
  const out: EnvSet = new Map();
  for (const [id, e] of set) {
    if (e.scope === "environment" ? environmentIds.has(e.scopeId) : appIds.has(e.scopeId)) out.set(id, e);
  }
  return out;
}

/**
 * Listing routes (env.get, env.put, env.state) unseal plain values only. A secret is never read for a
 * listing, step-up or not: the audited per-key env.reveal route is the one path to its plaintext.
 */
export const unsealForListing = (secret: boolean): boolean => !secret;

/** The value a listing route may send: null for a secret and for a reference, whatever the session's elevation. */
export const listedValue = (e: Pick<Entry, "secret" | "value">): string | null => (e.secret || P.isEnvRefValue(e.value) ? null : e.value);

// ------------------------------------------------------------------ references

/** A managed service of the project, as references see it. */
export interface RefService {
  id: string;
  name: string;
  kind: NonNullable<P.EnvRefView["kind"]>;
  environmentId: string;
  /** Set after a version change switched this service's links to another one. */
  redirectTo?: string | null;
}

const STATEFUL: ReadonlySet<string> = new Set(["postgres", "redis", "s3"]);

/** The project's services, from its apps. Only these can be linked. */
export const servicesOf = (apps: Array<{ id: string; name: string; kind: string; environmentId: string; serviceRedirectId?: string | null }>): RefService[] =>
  apps.filter((a) => STATEFUL.has(a.kind)).map((a) => ({ id: a.id, name: a.name, kind: a.kind as RefService["kind"], environmentId: a.environmentId, redirectTo: a.serviceRedirectId ?? null }));

/** Where a link to this service leads now: the new service after a version change, one step only. */
const followRedirect = (svc: RefService, services: RefService[]): RefService => (svc.redirectTo ? (services.find((s) => s.id === svc.redirectTo) ?? svc) : svc);

/**
 * The service a reference points at, refusing one outside the project (or not a service at all)
 * and a field that kind does not offer. `services` is the variable's own project, nothing wider.
 */
export function refService(ref: P.EnvRef, services: RefService[]): RefService {
  const svc = services.find((s) => s.id === ref.resourceId);
  if (!svc) throw new EnvPlanError("REF_OUTSIDE_PROJECT", "A variable can only link a database, cache or bucket in its own project");
  if (!P.refFieldAllowed(svc.kind, ref.field)) throw new EnvPlanError("REF_FIELD", `${svc.name} has no ${ref.field} to link`);
  return svc;
}

/** The stored form of a link, after checking it stays inside the project. */
export const refValueFor = (ref: P.EnvRef, services: RefService[]): string => {
  refService(ref, services);
  return P.encodeEnvRef(ref);
};

/** The listing view of a stored reference; `missing` when its service was deleted since. */
export function refView(value: string | null, services: RefService[], envName: (id: string) => string): P.EnvRefView | undefined {
  const ref = P.decodeEnvRef(value);
  if (!ref) return undefined;
  const svc = services.find((s) => s.id === ref.resourceId);
  if (!svc) return { resourceId: ref.resourceId, resourceName: "Deleted service", kind: null, environment: "", field: ref.field, missing: true };
  const now = followRedirect(svc, services);
  return { resourceId: svc.id, resourceName: now.name, kind: now.kind, environment: envName(now.environmentId), field: ref.field };
}

/**
 * Resolves one value: plain values pass through, a reference becomes its service's current
 * credential. The service must be in `services` (the app's own project), so a reference that
 * names another project's service, however it was stored, never resolves.
 */
export async function resolveValue(value: string, services: RefService[], open: (svc: RefService) => Promise<P.RefTarget>): Promise<string> {
  if (!P.isEnvRefValue(value)) return value;
  const ref = P.decodeEnvRef(value);
  if (!ref) throw new EnvPlanError("REF_MALFORMED", "A linked variable is malformed; link it again");
  return P.refValue(await open(followRedirect(refService(ref, services), services)), ref.field);
}
