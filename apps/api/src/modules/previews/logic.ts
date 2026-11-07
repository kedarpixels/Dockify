/**
 * Pull request preview rules, pure so the tests can pin them without a database:
 *
 *   which apps a preview includes        includedInPreviews
 *   whether a new preview may start      diskGuard, planAdmission (caps and eviction)
 *   which base environment it copies     pickBaseEnvironment
 *
 * A preview is the ephemeral environment pr-<n>: one container per included app, cloned from the
 * base environment (default development, production never by default), pointing at the base
 * environment's services through linked env references or at its own temporary Postgres. Production's
 * secrets and services stay out unless the owner allows them (P.previewIsolation).
 */
import type { PreviewStatus } from "@dockify/db";

/** No new previews above this much disk use. */
export const DISK_GUARD_PCT = 85;
/** A disk sample older than this is not trusted to refuse a preview. */
export const DISK_SAMPLE_MAX_AGE_MS = 15 * 60_000;

/** Statuses that hold a slot under the caps. */
export const LIVE: readonly PreviewStatus[] = ["building", "ready", "asleep", "failed"];
export const isLive = (s: PreviewStatus): boolean => LIVE.includes(s);

/** Kinds a preview can include at all. Databases and storage are never cloned. */
export const PREVIEW_KINDS = new Set(["frontend", "backend", "bot"]);
/** Kinds included when the owner has not chosen. */
const DEFAULT_KINDS = new Set(["frontend", "backend"]);

export interface PreviewCandidateApp {
  kind: string;
  previewEnabled: boolean | null;
  gitRepository: string | null;
  deployTarget: string;
}

/**
 * An app is in a preview when the owner marked it, or by kind when nobody chose. Only git-built server
 * apps can build a PR: Vercel builds its own previews of a Vercel app, followed or deploy target, so
 * building one here would be a second copy.
 */
export function includedInPreviews(a: PreviewCandidateApp): boolean {
  if (!PREVIEW_KINDS.has(a.kind) || !a.gitRepository || a.deployTarget !== "server") return false;
  return a.previewEnabled ?? DEFAULT_KINDS.has(a.kind);
}

/** The column default of projects.previewBaseEnv: a name nobody picked, and many projects call it something else. */
export const DEFAULT_PREVIEW_BASE = "development";

/**
 * The base environment by name; never production unless the owner named it. A project that never
 * picked a base, and whose one environment besides production is named otherwise (often `dev`), gets
 * that one: the default only ever meant "the development environment". Found on the test box, where
 * the form offered "Development (Not found)" next to the real one, and no preview had a base.
 */
export function pickBaseEnvironment<T extends { name: string }>(envs: T[], wanted: string): T | null {
  const named = envs.find((e) => e.name === wanted);
  if (named) return named;
  if (envs.length === 1) return envs[0]!;
  const others = envs.filter((e) => e.name !== "production");
  return wanted === DEFAULT_PREVIEW_BASE && others.length === 1 ? others[0]! : null;
}

/**
 * Whether a project's previews get their own database. A project with one environment has nothing
 * but its real data to share, so a preview never falls back to it: always its own, whatever is stored.
 */
export function previewNeedsOwnDb(p: { environments: readonly unknown[]; previewIsolatedDb: boolean }): boolean {
  return p.previewIsolatedDb || p.environments.length < 2;
}

/** `pr-42-web.preview.example.com`. One label for the PR and app keeps a wildcard record and cert valid. */
export function previewHostname(pr: number, appName: string, domain: string): string {
  const label = `pr-${pr}-${appName}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63).replace(/-+$/, "");
  return `${label}.${domain.toLowerCase()}`;
}

export const previewName = (pr: number): string => `pr-${pr}`;

export interface DiskSample {
  diskBytes: bigint | number | null;
  diskTotalBytes: bigint | number | null;
  at: Date;
}

/** Disk use in percent from the newest host sample, or null when unknown or stale. */
export function diskPct(sample: DiskSample | null, now = Date.now()): number | null {
  if (!sample || sample.diskBytes === null || sample.diskTotalBytes === null) return null;
  const total = Number(sample.diskTotalBytes);
  if (!(total > 0) || now - sample.at.getTime() > DISK_SAMPLE_MAX_AGE_MS) return null;
  return Math.round((Number(sample.diskBytes) / total) * 1000) / 10;
}

export const diskBlocks = (pct: number | null): boolean => pct !== null && pct > DISK_GUARD_PCT;

export interface LivePreview {
  id: string;
  projectId: string;
  prNumber: number;
  status: PreviewStatus;
  /** The later of the last commit and the last request. */
  lastActivity: Date;
}

export type Admission = { kind: "admit"; evict: LivePreview[] } | { kind: "blocked"; scope: "project" | "server" };

/** Asleep first, then the one nobody touched for longest. A building preview is never evicted. */
function evictionOrder(rows: LivePreview[]): LivePreview[] {
  return rows
    .filter((r) => r.status !== "building")
    .sort((a, b) => (a.status === "asleep") !== (b.status === "asleep") ? (a.status === "asleep" ? -1 : 1) : a.lastActivity.getTime() - b.lastActivity.getTime());
}

/**
 * Whether a new preview of `projectId` may start under the project and server caps, and which
 * existing previews go to make room: the oldest idle one in the project for the project cap, then
 * the oldest idle one anywhere for the server cap. Blocked when nothing can be evicted.
 */
export function planAdmission(live: LivePreview[], projectId: string, projectCap: number, serverCap: number): Admission {
  const evict: LivePreview[] = [];
  const gone = (r: LivePreview) => evict.some((e) => e.id === r.id);
  for (;;) {
    const mine = live.filter((r) => r.projectId === projectId && !gone(r));
    if (mine.length < projectCap) break;
    const next = evictionOrder(mine)[0];
    if (!next) return { kind: "blocked", scope: "project" };
    evict.push(next);
  }
  for (;;) {
    const all = live.filter((r) => !gone(r));
    if (all.length < serverCap) break;
    const next = evictionOrder(all)[0];
    if (!next) return { kind: "blocked", scope: "server" };
    evict.push(next);
  }
  return { kind: "admit", evict };
}

/** The TTL deadline: no commit for ttlHours deletes the preview. */
export const expiresAt = (lastCommitAt: Date, ttlHours: number): Date => new Date(lastCommitAt.getTime() + ttlHours * 3600_000);
