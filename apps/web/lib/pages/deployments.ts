import "server-only";
import { connection } from "next/server";
import { apiRequest, plainError, UNREADABLE } from "@/lib/api";
import { upstreamStatus, type RouteAnswer } from "@/lib/http";
import type { ActorRef, OverviewSource, RecentDeployment } from "@/lib/types";
import { previewDetail, previewPage } from "./deployments-preview";
import { isPreviewMode } from "@/lib/preview-mode";

/*
 * Deployments pages loader. The routes are in packages/contracts/src/endpoints.ts (every call forwards
 * the session cookie, every answer is JSON, nothing is cached, every call is bounded by lib/api.ts).
 *
 *   status: building (queued, building and deploying), ready, failed or cancelled; absent means all.
 *   project: a project slug. q: free text over message, app, project, branch and commit.
 *   cursor: opaque, taken from the previous page's nextCursor.
 *   -> { items: RecentDeployment[], nextCursor: string | null, stats?: DeploymentStats }
 *   Items are newest first, 25 a page. `stats` covers every project and ignores the filters; send it
 *   on the first page (no cursor) only. Without it the KPI strip derives what it can from the page.
 *
 *   -> DeploymentDetail (the RecentDeployment row plus current, steps and error). 404 when
 *   the id is unknown.
 *
 * Every RecentDeployment carries `actor: { name, avatarUrl, kind, login? } | null`: kind is "user",
 * "token", "system", or "github" for a push whose author is not a verified member (named by `login`,
 * with their GitHub avatar). A member's `avatarUrl` is sent only to a signed-in session. It also
 * carries `repo`: the app's git repository URL, null for an image source, so commits and branches
 * link to GitHub. The detail adds `pr`, the pull request a preview deployment was built from.
 *
 *   -> { lines: { seq, ts, stream: "stdout" | "stderr", text }[], done: boolean }
 *   Lines with seq greater than `after`, oldest first; seq starts at 1 and has no gaps. `done` turns
 *   true once the deployment has finished and the last line was sent.
 *
 *   The same lines live as server-sent events. Only a deployment on Vercel uses it here.
 *
 *   -> { deployment: RecentDeployment }
 *   Redeploy and rollback answer with the new deployment they queued; cancel answers with this one,
 *   now cancelled. 409 when the action no longer applies (already finished, already current).
 */

// -------------- Types --------------

export type DeployFilter = "all" | "building" | "ready" | "failed" | "cancelled";

export interface DeploymentQuery {
  cursor?: string | null;
  status?: DeployFilter;
  project?: string;
  q?: string;
}

/** Totals for the KPI strip, across every project, over the last 24 hours and the 24 before. */
export interface DeploymentStats {
  inFlight: number;
  queued: number;
  succeeded24h: number;
  failed24h: number;
  succeededPrev24h?: number;
  failedPrev24h?: number;
  /** Median wall time of the successful deployments, in seconds. */
  medianSeconds: number | null;
  medianPrevSeconds?: number | null;
  /** Twelve two-hour buckets, oldest first, for the sparklines. */
  buckets?: Array<{ at: string; ready: number; failed: number; medianSeconds: number | null }>;
}

export interface DeploymentPage {
  items: RecentDeployment[];
  nextCursor: string | null;
  stats?: DeploymentStats;
}

export interface DeploymentsResult {
  source: OverviewSource;
  data: DeploymentPage | null;
  error?: string;
  fetchedAt: string;
}

/** Mirrors the API contract's StepId (packages/contracts StepId); keep the two in step. */
export type StepId = "queued" | "clone" | "build" | "push" | "release" | "deploy" | "health";
export type StepStatus = "pending" | "running" | "done" | "failed" | "cancelled" | "skipped";

export interface DeploymentStep {
  id: StepId;
  status: StepStatus;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface LogLine {
  seq: number;
  ts: string;
  stream: "stdout" | "stderr";
  text: string;
}

export interface DeploymentLogs {
  lines: LogLine[];
  done: boolean;
  /** vercel: read live from Vercel rather than from this server. */
  source?: "dockify" | "vercel";
  /** Vercel's log was too large to show whole: its last lines, after one notice line. */
  truncated?: boolean;
}

export interface DeploymentDetail extends RecentDeployment {
  /** Who started it: the pusher, or the operator who pressed Deploy, Redeploy or Rollback. */
  actor: ActorRef | null;
  /** True while this build is the one serving traffic for its app and environment. */
  current: boolean;
  /** One line on why it failed, when it did. */
  error: string | null;
  steps: DeploymentStep[];
  /** Its app only follows Vercel, so nothing here may change anything there. */
  followOnly?: boolean;
  /** The pull request a preview deployment was built from. */
  pr?: number | null;
}

export interface DeploymentResult {
  source: OverviewSource;
  data: DeploymentDetail | null;
  logs: DeploymentLogs | null;
  /** Preview only: the lines an in-flight preview build still has to print, appended client side. */
  previewTail?: LogLine[];
  notFound?: boolean;
  error?: string;
  fetchedAt: string;
}

export type DeploymentAction = "redeploy" | "rollback" | "cancel";

export interface ActionResult {
  ok: boolean;
  deployment?: RecentDeployment;
  error?: string;
}

const FILTERS: DeployFilter[] = ["all", "building", "ready", "failed", "cancelled"];
const ACTIONS: DeploymentAction[] = ["redeploy", "rollback", "cancel"];

export const isFilter = (v: unknown): v is DeployFilter => typeof v === "string" && (FILTERS as string[]).includes(v);
export const isAction = (v: unknown): v is DeploymentAction => typeof v === "string" && (ACTIONS as string[]).includes(v);
/** Ids are opaque, but always short and URL safe; anything else is refused before the API. */
export const isDeploymentId = (v: string) => /^[\w.-]{1,128}$/.test(v);

// -------------- API --------------

type ApiAnswer<T> = { ok: true; body: T } | { ok: false; status: number; error: string };

/** One call to the Dockify API (lib/api.ts) with the viewer's cookie, never cached, always bounded. */
async function api<T>(path: string, init?: { method?: "POST"; search?: Record<string, string | undefined> }): Promise<ApiAnswer<T>> {
  const r = await apiRequest<T>(path, { method: init?.method, query: init?.search, body: init?.method ? {} : undefined });
  if (!r.ok) return { ok: false, status: r.status, error: plainError(r) };
  return r.data === null ? { ok: false, status: 502, error: UNREADABLE } : { ok: true, body: r.data };
}

/** One page of deployments across every project. */
export async function getDeployments(query: DeploymentQuery = {}): Promise<DeploymentsResult> {
  await connection();
  const fetchedAt = new Date().toISOString();
  const status = query.status && query.status !== "all" ? query.status : undefined;

  if (process.env.DOCKIFY_API_URL) {
    const res = await api<DeploymentPage>("/api/v1/deployments", {
      search: { cursor: query.cursor ?? undefined, status, project: query.project, q: query.q?.trim() },
    });
    if (!res.ok) return { source: "api", data: null, error: res.error, fetchedAt };
    return { source: "api", data: { items: res.body.items ?? [], nextCursor: res.body.nextCursor ?? null, stats: res.body.stats }, fetchedAt };
  }

  // Design preview only. Never set in a deployed build: production must always read the API.
  if (isPreviewMode()) return { source: "preview", data: previewPage(query, new Date()), fetchedAt };

  return { source: "none", data: null, fetchedAt };
}

/** One deployment with its steps and the log so far. */
export async function getDeployment(id: string): Promise<DeploymentResult> {
  await connection();
  const fetchedAt = new Date().toISOString();

  if (process.env.DOCKIFY_API_URL) {
    const path = `/api/v1/deployments/${encodeURIComponent(id)}`;
    const [detail, logs] = await Promise.all([api<DeploymentDetail>(path), api<DeploymentLogs>(`${path}/logs`, { search: { after: "0" } })]);
    if (!detail.ok) {
      if (detail.status === 404) return { source: "api", data: null, logs: null, notFound: true, fetchedAt };
      return { source: "api", data: null, logs: null, error: detail.error, fetchedAt };
    }
    return { source: "api", data: detail.body, logs: logs.ok ? logs.body : null, error: logs.ok ? undefined : logs.error, fetchedAt };
  }

  if (isPreviewMode()) {
    const now = new Date();
    const built = previewDetail(id, now);
    if (!built) return { source: "preview", data: null, logs: null, notFound: true, fetchedAt };
    return { source: "preview", data: built.detail, logs: { lines: built.lines, done: built.done }, previewTail: built.tail, fetchedAt };
  }

  return { source: "none", data: null, logs: null, fetchedAt };
}

/** Log lines after `after`, for the follow tail. */
export async function getDeploymentLogs(id: string, after: number): Promise<RouteAnswer<{ data: DeploymentLogs | null; error?: string }>> {
  if (process.env.DOCKIFY_API_URL) {
    const res = await api<DeploymentLogs>(`/api/v1/deployments/${encodeURIComponent(id)}/logs`, { search: { after: String(after) } });
    if (res.ok) return { status: 200, body: { data: res.body } };
    return { status: upstreamStatus(res.status), body: { data: null, error: res.status === 404 ? "Unknown deployment" : res.error } };
  }
  if (isPreviewMode()) {
    const built = previewDetail(id, new Date());
    if (!built) return { status: 404, body: { data: null, error: "Unknown deployment" } };
    return { status: 200, body: { data: { lines: built.lines.filter((l) => l.seq > after), done: built.done } } };
  }
  return { status: 503, body: { data: null, error: "No data source" } };
}

/** Redeploy, rollback or cancel. The preview never sends anything: its page updates local state. */
export async function runDeploymentAction(id: string, action: DeploymentAction): Promise<RouteAnswer<ActionResult>> {
  if (!process.env.DOCKIFY_API_URL) return { status: 503, body: { ok: false, error: "No data source" } };
  const res = await api<{ deployment: RecentDeployment }>(`/api/v1/deployments/${encodeURIComponent(id)}/${action}`, { method: "POST" });
  if (res.ok) return { status: 200, body: { ok: true, deployment: res.body.deployment } };
  if (res.status === 409) return { status: 409, body: { ok: false, error: "That action no longer applies" } };
  if (res.status === 404) return { status: 404, body: { ok: false, error: "Unknown deployment" } };
  // 401 and 403 pass through, so the page ends a lapsed session or says it has no access.
  return { status: upstreamStatus(res.status), body: { ok: false, error: res.error } };
}
