import type { OverviewSource } from "./types";

// Shapes and rules shared by the banner, the popup, the loader and the tests. The release comes only
// from the signed feed, so the dashboard never raises or drops an alert on its own.

export type SecurityLevel = "critical" | "important";

export interface SecurityRelease {
  /** The release that carries the block, without a leading v. */
  version: string;
  level: SecurityLevel;
  /** Plain text from the signed feed. Rendered as text, never as markup. */
  summary: string;
  /** An https URL, or null. */
  advisory: string | null;
  cves: string[];
  publishedAt: string;
  /** The longest "Remind me in" this level allows, in days. */
  maxSnoozeDays: number;
}

export interface SecurityAlert {
  release: SecurityRelease | null;
  current: string;
  /** The release Update now installs, or null when none can be installed straight away. */
  target: string | null;
  /** Until when this member put the popup off, or null. The banner stays either way. */
  snoozedUntil: string | null;
  updating: { kind: "update" | "rollback"; version: string } | null;
}

export interface SecurityAlertResult {
  source: OverviewSource;
  data: SecurityAlert | null;
}

export const SNOOZE_DAYS = [1, 3, 7] as const;
export type SnoozeDays = (typeof SNOOZE_DAYS)[number];

/** The longest reminder each level allows, as the API enforces it. */
export const SNOOZE_CAP: Record<SecurityLevel, number> = { critical: 3, important: 7 };

/** What the popup's close key, Esc and a click outside count as: remind me tomorrow. */
export const CLOSE_SNOOZE: SnoozeDays = 1;

/** The reminder keys this release offers, never past its level's cap. */
export function snoozeChoices(r: Pick<SecurityRelease, "level" | "maxSnoozeDays">): SnoozeDays[] {
  const cap = Math.min(r.maxSnoozeDays > 0 ? r.maxSnoozeDays : SNOOZE_CAP[r.level], SNOOZE_CAP[r.level]);
  return SNOOZE_DAYS.filter((d) => d <= cap);
}

export const isSnoozed = (a: Pick<SecurityAlert, "snoozedUntil">, now: number) => !!a.snoozedUntil && Date.parse(a.snoozedUntil) > now;

/** The popup is due: an Admin, a pending security release, no reminder running, no update in flight. */
export function popupDue(a: SecurityAlert | null, admin: boolean, now: number): boolean {
  return !!a?.release && admin && !a.updating && !isSnoozed(a, now);
}

export const dayLabel = (d: number) => (d === 1 ? "1 day" : `${d} days`);
export const levelLabel = (l: SecurityLevel) => (l === "critical" ? "Critical" : "Important");
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/;

/** Compares two versions as the API does: negative when a < b, a prerelease before its release. */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) return a === b ? 0 : a < b ? -1 : 1;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d;
  }
  const ra = pa[4];
  const rb = pb[4];
  if (ra === rb) return 0;
  if (ra === undefined) return 1;
  if (rb === undefined) return -1;
  const xa = ra.split(".");
  const xb = rb.split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const s = xa[i];
    const t = xb[i];
    if (s === undefined) return -1;
    if (t === undefined) return 1;
    const ns = /^\d+$/.test(s);
    const nt = /^\d+$/.test(t);
    if (ns && nt && Number(s) !== Number(t)) return Number(s) - Number(t);
    if (ns !== nt) return ns ? -1 : 1;
    if (s !== t) return s < t ? -1 : 1;
  }
  return 0;
}

/** Install it, a newer release that includes it, or a stepping stone first when it needs a newer minimum version. */
export function updatePlan(a: Pick<SecurityAlert, "target">, r: Pick<SecurityRelease, "version">): "exact" | "newer" | "step" | "none" {
  if (!a.target) return "none";
  const c = compareVersions(a.target, r.version);
  return c === 0 ? "exact" : c > 0 ? "newer" : "step";
}

/** The reminder key the API stores, for the preview's own reminder. */
export const remindKey = (r: Pick<SecurityRelease, "version" | "level">) => `${r.version.replace(/^v/, "")}:${r.level}`;

const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown): x is string => typeof x === "string";
const VERSION = /^v?\d+\.\d+\.\d+(?:-[\w.]+)?$/;

/** The alert out of an answer, or null when it is not one this dashboard can read (an older API). */
export function readAlert(raw: unknown): SecurityAlert | null {
  if (!isRecord(raw) || !str(raw.current)) return null;
  let release: SecurityRelease | null = null;
  const r = raw.release;
  if (isRecord(r)) {
    const level = r.level === "critical" || r.level === "important" ? r.level : null;
    if (!level || !str(r.version) || !VERSION.test(r.version) || !str(r.summary) || !str(r.publishedAt)) return null;
    release = {
      version: r.version.replace(/^v/, ""),
      level,
      summary: r.summary,
      advisory: str(r.advisory) && /^https:\/\//i.test(r.advisory) ? r.advisory : null,
      cves: Array.isArray(r.cves) ? r.cves.filter(str).slice(0, 20) : [],
      publishedAt: r.publishedAt,
      maxSnoozeDays: typeof r.maxSnoozeDays === "number" ? r.maxSnoozeDays : SNOOZE_CAP[level],
    };
  } else if (r !== null && r !== undefined) {
    return null;
  }
  const u = raw.updating;
  return {
    release,
    current: raw.current,
    target: str(raw.target) ? raw.target : null,
    snoozedUntil: str(raw.snoozedUntil) ? raw.snoozedUntil : null,
    updating: isRecord(u) && (u.kind === "update" || u.kind === "rollback") && str(u.version) ? { kind: u.kind, version: u.version } : null,
  };
}
