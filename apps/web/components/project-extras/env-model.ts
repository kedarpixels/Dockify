import type { AppSummary, EnvChange, EnvEntry, EnvRef, EnvRefView, EnvState, EnvTarget, EnvVersion } from "@/lib/pages/project-detail";
import type { ActorRef, AppKind } from "@/lib/types";
import { appTitle } from "@/lib/format";

// Pure and framework free. Edits never touch the stored state: they collect as EnvChange records,
// and every view is the stored entries with the staged changes laid over them.

/** Where a variable lives: an environment's shared set, or one app's overrides in it. */
export interface Scope {
  environment: string;
  appId?: string;
}

export const scopeId = (s: Scope) => (s.appId ? `${s.environment}:${s.appId}` : s.environment);
export const changeId = (s: Scope, key: string) => `${scopeId(s)}|${key}`;

export type Staged = ReadonlyMap<string, EnvChange>;

export type RowState = "same" | "added" | "changed" | "removed";

export interface EnvRow {
  key: string;
  /** What is stored now, absent for a staged add. */
  base?: EnvEntry;
  change?: EnvChange;
  state: RowState;
  /** The value the row shows: staged, else stored. Null when it is a secret not yet revealed. */
  value: string | null;
  /** True when the staged edit replaces the value, so a reveal is not needed to know it. */
  valueStaged: boolean;
  secret: boolean;
  target: EnvTarget;
  /** The service the row links, staged or stored. A linked row has no value of its own to show. */
  ref?: EnvRef;
}

export const TARGET_LABEL: Record<EnvTarget, string> = { build: "Build", runtime: "Runtime", both: "Build and runtime" };
export const TARGET_SHORT: Record<EnvTarget, string> = { build: "Build", runtime: "Runtime", both: "Both" };

/** Managed services take their settings from Dockify, not from the project's variables. */
const READS_ENV: Record<AppKind, boolean> = { frontend: true, backend: true, bot: true, postgres: false, redis: false, s3: false };

export function varsOf(state: EnvState, s: Scope): EnvEntry[] {
  if (s.appId) return state.overrides.find((o) => o.appId === s.appId && o.environment === s.environment)?.vars ?? [];
  return state.environments.find((e) => e.name === s.environment)?.vars ?? [];
}

const sameRef = (a: EnvRef | undefined, b: EnvRef | undefined) => !!a && !!b && a.resourceId === b.resourceId && a.field === b.field;

export function changesIn(staged: Staged, s: Scope): EnvChange[] {
  const id = scopeId(s);
  return [...staged.values()].filter((c) => scopeId(c) === id);
}

export function rowsOf(base: EnvEntry[], changes: EnvChange[]): EnvRow[] {
  const byKey = new Map(changes.map((c) => [c.key, c]));
  const rows: EnvRow[] = base.map((b) => {
    const c = byKey.get(b.key);
    byKey.delete(b.key);
    if (!c) return { key: b.key, base: b, state: "same", value: b.value, valueStaged: false, secret: b.secret, target: b.target, ref: b.ref };
    if (c.op === "remove") return { key: b.key, base: b, change: c, state: "removed", value: b.value, valueStaged: false, secret: b.secret, target: b.target, ref: b.ref };
    // A staged link replaces the value; a staged value (an unlink) drops the stored link.
    const ref = c.ref ?? (c.value !== undefined ? undefined : b.ref);
    return {
      key: b.key,
      base: b,
      change: c,
      state: "changed",
      value: c.ref ? null : (c.value ?? b.value),
      valueStaged: c.value !== undefined,
      secret: ref ? true : (c.secret ?? b.secret),
      target: c.target ?? b.target,
      ref,
    };
  });
  for (const c of byKey.values()) {
    if (c.op === "remove") continue;
    rows.push({
      key: c.key,
      change: c,
      state: "added",
      value: c.ref ? null : (c.value ?? ""),
      valueStaged: !c.ref,
      secret: c.ref ? true : (c.secret ?? true),
      target: c.target ?? "runtime",
      ref: c.ref,
    });
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

/** An edit that lands back on the stored entry drops out, and a removal of a staged add forgets the add. */
export function stage(staged: Staged, next: EnvChange, base: EnvEntry | undefined): Map<string, EnvChange> {
  const out = new Map(staged);
  const id = changeId(next, next.key);
  const prev = out.get(id);

  if (next.op === "remove") {
    if (!base) out.delete(id);
    else out.set(id, { environment: next.environment, appId: next.appId, key: next.key, op: "remove" });
    return out;
  }

  if (!base) {
    const target = next.target ?? prev?.target ?? "runtime";
    const link = next.ref ?? (next.value === undefined ? prev?.ref : undefined);
    out.set(
      id,
      link
        ? { environment: next.environment, appId: next.appId, key: next.key, op: "add", ref: link, secret: true, target }
        : { ...next, op: "add", ref: undefined, value: next.value ?? prev?.value ?? "", secret: next.secret ?? prev?.secret ?? true, target },
    );
    return out;
  }

  // A link is compared by what it points at; a value set over a link is always a change (an unlink).
  const value = next.value;
  const sameLink = next.ref ? sameRef(next.ref, base.ref) : undefined;
  const sameValue = next.ref ? sameLink! : value === undefined || (base.value !== null && !base.ref && value === base.value);
  const linked = next.ref ?? (value === undefined ? base.ref : undefined);
  // A link always reads as secret, so its flag is never part of the change.
  const sameSecret = linked ? true : (next.secret ?? base.secret) === base.secret;
  const sameTarget = (next.target ?? base.target) === base.target;
  if (sameValue && sameSecret && sameTarget) {
    out.delete(id);
    return out;
  }
  out.set(id, {
    environment: next.environment,
    appId: next.appId,
    key: next.key,
    op: "change",
    value: sameValue || next.ref ? undefined : value,
    ref: next.ref && !sameLink ? next.ref : undefined,
    secret: linked ? undefined : (next.secret ?? base.secret),
    target: next.target ?? base.target,
  });
  return out;
}

export function unstage(staged: Staged, s: Scope, key: string): Map<string, EnvChange> {
  const out = new Map(staged);
  out.delete(changeId(s, key));
  return out;
}

export interface Affected {
  app: AppSummary;
  /** A build-time variable changed, so the app rebuilds; otherwise it restarts on its current image. */
  rebuild: boolean;
  keys: string[];
}

/** Public by nature, and a secret never reaches the build as an ARG. Mirrors the contracts' isPublicBuildKey, which the web does not import. */
export const isPublicBuildKey = (key: string): boolean => /^(?:NEXT_PUBLIC_|NUXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|GATSBY_|EXPO_PUBLIC_)/.test(key);

/** A shared change reaches every app in its environment that reads env, except apps whose own override of that key still stands. */
export function affectedApps(changes: EnvChange[], state: EnvState, apps: AppSummary[]): Affected[] {
  const hit = new Map<string, Affected>();
  const touch = (app: AppSummary, key: string, target: EnvTarget) => {
    const a = hit.get(app.id) ?? { app, rebuild: false, keys: [] };
    a.rebuild ||= target !== "runtime";
    if (!a.keys.includes(key)) a.keys.push(key);
    hit.set(app.id, a);
  };
  for (const c of changes) {
    const base = varsOf(state, c).find((v) => v.key === c.key);
    // A target change matters under both targets: the old one loses the key, the new one gains it.
    const target: EnvTarget = c.target && base && c.target !== base.target ? "both" : (c.target ?? base?.target ?? "runtime");
    const inEnv = apps.filter((a) => a.environment === c.environment && READS_ENV[a.kind]);
    if (c.appId) {
      const app = inEnv.find((a) => a.id === c.appId);
      if (app) touch(app, c.key, target);
      continue;
    }
    for (const app of inEnv) {
      const overridden = varsOf(state, { environment: c.environment, appId: app.id }).some((v) => v.key === c.key);
      const overrideRemoved = changes.some((x) => x.appId === app.id && x.environment === c.environment && x.key === c.key && x.op === "remove");
      if (!overridden || overrideRemoved) touch(app, c.key, target);
    }
  }
  return [...hit.values()].sort((a, b) => appTitle(a.app).localeCompare(appTitle(b.app)));
}

/** The listing view of a link, from the project's own apps, as the API would send it. */
export function refViewOf(ref: EnvRef, apps: AppSummary[]): EnvRefView {
  const svc = apps.find((a) => a.id === ref.resourceId && (a.kind === "postgres" || a.kind === "redis" || a.kind === "s3"));
  if (!svc) return { ...ref, resourceName: "Deleted service", kind: null, environment: "", missing: true };
  // As the API names it: a renamed service by its display name, with the name its connection details use.
  return { ...ref, resourceName: svc.displayName ? `${svc.displayName} (${svc.name})` : svc.name, kind: svc.kind as EnvRefView["kind"], environment: svc.environment };
}

/** The stored state after an apply, for the preview and for an answer that does not carry the new state. */
export function applyLocal(state: EnvState, changes: EnvChange[], apps: AppSummary[], version: number, actor: string): EnvState {
  const at = new Date().toISOString();
  const edit = (vars: EnvEntry[], scoped: EnvChange[]) => {
    const next = vars.filter((v) => !scoped.some((c) => c.key === v.key && c.op === "remove"));
    for (const c of scoped) {
      if (c.op === "remove") continue;
      const i = next.findIndex((v) => v.key === c.key);
      const prev = i >= 0 ? next[i] : undefined;
      const ref = c.ref ? refViewOf(c.ref, apps) : c.value === undefined ? prev?.ref : undefined;
      const secret = ref ? true : (c.secret ?? prev?.secret ?? true);
      // Secrets and links go back behind reveal once stored, the same as the API would send them.
      const value = secret ? null : (c.value ?? prev?.value ?? "");
      const entry: EnvEntry = { key: c.key, value, secret, target: c.target ?? prev?.target ?? "runtime", updatedAt: at, updatedBy: actor, ...(ref ? { ref } : {}) };
      if (i >= 0) next[i] = entry;
      else next.push(entry);
    }
    return next;
  };

  const environments = state.environments.map((e) => ({ ...e, vars: edit(e.vars, changes.filter((c) => !c.appId && c.environment === e.name)) }));
  const overrides = state.overrides.map((o) => ({ ...o, vars: edit(o.vars, changes.filter((c) => c.appId === o.appId && c.environment === o.environment)) }));
  for (const c of changes) {
    if (!c.appId || c.op === "remove" || overrides.some((o) => o.appId === c.appId && o.environment === c.environment)) continue;
    const app = apps.find((a) => a.id === c.appId);
    overrides.push({ appId: c.appId, appName: app ? appTitle(app) : c.appId, environment: c.environment, vars: edit([], changes.filter((x) => x.appId === c.appId && x.environment === c.environment)) });
  }
  return { version, environments, overrides: overrides.filter((o) => o.vars.length) };
}

export function versionOf(changes: EnvChange[], state: EnvState, apps: AppSummary[], version: number, actor: ActorRef, redeployed: number): EnvVersion {
  return {
    version,
    at: new Date().toISOString(),
    actor: actor.name,
    actorAvatarUrl: actor.avatarUrl,
    actorKind: actor.kind,
    source: "dashboard",
    changes: changes.map((c) => {
      const base = varsOf(state, c).find((v) => v.key === c.key);
      return {
        environment: c.environment,
        appId: c.appId,
        appName: c.appId ? apps.find((a) => a.id === c.appId)?.name : undefined,
        key: c.key,
        op: c.op,
        secret: c.secret ?? base?.secret ?? false,
        target: c.target ?? base?.target ?? "runtime",
      };
    }),
    redeployed,
  };
}

/** "2 added, 1 changed, 1 removed": the counts in a fixed order, zeros left out. */
export function summarize(ops: Array<{ op: EnvChange["op"] }>): string {
  const n = { add: 0, change: 0, remove: 0 };
  for (const c of ops) n[c.op]++;
  const parts = [n.add ? `${n.add} added` : "", n.change ? `${n.change} changed` : "", n.remove ? `${n.remove} removed` : ""].filter(Boolean);
  return parts.length ? parts.join(", ") : "No changes";
}
