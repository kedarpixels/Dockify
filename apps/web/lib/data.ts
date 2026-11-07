import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { safeNext } from "@/components/auth/util";
import { apiRequest, plainError, UNREADABLE } from "./api";
import { PATH_HEADER } from "./forwarded";
import { buildPreviewDay, buildPreviewOverview } from "./preview-fixture";
import { asPreviewRole } from "./preview-role";
import type { Overview, OverviewResult, OverviewSource, RecentDeployment } from "./types";
import { isPreviewMode } from "@/lib/preview-mode";
import { isRecord } from "@/lib/validation";


type Fetched = { ok: true; body: unknown } | { ok: false; error: string };

/**
 * Sends a visitor whose session the API rejected (401) to sign in, keeping the page they were on.
 * The path is checked again here, so a forged header can only ever point back into this console.
 */
async function expireSession(): Promise<never> {
  const next = safeNext((await headers()).get(PATH_HEADER));
  redirect(next === "/" ? "/login?reason=expired" : `/login?reason=expired&next=${encodeURIComponent(next)}`);
}

/**
 * GETs a Dockify API path with the caller's cookies (lib/api.ts, 10 second timeout), and turns
 * every failure into one short line. A 401 never returns: the visitor goes to /login?reason=expired.
 */
async function apiGet(path: string, query?: Record<string, string>): Promise<Fetched> {
  const r = await apiRequest<unknown>(path, { query });
  if (r.ok) return { ok: true, body: r.data };
  if (r.status === 401) await expireSession();
  return { ok: false, error: plainError(r) };
}

/** Just enough shape to keep the derive helpers from throwing on a half-built API. */
function isOverview(v: unknown): v is Overview {
  return (
    isRecord(v) &&
    isRecord(v.counts) &&
    Array.isArray(v.recentDeployments) &&
    Array.isArray(v.lastDeployments) &&
    Array.isArray(v.resources) &&
    Array.isArray(v.deployTrend)
  );
}

export const getOverview = cache(fetchOverview);

async function fetchOverview(): Promise<OverviewResult> {
  await connection();
  const fetchedAt = new Date().toISOString();
  const base = process.env.DOCKIFY_API_URL;

  if (base !== undefined) {
    const got = await apiGet("/api/v1/overview");
    if (!got.ok) return { source: "api", data: null, error: got.error, fetchedAt };
    if (!isOverview(got.body)) return { source: "api", data: null, error: UNREADABLE, fetchedAt };
    return { source: "api", data: got.body, fetchedAt };
  }

  // The preview's own "view as a Viewer" cookie (lib/preview-role.ts) only lowers the role.
  if (isPreviewMode()) return { source: "preview", data: await asPreviewRole(buildPreviewOverview(new Date(fetchedAt))), fetchedAt };

  return { source: "none", data: null, fetchedAt };
}

/** One UTC day of deployments for the heatmap day panel, newest first. */
export interface DayDeploymentsResult {
  source: OverviewSource;
  day: string;
  data: RecentDeployment[] | null;
  error?: string;
}

/** True for a real calendar day written as YYYY-MM-DD. */
export function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

/** The deployment rows out of a bare array, `{ items }` or `{ data }`, or null for anything else. */
function deploymentRows(body: unknown): RecentDeployment[] | null {
  const rows = Array.isArray(body) ? body : isRecord(body) ? (body.items ?? body.data) : null;
  return Array.isArray(rows) ? rows : null;
}

/**
 * Deployments created on `day` (UTC). Reads GET /api/v1/deployments?from=<day>&to=<day+1> from the
 * Dockify API (the API supports that half-open created_at filter and returns the same
 * row shape as overview.recentDeployments, either as an array or as `{ items }`). In the design
 * preview it returns the fixture's day, whose count matches that day's deployTrend row.
 */
export async function getDeploymentsForDay(day: string): Promise<DayDeploymentsResult> {
  const base = process.env.DOCKIFY_API_URL;
  if (!isDay(day)) return { source: base !== undefined ? "api" : "none", day, data: null, error: "Day must be YYYY-MM-DD" };

  if (base !== undefined) {
    const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const got = await apiGet("/api/v1/deployments", { from: day, to: next });
    if (!got.ok) return { source: "api", day, data: null, error: got.error };
    const rows = deploymentRows(got.body);
    if (!rows) return { source: "api", day, data: null, error: UNREADABLE };
    const at = (d: RecentDeployment) => Date.parse(d.createdAt) || 0;
    return { source: "api", day, data: [...rows].sort((a, b) => at(b) - at(a)) };
  }

  if (isPreviewMode()) return { source: "preview", day, data: buildPreviewDay(day, new Date()) };

  return { source: "none", day, data: null, error: "No data source" };
}
