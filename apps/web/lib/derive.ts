import { projectsShowingEnvironments } from "./environments";
import { appTitle, dayLabel, plural } from "./format";
import type { AppStatus, DeploymentStatus, Overview, RecentDeployment, Resource } from "./types";

export type Tone = "ok" | "live" | "pending" | "warn" | "bad" | "idle";

export const DEPLOY_TONE: Record<DeploymentStatus, Tone> = {
  queued: "pending",
  building: "live",
  deploying: "live",
  ready: "ok",
  failed: "bad",
  cancelled: "idle",
};

export const DEPLOY_LABEL: Record<DeploymentStatus, string> = {
  queued: "Queued",
  building: "Building",
  deploying: "Deploying",
  ready: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const APP_TONE: Record<AppStatus, Tone> = {
  running: "ok",
  deploying: "live",
  degraded: "bad",
  restarting: "bad",
  exited: "bad",
  missing: "bad",
  failed: "bad",
  stopped: "warn",
  unknown: "warn",
};

/** What an app's status chip says, on every page. */
export const APP_STATUS_LABEL: Record<AppStatus, string> = {
  running: "Running",
  deploying: "Deploying",
  degraded: "Degraded",
  restarting: "Restarting",
  exited: "Exited",
  missing: "No container",
  failed: "Failed",
  stopped: "Stopped",
  unknown: "Not deployed",
};

/** Statuses where nothing of the app is running: the pages say "Not running" for each. */
const NOT_RUNNING: ReadonlySet<AppStatus> = new Set<AppStatus>(["stopped", "exited", "missing", "failed", "unknown"]);
export const notRunning = (status: AppStatus): boolean => NOT_RUNNING.has(status);

/** What a project's state chip says for its tone (projectTone); a project with no apps says NO_APPS. */
export const PROJECT_STATE_LABEL: Record<Tone, string> = { bad: "Degraded", live: "Deploying", pending: "Queued", warn: "Partial", ok: "Healthy", idle: "Not deployed" };
export const NO_APPS = "No apps yet";

/**
 * A project's state is its worst app's: anything broken, then a deploy in flight, then a stopped or
 * undeployed app. A project with nothing deployed yet has nothing wrong with it.
 */
export function projectTone(statuses: ReadonlySet<AppStatus>): Tone {
  if (statuses.size === 1 && statuses.has("unknown")) return "idle";
  if ([...statuses].some((s) => APP_TONE[s] === "bad")) return "bad";
  if (statuses.has("deploying")) return "live";
  if (statuses.has("stopped") || statuses.has("unknown")) return "warn";
  return "ok";
}

export const IN_FLIGHT: DeploymentStatus[] = ["queued", "building", "deploying"];

export interface SparkPoint {
  label: string;
  value: number;
}

export interface Kpi {
  label: string;
  icon: "checkCircle" | "deploy" | "clock" | "alert";
  value: number;
  format: "int" | "ratio" | "pct";
  total?: number;
  sub: string;
  delta?: { text: string; dir: "up" | "down" | "flat"; tone: "ok" | "warn" | "bad" | "idle"; hint: string };
  spark?: { points: SparkPoint[]; unit: string; format: "int" | "pct" };
}

export interface ProjectCard {
  slug: string;
  /** What the project is called; the slug is only its address. */
  name: string;
  apps: Resource[];
  environments: string[];
  tone: Tone;
  stateLabel: string;
  last?: RecentDeployment;
}

/** One entry in the bell: a live problem, or a deploy that finished in the last day. */
export interface Notice {
  id: string;
  tone: Tone;
  title: string;
  detail: string;
  href: string;
  at?: string;
  /** Problems stay until resolved; results are read once seen. */
  kind: "problem" | "result";
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const DAY_MS = 86_400_000;

/** "horseai / Storefront": the project and the app as people read it (its display name, else its name). */
export function appLabel(d: { projectSlug: string; app: { name: string; displayName?: string | null } }) {
  return `${d.projectSlug} / ${appTitle(d.app)}`;
}

/** Sums days into Monday-first weeks, newest last, labelled by the week's Monday. */
function weekly(trend: Overview["deployTrend"], weeks: number) {
  const out: Array<{ label: string; total: number; failed: number }> = [];
  for (let i = trend.length - 1; i >= 0 && out.length < weeks; ) {
    const day = new Date(`${trend[i]!.date}T00:00:00Z`);
    const back = (day.getUTCDay() + 6) % 7;
    const slice = trend.slice(Math.max(0, i - back), i + 1);
    out.unshift({
      label: `Week of ${dayLabel(slice[0]!.date).slice(4)}`,
      total: sum(slice.map((d) => d.total)),
      failed: sum(slice.map((d) => d.failed)),
    });
    i -= back + 1;
  }
  return out;
}

type Delta = NonNullable<Kpi["delta"]>;

/**
 * A KPI's change: whole-number percent change from `then` to `now`, or "Same" when it rounds to
 * zero. With no earlier value, or an earlier zero that makes a percentage meaningless, there is no
 * delta, except zero to zero, which is "Same". `upIs` names the tone a rise earns.
 */
export function kpiDelta(now: number, then: number | null | undefined, upIs: "ok" | "bad", hint: string): Delta | undefined {
  if (then === undefined || then === null) return undefined;
  if (then === 0) return now === 0 ? { text: "Same", dir: "flat", tone: "idle", hint } : undefined;
  const change = Math.round(((now - then) / then) * 100);
  if (change === 0) return { text: "Same", dir: "flat", tone: "idle", hint };
  const up = change > 0;
  return { text: `${Math.abs(change)}%`, dir: up ? "up" : "down", tone: up === (upIs === "ok") ? "ok" : "bad", hint };
}

/**
 * Yesterday's deploys up to this time of day, so a morning is never measured against all of
 * yesterday. The last 24 hours hold today plus the part of yesterday after this time, so the rest
 * of yesterday is what came before it. Undefined when the counts do not add up (a snapshot from
 * the other side of midnight, a day missing from the trend): no comparison beats a made-up one.
 */
function sameTimeYesterday(yesterday: number | undefined, last24h: number, today: number): number | undefined {
  if (yesterday === undefined) return undefined;
  const before = yesterday - (last24h - today);
  return before >= 0 && before <= yesterday ? before : undefined;
}

export function deriveKpis(o: Overview, todayIso: string): Kpi[] {
  const trend = o.deployTrend;
  // The trend runs to 31 Dec, so anchor the recent windows on today's position in it, not the array
  // end. When today is missing (a stale snapshot over New Year, a client clock behind the server),
  // anchor on the last day before it and report today as 0 with no comparison.
  let ti = trend.findIndex((d) => d.date === todayIso);
  const todayKnown = ti >= 0;
  if (!todayKnown) ti = trend.findLastIndex((d) => d.date < todayIso);
  const upto = trend.slice(0, ti + 1);
  const last30 = trend.slice(Math.max(0, ti - 29), ti + 1);
  const prev30 = trend.slice(Math.max(0, ti - 59), Math.max(0, ti - 29));
  const n30 = sum(last30.map((d) => d.total));
  const p30 = sum(prev30.map((d) => d.total));
  const f30 = sum(last30.map((d) => d.failed));
  const pf30 = sum(prev30.map((d) => d.failed));
  const rate = n30 ? (f30 / n30) * 100 : 0;
  const prevRate = p30 ? (pf30 / p30) * 100 : 0;
  const { total, byStatus } = o.counts.apps;
  const healthy = byStatus.running + byStatus.deploying;
  const unhealthy = total - healthy;
  const inFlight = o.counts.deployments.inFlight;
  const weeks = weekly(upto, 12);
  const today = todayKnown ? (trend[ti]?.total ?? 0) : 0;
  const yesterday = todayKnown ? sameTimeYesterday(trend[ti - 1]?.total, o.counts.deployments.last24h, today) : undefined;
  const weekAgo = o.appHealth?.at(-8)?.healthy;
  // Compare only against a whole previous 30 days: a partial window turns a steady pace into a
  // made-up +1400%. A month with no deploys has no failure rate to compare against either.
  const prevFull = prev30.length === 30;
  const prevRateKnown = prevFull && p30 ? prevRate : undefined;

  return [
    {
      label: "Healthy apps",
      icon: "checkCircle",
      value: healthy,
      total,
      format: "ratio",
      sub: unhealthy ? `${unhealthy} need${unhealthy === 1 ? "s" : ""} attention` : "Every app is up",
      delta: kpiDelta(healthy, weekAgo, "ok", `${healthy} healthy now, ${weekAgo} a week ago`),
      spark: o.appHealth?.length
        ? { points: o.appHealth.slice(-12).map((d) => ({ label: dayLabel(d.date), value: d.healthy })), unit: "healthy apps", format: "int" }
        : undefined,
    },
    {
      label: "Deployments, 30 days",
      icon: "deploy",
      value: n30,
      format: "int",
      sub: `${n30 - f30} ok, ${f30} failed`,
      delta: kpiDelta(n30, prevFull ? p30 : undefined, "ok", `${plural(n30, "deployment")} now, ${p30} in the previous 30 days`),
      spark: { points: weeks.map((w) => ({ label: w.label, value: w.total })), unit: "deployments", format: "int" },
    },
    {
      label: "Deployments today",
      icon: "clock",
      value: today,
      format: "int",
      sub: inFlight ? `${inFlight} in flight now` : "Nothing in flight",
      delta: kpiDelta(today, yesterday, "ok", `${today} today, ${yesterday ?? 0} by this time yesterday`),
      spark: { points: upto.slice(-12).map((d, i, a) => ({ label: i === a.length - 1 ? "Today" : dayLabel(d.date), value: d.total })), unit: "deployments", format: "int" },
    },
    {
      // The window rides in the label, as on "Deployments, 30 days", so the sub stays one short line
      // on a phone and the strip's sparklines line up.
      label: "Failure rate, 30 days",
      icon: "alert",
      value: rate,
      format: "pct",
      sub: `${f30} of ${n30} failed`,
      delta: kpiDelta(rate, prevRateKnown, "bad", `${rate.toFixed(1)}% now, ${prevRate.toFixed(1)}% in the previous 30 days`),
      spark: { points: weeks.map((w) => ({ label: w.label, value: w.total ? (w.failed / w.total) * 100 : 0 })), unit: "failed", format: "pct" },
    },
  ];
}

export function deriveProjects(o: Overview): ProjectCard[] {
  const groups = new Map<string, Resource[]>();
  // Projects first, so one with no apps yet (every new project starts so) is still listed.
  for (const p of o.projects ?? []) groups.set(p.slug, []);
  for (const r of o.resources) groups.set(r.projectSlug, [...(groups.get(r.projectSlug) ?? []), r]);
  const names = new Map((o.projects ?? []).map((p) => [p.slug, p.name]));
  return [...groups.entries()].map(([slug, apps]) => {
    const tone: Tone = apps.length ? projectTone(new Set(apps.map((a) => a.status))) : "idle";
    const stateLabel = apps.length ? PROJECT_STATE_LABEL[tone] : NO_APPS;
    return {
      slug,
      // The name the owner gave it; an older API without the project list leaves only the slug.
      name: names.get(slug) || slug,
      apps,
      environments: [...new Set(apps.map((a) => a.environment))],
      tone,
      stateLabel,
      last: o.lastDeployments.find((d) => d.projectSlug === slug),
    };
  });
}

/** When a deployment ended, or started if it has not ended; NaN when the API sent no usable time. */
const settledAt = (d: RecentDeployment) => Date.parse(d.finishedAt ?? d.createdAt);

/** True when `d` settled within the last day. An unreadable time never counts as recent. */
const lastDay = (d: RecentDeployment, now: number) => now - settledAt(d) < DAY_MS;

const shortCommit = (d: RecentDeployment) => d.commit?.slice(0, 7) ?? "manual";

/** The bell's line for an app status that needs attention: the title after the app's name, and why. */
const STATUS_PROBLEM: Partial<Record<AppStatus, { title: string; detail: string }>> = {
  degraded: { title: "degraded", detail: "failing health checks" },
  restarting: { title: "restarting", detail: "its container keeps crashing" },
  exited: { title: "exited", detail: "its container stopped on its own" },
  missing: { title: "has no container", detail: "deploy it again" },
  failed: { title: "failed to deploy", detail: "its first deploy failed" },
  stopped: { title: "stopped", detail: "not serving traffic" },
  unknown: { title: "not deployed", detail: "nothing is running" },
};

/**
 * Live problems: every app the Healthy apps KPI says needs attention (STATUS_PROBLEM), and apps
 * whose latest deploy failed in the last day.
 */
function deriveProblems(o: Overview, now: number): Notice[] {
  const out: Notice[] = [];
  // A state notice is keyed by app and state, so degraded then stopped are two notices. The bell
  // forgets a key once its problem is gone, so the same app failing again later is new again.
  const seen = new Set<string>();
  for (const r of o.resources) {
    const p = STATUS_PROBLEM[r.status];
    if (!p) continue;
    seen.add(r.id);
    out.push({ id: `${r.id}:${r.status}`, tone: APP_TONE[r.status], title: `${appTitle(r)} ${p.title}`, detail: `${r.projectSlug}, ${p.detail}`, href: `/projects/${r.projectSlug}`, kind: "problem" });
  }
  // Only an app's latest deployment matters: a failure followed by a good or running deploy is
  // resolved. Cancelled runs change nothing, so they are skipped rather than counted as the latest.
  const newestFirst = [...o.recentDeployments].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  for (const d of newestFirst) {
    if (d.status === "cancelled" || seen.has(d.appId)) continue;
    seen.add(d.appId);
    if (d.status !== "failed" || !lastDay(d, now)) continue;
    out.push({
      id: d.id,
      tone: "bad",
      title: `${appTitle(d.app)} deploy failed`,
      detail: `${d.projectSlug}, ${shortCommit(d)}`,
      href: `/deployments/${d.id}`,
      at: d.finishedAt ?? d.createdAt,
      kind: "problem",
    });
  }
  return out;
}

/** The bell: live problems first, then up to 8 deploy results from the last day not already listed. */
export function deriveNotices(o: Overview, now: number): Notice[] {
  const problems = deriveProblems(o, now);
  const shown = new Set(problems.map((p) => p.id));
  const results: Notice[] = o.recentDeployments
    .filter((d) => (d.status === "ready" || d.status === "failed") && !shown.has(d.id) && lastDay(d, now))
    .slice(0, 8)
    .map((d) => ({
      id: d.id,
      tone: d.status === "failed" ? "bad" : "ok",
      title: `${appTitle(d.app)} ${d.status === "failed" ? "failed to deploy" : "deployed"}`,
      detail: `${d.projectSlug}, ${shortCommit(d)}`,
      href: `/deployments/${d.id}`,
      at: d.finishedAt ?? d.createdAt,
      kind: "result",
    }));
  return [...problems, ...system(o), ...results];
}

const SYSTEM_TONE = { info: "idle", ok: "ok", bad: "bad" } as const;

/**
 * Dockify's own events from the overview. A failed or rolled back update, and a pending security
 * release (the bad toned notices), stay listed as problems until the API drops them; an available
 * release or a finished update reads once seen. Only console paths are kept as links, so a notice
 * can never point off the dashboard.
 */
function system(o: Overview): Notice[] {
  return (o.system ?? []).map((n) => ({
    id: `sys:${n.id}`,
    tone: SYSTEM_TONE[n.tone] ?? "idle",
    title: n.title,
    detail: n.detail,
    href: n.href.startsWith("/") && !n.href.startsWith("//") && !n.href.startsWith("/\\") ? n.href : "/server",
    at: n.at,
    kind: n.kind === "updateFailed" || n.kind === "updateRolledBack" || n.tone === "bad" ? "problem" : "result",
  }));
}

/** Apps that are up: running, or swapping in a new build. */
export const upCount = (apps: Array<{ status: string }>) => apps.filter((a) => a.status === "running" || a.status === "deploying").length;

/** Everything the console frame needs from one overview snapshot. */
export function buildShell(data: Overview | null) {
  const shows = projectsShowingEnvironments(data?.resources ?? []);
  return {
    host: data?.host ? { name: data.host.name, region: data.host.region, cores: data.host.cpu.cores, disk: data.host.disk } : null,
    projects: data ? deriveProjects(data).map((p) => ({ slug: p.slug, tone: p.tone, stateLabel: p.stateLabel })) : [],
    // A renamed app is still found by its name, which links and the CLI use.
    apps: data?.resources.map((r) => ({ id: r.id, kind: r.kind, label: appLabel({ projectSlug: r.projectSlug, app: r }), name: r.name, environment: shows(r.projectSlug) ? r.environment : null })) ?? [],
    inFlight: data?.counts.deployments.inFlight ?? 0,
    viewer: data?.viewer ?? null,
  };
}
