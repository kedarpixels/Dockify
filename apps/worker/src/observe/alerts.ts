/**
 * The alert engine, pure. Given the rules, what the sampler and probes see now, the open events and
 * the mutes, it decides which events to open and which to resolve. The runner (alert-runner.ts)
 * does the I/O around it.
 *
 * Semantics:
 *  - A rule watches one or more subjects: the host (disk), a control-plane service, or apps (one app,
 *    or every app when appId is null). One open event per (rule, subject): that is the dedupe.
 *  - Gauge rules (disk, memory, down, service) fire after the condition held for durationMin, and
 *    resolve after it has been clear for CLEAR_MS. Disk and memory clear only HYSTERESIS points under
 *    the threshold, so a value hovering at the line cannot flap.
 *  - Window rules (crash loop) already measure over durationMin, so they fire at once.
 *  - No data (null) holds the current state: a blind tick never opens or resolves anything.
 *  - A muted app's events are recorded with muted = true and are never sent to email or webhooks.
 */
import { server as S } from "@dockify/contracts";

export type Metric = "disk" | "service" | "down" | "crash_loop" | "memory";
export type Service = "any" | "api" | "worker" | "proxy" | "database";
/** discord and webhook are values earlier versions stored; migration 0003 turned them into webhook links. */
export type Channel = "discord" | "webhook" | "email" | "bell";

export interface Rule {
  id: string;
  metric: Metric;
  appId: string | null;
  service: Service | null;
  threshold: number | null;
  durationMin: number;
  channels: Channel[];
  /** The enabled webhooks the rule sends to, by id. */
  webhooks: string[];
  enabled: boolean;
}

export const DEFAULT_THRESHOLD: Record<Metric, number> = { disk: S.DISK_ALERT_DEFAULT_PCT, memory: 90, crash_loop: 3, down: 0, service: 0 };
export const CLEAR_MS = 60_000;
export const HYSTERESIS = 5;
const WINDOW_RULES = new Set<Metric>(["crash_loop"]);
const APP_RULES = new Set<Metric>(["down", "crash_loop", "memory"]);

export interface AppView {
  id: string;
  /** The name an alert's detail reads: the app's display name when it has one. */
  name: string;
  /** False for an app that should not be running (stopped, deploying, never deployed, on Vercel). */
  expectRunning: boolean;
  /** Null when the container list could not be read this tick. */
  container: { state: string; health: string | null; memBytes: number | null; memLimitBytes: number } | null | undefined;
  /** Restart timestamps (ms) of the current container. */
  restarts: number[];
}

export interface World {
  now: number;
  disk: { usedBytes: number; totalBytes: number } | null;
  /** Service up (true), down (false) or unknown (null, no probe configured). */
  services: Record<Exclude<Service, "any">, boolean | null>;
  /** Why a service counts as down, when it says so itself (the worker's own issues). */
  serviceDetail?: Partial<Record<Exclude<Service, "any">, string>>;
  apps: Map<string, AppView>;
  /** False when Docker could not be read at all, so app rules hold. */
  dockerSeen: boolean;
}

export interface OpenEvent {
  id: string;
  ruleId: string;
  subject: string;
}

export interface Track {
  breachSince?: number;
  clearSince?: number;
}

export interface Opened {
  rule: Rule;
  subject: string;
  appId: string | null;
  service: Exclude<Service, "any"> | null;
  detail: string;
  href: string;
  muted: boolean;
}

export interface Decision {
  open: Opened[];
  resolve: Array<{ eventId: string; reason: string }>;
}

interface Reading {
  breached: boolean | null;
  detail: string;
}

export interface Subject {
  key: string;
  appId: string | null;
  service: Exclude<Service, "any"> | null;
}

const fmtPct = (n: number): string => `${Math.round(n)}%`;
const SERVICES: Array<Exclude<Service, "any">> = ["api", "worker", "proxy", "database"];

export function subjectsFor(rule: Rule, world: World): Subject[] {
  if (rule.metric === "disk") return [{ key: "host", appId: null, service: null }];
  if (rule.metric === "service") {
    const list = !rule.service || rule.service === "any" ? SERVICES : [rule.service];
    return list.map((s) => ({ key: `service:${s}`, appId: null, service: s }));
  }
  if (rule.appId) return [{ key: `app:${rule.appId}`, appId: rule.appId, service: null }];
  return [...world.apps.keys()].map((id) => ({ key: `app:${id}`, appId: id, service: null }));
}

export function read(rule: Rule, s: Subject, world: World, isOpen: boolean): Reading {
  const t = rule.threshold ?? DEFAULT_THRESHOLD[rule.metric];
  const line = isOpen ? t - HYSTERESIS : t;
  if (rule.metric === "disk") {
    if (!world.disk || world.disk.totalBytes <= 0) return { breached: null, detail: "" };
    const pct = (world.disk.usedBytes / world.disk.totalBytes) * 100;
    return { breached: pct >= line, detail: `Disk is ${fmtPct(pct)} full (alert at ${fmtPct(t)})` };
  }
  if (rule.metric === "service") {
    const up = s.service ? world.services[s.service] : null;
    return { breached: up === null ? null : !up, detail: (s.service && world.serviceDetail?.[s.service]) || `The ${s.service} service is not responding` };
  }
  const app = s.appId ? world.apps.get(s.appId) : undefined;
  if (!app || !world.dockerSeen) return { breached: null, detail: "" };
  const name = app.name;
  switch (rule.metric) {
    case "down": {
      if (!app.expectRunning) return { breached: false, detail: "" };
      const c = app.container;
      if (c === undefined) return { breached: null, detail: "" };
      const down = c === null || c.state !== "running" || c.health === "unhealthy";
      const why = c === null ? "has no container" : c.health === "unhealthy" ? "is failing its health check" : `is ${c.state}`;
      return { breached: down, detail: `${name} ${why}` };
    }
    case "crash_loop": {
      const n = app.restarts.filter((at) => at > world.now - rule.durationMin * 60_000).length;
      return { breached: n >= t, detail: `${name} restarted ${n} times in ${rule.durationMin} min` };
    }
    case "memory": {
      const c = app.container;
      if (!c || c.memBytes === null || c.memLimitBytes <= 0) return { breached: null, detail: "" };
      const pct = (c.memBytes / c.memLimitBytes) * 100;
      return { breached: pct >= line, detail: `${name} is using ${fmtPct(pct)} of its memory limit` };
    }
    default:
      return { breached: null, detail: "" };
  }
}

/** One step of the per-subject state machine. */
export function step(
  prev: Track,
  breached: boolean | null,
  now: number,
  holdMs: number,
  isOpen: boolean,
): { track: Track; action: "open" | "resolve" | null } {
  if (breached === null) return { track: prev, action: null };
  if (breached) {
    const since = prev.breachSince ?? now;
    const track: Track = { breachSince: since };
    return { track, action: !isOpen && now - since >= holdMs ? "open" : null };
  }
  if (!isOpen) return { track: {}, action: null };
  const clear = prev.clearSince ?? now;
  return { track: { clearSince: clear }, action: now - clear >= CLEAR_MS ? "resolve" : null };
}

const hrefFor = (rule: Rule, s: Subject): string => {
  if (!s.appId) return "/server";
  if (rule.metric === "crash_loop") return `/apps/${s.appId}?tab=logs`;
  if (rule.metric === "memory") return `/apps/${s.appId}?tab=metrics`;
  return `/apps/${s.appId}`;
};

export const trackKey = (ruleId: string, subject: string): string => `${ruleId}|${subject}`;

/**
 * Evaluates every rule once. `tracks` is mutated (it is the engine's memory between ticks).
 * Events whose rule is gone or disabled, or whose app no longer exists, are resolved.
 */
export function evaluate(
  rules: Rule[],
  world: World,
  open: OpenEvent[],
  mutedApps: Set<string>,
  tracks: Map<string, Track>,
): Decision {
  const out: Decision = { open: [], resolve: [] };
  const openByKey = new Map(open.map((e) => [trackKey(e.ruleId, e.subject), e]));
  const live = new Set<string>();

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (APP_RULES.has(rule.metric) && rule.service) continue;
    const hold = WINDOW_RULES.has(rule.metric) ? 0 : rule.durationMin * 60_000;
    for (const s of subjectsFor(rule, world)) {
      const key = trackKey(rule.id, s.key);
      live.add(key);
      const existing = openByKey.get(key);
      const r = read(rule, s, world, !!existing);
      const { track, action } = step(tracks.get(key) ?? {}, r.breached, world.now, hold, !!existing);
      tracks.set(key, track);
      if (action === "open") {
        out.open.push({
          rule, subject: s.key, appId: s.appId, service: s.service, detail: r.detail.slice(0, 500),
          href: hrefFor(rule, s), muted: !!s.appId && mutedApps.has(s.appId),
        });
      } else if (action === "resolve" && existing) {
        out.resolve.push({ eventId: existing.id, reason: "cleared" });
      }
    }
  }
  for (const [key, e] of openByKey) {
    if (!live.has(key)) out.resolve.push({ eventId: e.id, reason: "rule or app removed" });
  }
  for (const key of [...tracks.keys()]) if (!live.has(key)) tracks.delete(key);
  return out;
}

/** The subject key an existing event row maps to, so a restarted worker re-adopts its open events. */
export function subjectOfEvent(e: { metric: Metric; appId: string | null; service: Service | null }): string {
  if (e.metric === "disk") return "host";
  if (e.metric === "service") return `service:${e.service ?? "any"}`;
  return `app:${e.appId ?? "none"}`;
}
