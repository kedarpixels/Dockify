// A preview is the ephemeral environment pr-<n>: one container per included app, cloned from the
// base environment. Production is never the base, and its secrets and services stay out, unless
// the owner allows it.
import type { PreviewStatus } from "@dockify/db";

export const DISK_GUARD_PCT = 85;
/** A staler disk sample is not trusted to refuse a preview. */
export const DISK_SAMPLE_MAX_AGE_MS = 15 * 60_000;

/** Statuses that hold a slot under the caps. A failed preview still holds its containers. */
export const LIVE: readonly PreviewStatus[] = ["building", "ready", "asleep", "failed"];
export const isLive = (s: PreviewStatus): boolean => LIVE.includes(s);

/** Databases and storage are never cloned into a preview. */
export const PREVIEW_KINDS = new Set(["frontend", "backend", "bot"]);
const DEFAULT_KINDS = new Set(["frontend", "backend"]);

export interface PreviewCandidateApp {
  kind: string;
  previewEnabled: boolean | null;
  gitRepository: string | null;
  deployTarget: string;
}

/** Only git-built server apps: Vercel builds its own previews of a Vercel app, so one here would be a second copy. */
export function includedInPreviews(a: PreviewCandidateApp): boolean {
  if (!PREVIEW_KINDS.has(a.kind) || !a.gitRepository || a.deployTarget !== "server") return false;
  return a.previewEnabled ?? DEFAULT_KINDS.has(a.kind);
}

/** Must equal the column default of projects.previewBaseEnv: a value that means nobody picked a base. */
export const DEFAULT_PREVIEW_BASE = "development";

/**
 * Never production unless the owner named it. A project that never picked a base, and whose one
 * environment besides production has another name (often `dev`), gets that one.
 */
export function pickBaseEnvironment<T extends { name: string }>(envs: T[], wanted: string): T | null {
  const named = envs.find((e) => e.name === wanted);
  if (named) return named;
  if (envs.length === 1) return envs[0]!;
  const others = envs.filter((e) => e.name !== "production");
  return wanted === DEFAULT_PREVIEW_BASE && others.length === 1 ? others[0]! : null;
}

/** A project with one environment has only its real data to share, so its previews always get their own database, whatever is stored. */
export function previewNeedsOwnDb(p: { environments: readonly unknown[]; previewIsolatedDb: boolean }): boolean {
  return p.previewIsolatedDb || p.environments.length < 2;
}

/** `pr-42-web.preview.example.com`. A single label keeps one wildcard record and certificate valid; 63 is the DNS label limit. */
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

/** Percent, one decimal; null when unknown or stale. */
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
 * Makes room under the project cap first (evicting within the project), then under the server cap
 * (evicting anywhere). Blocked when nothing can be evicted.
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

export const expiresAt = (lastCommitAt: Date, ttlHours: number): Date => new Date(lastCommitAt.getTime() + ttlHours * 3600_000);
