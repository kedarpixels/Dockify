import "server-only";
import { PREVIEW_LENA as PREVIEW_LENA_ACTOR, PREVIEW_OWNER, PREVIEW_OWNER_AVATAR, PREVIEW_OWNER_GITHUB } from "./preview-owner";
import { previewSecurityOn, previewSecurityRelease } from "./preview-security";
import { isPreviewVercelApp } from "./preview-vercel";
import type { ActorRef, AppKind, AppStatus, DeploymentStatus, GitAuthor, Overview, RecentDeployment, Resource } from "./types";
import { seeded } from "@/lib/preview-random";

// Sample data for the DOCKIFY_PREVIEW build, shaped like GET /api/v1/overview. `now` is floored to
// the minute, so every module that builds the fixture in the same minute gets identical timestamps.

const GB = 1024 ** 3;

/** Verified GitHub logins; the API resolves push authors the same way. Lena's link is unverified, so it resolves nobody. */
const LINKED: Record<string, ActorRef> = { [PREVIEW_OWNER_GITHUB]: PREVIEW_OWNER };
/** Every deploy is a push: most by the owner, a few by Lena's unverified login, some by Tomas, who linked none. */
const pushAuthor = (i: number) => (i % 5 === 3 ? "tomasberg" : i % 7 === 4 ? "lenahart" : PREVIEW_OWNER_GITHUB);
/** Anyone else shows as their GitHub login; no avatar URL, so the preview draws the default person and loads nothing. */
const deployActor = (i: number): ActorRef => {
  const login = pushAuthor(i);
  return LINKED[login] ?? { name: login, login, avatarUrl: null, kind: "github" };
};
/** The commit's author, as the API sends it: the GitHub person, whoever that login is linked to. */
const deployAuthor = (i: number): GitAuthor => {
  const login = pushAuthor(i);
  return { name: login, login, avatarUrl: login === PREVIEW_OWNER_GITHUB ? PREVIEW_OWNER_AVATAR : null, isActor: true };
};

/** Rows that are not plain pushes, keyed by sha. */
const ODD_ROWS: Record<string, Partial<RecentDeployment>> = {
  e44c1a0: { trigger: "manual", commit: null, branch: null, message: null, actor: PREVIEW_OWNER, author: null },
  "41b7a2e": { trigger: "redeploy", actor: PREVIEW_OWNER, author: { name: "lenahart", login: "lenahart", avatarUrl: null, isActor: false } },
  "e0b4d6c": { trigger: "manual", actor: PREVIEW_OWNER, author: { name: "Jane Doe", login: null, avatarUrl: null, isActor: false } },
  "58fd310": { trigger: "manual", actor: PREVIEW_OWNER, author: null },
};
/** Deploys of a service or an image: no message, branch or commit, only what ran. */
const NO_COMMIT: Array<[project: string, app: string, image: string, startedMinAgo: number, durationSec: number]> = [
  ["horseai", "postgres", "postgres:17-alpine", 200, 21],
  ["brightlane", "redis", "redis:8.2-alpine", 610, 12],
  ["inkwell", "chat-bot", "ghcr.io/sam/chat-bot:1.4.2", 1500, 34],
];

/** Each project's repository. Managed services run from an image, so their deploys carry none. */
export const PREVIEW_REPOS: Record<string, string> = {
  horseai: "https://github.com/sam/horseai",
  inkwell: "https://github.com/sam/inkwell",
  brightlane: "https://github.com/sam/brightlane",
  fieldnote: "https://github.com/sam/fieldnote",
};
const BUILT: ReadonlySet<AppKind | undefined> = new Set<AppKind | undefined>(["frontend", "backend", "bot"]);
export const previewRepo = (project: string, kind: AppKind | undefined) => (BUILT.has(kind) ? (PREVIEW_REPOS[project] ?? null) : null);

// A fixed boot moment shared by every server module, so uptime never jumps between refreshes.
const BOOTED_AT = Date.UTC(2026, 9, 17, 6, 12, 0);

const apps: Array<[project: string, env: string, name: string, kind: AppKind, status: AppStatus]> = [
  ["horseai", "production", "web", "frontend", "running"],
  ["horseai", "production", "api", "backend", "running"],
  ["horseai", "production", "admin", "frontend", "running"],
  ["horseai", "production", "discord-bot", "bot", "running"],
  ["horseai", "production", "postgres", "postgres", "running"],
  ["horseai", "production", "redis", "redis", "running"],
  ["inkwell", "production", "web", "frontend", "deploying"],
  ["inkwell", "production", "api", "backend", "running"],
  ["inkwell", "production", "admin", "frontend", "running"],
  ["inkwell", "production", "discord-bot", "bot", "running"],
  ["inkwell", "production", "worker", "backend", "running"],
  ["inkwell", "production", "chat-bot", "bot", "stopped"],
  ["inkwell", "production", "postgres", "postgres", "running"],
  ["brightlane", "production", "web", "frontend", "running"],
  ["brightlane", "production", "api", "backend", "running"],
  ["brightlane", "production", "scraper", "backend", "running"],
  ["brightlane", "production", "postgres", "postgres", "degraded"],
  ["brightlane", "production", "redis", "redis", "running"],
  ["fieldnote", "production", "web", "frontend", "running"],
  ["fieldnote", "development", "api", "backend", "deploying"],
  ["fieldnote", "production", "api", "backend", "running"],
  ["fieldnote", "production", "admin", "frontend", "running"],
  ["fieldnote", "production", "postgres", "postgres", "running"],
  ["fieldnote", "production", "minio", "s3", "running"],
];

/** Apps the preview shows renamed: project/environment/name to the display name people read. */
const DISPLAY_NAMES: Record<string, string> = { "horseai/production/web": "Storefront" };
const displayOf = (project: string, environment: string, name: string) => DISPLAY_NAMES[`${project}/${environment}/${name}`];

const deploys: Array<[
  project: string, app: string, env: string, status: DeploymentStatus,
  message: string, branch: string, sha: string, startedMinAgo: number, durationSec: number | null,
]> = [
  ["inkwell", "web", "production", "building", "Poll raffle settlement every 5s", "main", "3f2a91c", 0.8, null],
  ["fieldnote", "api", "development", "deploying", "Schedule Contoso board refresh", "dev", "b81e07d", 1.5, null],
  ["horseai", "admin", "production", "queued", "Add partner payout export", "main", "e44c1a0", 0.2, null],
  ["horseai", "web", "production", "ready", "Refresh partner leaderboard copy", "main", "9c0d4e2", 12, 98],
  ["fieldnote", "web", "production", "ready", "Challenges page empty state", "feature/previews", "41b7a2e", 47, 125],
  ["horseai", "api", "production", "ready", "Index payouts by created_at", "main", "58fd310", 128, 72],
  ["brightlane", "web", "production", "failed", "Bump Next.js to 16.4", "main", "0d6c55f", 422, 161],
  ["inkwell", "chat-bot", "production", "failed", "Reconnect on socket close", "main", "a90e3c4", 545, 57],
  ["fieldnote", "admin", "production", "ready", "Audit log filters", "fix/audit-log-filter-timezone-offset", "7c2d9b1", 690, 88],
  ["inkwell", "api", "production", "ready", "Cache affiliate stats for 30s", "main", "e0b4d6c", 1310, 104],
  ["horseai", "discord-bot", "production", "ready", "Slash command for payout status", "main", "0b3e9a4", 1580, 66],
  ["brightlane", "scraper", "production", "cancelled", "Retry Northwind on 429", "main", "5e7f210", 1745, 31],
  ["fieldnote", "web", "production", "ready", "Tighten leaderboard cache headers", "main", "2a9f4e1", 2890, 112],
  ["horseai", "web", "production", "ready", "Partner payout export polish", "main", "8d41c07", 3120, 94],
  ["inkwell", "admin", "production", "failed", "Migrate audit table to timestamptz", "main", "c7e2a90", 3405, 48],
  ["brightlane", "api", "production", "ready", "Rotate Northwind key per request", "main", "f03b6d2", 3760, 81],
];

const toMinute = (d: Date) => new Date(Math.floor(d.getTime() / 60_000) * 60_000);

export function buildPreviewOverview(at: Date): Overview {
  const now = toMinute(at);
  const resources: Resource[] = apps.map(([project, environment, name, kind, status], i) => ({
    id: `app_${i}`,
    name,
    ...(displayOf(project, environment, name) ? { displayName: displayOf(project, environment, name) } : {}),
    kind,
    status,
    projectId: `prj_${project}`,
    projectSlug: project,
    environment,
    ...(isPreviewVercelApp(project, name) ? { onVercel: true as const } : {}),
  }));

  const recentDeployments: RecentDeployment[] = deploys.map(
    ([project, app, environment, status, message, branch, commit, minAgo, dur], i) => {
      const target = resources.find((r) => r.projectSlug === project && r.name === app && r.environment === environment);
      const id = target?.id ?? "app_x";
      const created = new Date(now.getTime() - minAgo * 60_000);
      return {
        id: `dpl_${i}`,
        appId: id,
        status,
        commit,
        branch,
        message,
        trigger: "push",
        createdAt: created.toISOString(),
        finishedAt: dur === null ? null : new Date(created.getTime() + dur * 1000).toISOString(),
        app: { id, name: app, displayName: target?.displayName, kind: target?.kind },
        projectSlug: project,
        environment,
        actor: deployActor(i),
        author: deployAuthor(i),
        repo: previewRepo(project, target?.kind),
        ...ODD_ROWS[commit],
      };
    },
  );
  NO_COMMIT.forEach(([project, app, image, minAgo, dur], i) => {
    const target = resources.find((r) => r.projectSlug === project && r.name === app);
    const id = target?.id ?? "app_x";
    const created = new Date(now.getTime() - minAgo * 60_000);
    const row: RecentDeployment = {
      id: `dpl_image_${i}`, appId: id, status: "ready", commit: null, branch: null, message: null, trigger: "manual",
      createdAt: created.toISOString(), finishedAt: new Date(created.getTime() + dur * 1000).toISOString(),
      app: { id, name: app, displayName: target?.displayName, kind: target?.kind }, projectSlug: project, environment: target?.environment ?? "production",
      actor: i === 1 ? PREVIEW_LENA_ACTOR : PREVIEW_OWNER, author: null, image, repo: null,
    };
    const at = recentDeployments.findIndex((d) => Date.parse(d.createdAt) < created.getTime());
    recentDeployments.splice(at < 0 ? recentDeployments.length : at, 0, row);
  });

  // The same shape the API sends: every day of the current year through 31 Dec (zero after today),
  // starting earlier when needed so the 30-day KPIs always have 60 days behind today.
  const rnd = seeded(17);
  const DAY = 86_400_000;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = Math.min(Date.UTC(now.getUTCFullYear(), 0, 1), today - 59 * DAY);
  const days = Math.round((Date.UTC(now.getUTCFullYear(), 11, 31) - start) / DAY) + 1;
  const deployTrend = Array.from({ length: days }, (_, i) => {
    const t = start + i * DAY;
    const date = new Date(t).toISOString().slice(0, 10);
    if (t > today) return { date, total: 0, failed: 0 };
    const weekend = new Date(t).getUTCDay() === 0 || new Date(t).getUTCDay() === 6;
    const base = (0.3 + i / 520) * (weekend ? 0.35 : 1);
    const total = Math.max(0, Math.round(rnd() * 11 * base));
    const failed = total > 2 && rnd() > 0.62 ? 1 + Math.round(rnd() * 0.7) : 0;
    return { date, total, failed };
  });

  const byStatus: Record<AppStatus, number> = { running: 0, stopped: 0, deploying: 0, degraded: 0, unknown: 0, restarting: 0, exited: 0, missing: 0, failed: 0 };
  const byKind: Record<AppKind, number> = { frontend: 0, backend: 0, bot: 0, postgres: 0, redis: 0, s3: 0 };
  for (const r of resources) {
    byStatus[r.status] += 1;
    byKind[r.kind] += 1;
  }

  // The trend runs on to Dec 31; today's row anchors the windows that look back from now.
  const ti = deployTrend.findIndex((d) => d.date === new Date(today).toISOString().slice(0, 10));
  // The last 24 hours: today so far, plus the part of yesterday that is still inside the window.
  const last24h = (deployTrend[ti]?.total ?? 0) + Math.round((deployTrend[ti - 1]?.total ?? 0) * (1 - (now.getTime() - today) / DAY));

  const healthyNow = byStatus.running + byStatus.deploying;
  const appHealth = deployTrend.slice(Math.max(0, ti - 29), ti + 1).map((d, i, a) => ({
    date: d.date,
    healthy: i === a.length - 1 ? healthyNow : Math.min(resources.length, healthyNow - 1 + Math.round(rnd() * 2.4)),
    total: resources.length,
  }));

  // The bell's notice for 0.9.2: the security notice the API sends while the preview offers the
  // security release (lib/preview-security.ts), else the plain update notice.
  const security = previewSecurityOn() ? previewSecurityRelease(now) : null;
  return {
    system: [
      security
        ? {
            id: `security-release-${security.version}`,
            kind: "updateAvailable",
            tone: "bad",
            title: `Important security release v${security.version}`,
            detail: security.summary.length > 160 ? `${security.summary.slice(0, 157)}...` : security.summary,
            href: "/server#updates",
            at: security.publishedAt,
          }
        : {
            id: "upd_available_0.9.2",
            kind: "updateAvailable",
            tone: "info",
            title: "Update available",
            detail: "Dockify 0.9.2, a signed security release",
            href: "/server",
            at: new Date(now.getTime() - 26 * 3_600_000).toISOString(),
          },
    ],
    appHealth,
    viewer: { name: PREVIEW_OWNER.name, role: "Admin", email: "sam@horseai.example", avatarUrl: PREVIEW_OWNER_AVATAR, time: { timeZone: null, hour12: false } },
    counts: {
      projects: { total: 4, active: 4, archived: 0 },
      environments: 5,
      apps: { total: resources.length, byKind, byStatus },
      domains: 17,
      deployments: { total: 1204, last24h, inFlight: recentDeployments.filter((d) => d.status === "queued" || d.status === "building" || d.status === "deploying").length },
    },
    recentDeployments,
    lastDeployments: recentDeployments.filter((d, i, all) => d.status !== "queued" && all.findIndex((x) => x.appId === d.appId && x.status !== "queued") === i),
    resources,
    deployTrend,
    host: {
      name: "vps-1",
      region: "Frankfurt",
      uptimeSeconds: Math.floor((now.getTime() - BOOTED_AT) / 1000),
      containers: 31,
      load1: 1.84,
      cpu: { usedPct: 38, cores: 8 },
      memory: { usedBytes: 11.2 * GB, totalBytes: 32 * GB },
      disk: { usedBytes: 146 * GB, totalBytes: 240 * GB, reclaimableBytes: 38 * GB },
      network: { outMbps: 42, capacityMbps: 1000 },
      history: Array.from({ length: 24 }, (_, i) => {
        const hour = new Date(now.getTime() - (23 - i) * 3_600_000);
        const day = Math.sin(((hour.getUTCHours() - 8) / 24) * Math.PI * 2);
        const last = i === 23;
        return {
          at: hour.toISOString(),
          cpu: last ? 38 : Math.round(30 + day * 12 + rnd() * 10),
          memory: last ? 35 : Math.round(32 + day * 3 + rnd() * 2),
          disk: Math.round((58 + (i / 23) * 3) * 10) / 10,
          // Mbps out, as the API sends it: 42 of the 1000 Mbps link now.
          network: last ? 42 : Math.round((30 + day * 15 + rnd() * 20) * 10) / 10,
        };
      }),
    },
  };
}

/** FNV-1a over the date string, folded into the LCG's range, so every day has its own stable seed. */
function daySeed(date: string) {
  let h = 2166136261;
  for (let i = 0; i < date.length; i++) {
    h ^= date.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 233280;
}

/** One day of preview deployments, newest first. Count and failures match that day's `deployTrend`
 * row, so the heatmap and its day panel always agree. */
export function buildPreviewDay(date: string, at: Date): RecentDeployment[] {
  const now = toMinute(at);
  const overview = buildPreviewOverview(now);
  const hit = overview.deployTrend.find((d) => d.date === date);
  if (!hit || hit.total === 0) return [];

  const rnd = seeded(daySeed(date));
  const pool = overview.resources.filter((r) => r.kind === "frontend" || r.kind === "backend" || r.kind === "bot");
  const messages = deploys.map((d) => d[4]);

  // Working hours in UTC; today stops a minute before now so nothing lands in the future.
  const dayStart = Date.parse(`${date}T00:00:00Z`);
  // The trend runs to 31 Dec, so its last row is not today.
  const isToday = date === now.toISOString().slice(0, 10);
  const nowMin = Math.floor((now.getTime() - dayStart) / 60_000);
  const endMin = isToday ? Math.max(0, Math.min(22 * 60, nowMin - 1)) : 22 * 60;
  const startMin = endMin < 8 * 60 ? 0 : 8 * 60;

  // Pick which rows failed with a seeded shuffle of the indices.
  const order = Array.from({ length: hit.total }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const failed = new Set(order.slice(0, hit.failed));

  const rows = Array.from({ length: hit.total }, (_, i): RecentDeployment => {
    const app = pool[Math.floor(rnd() * pool.length)]!;
    const message = messages[Math.floor(rnd() * messages.length)]!;
    const commit = Math.floor(rnd() * 0xfffffff).toString(16).padStart(7, "0");
    const minute = startMin + rnd() * (endMin - startMin);
    const isFailed = failed.has(i);
    const dur = Math.round(isFailed ? 20 + rnd() * 150 : 45 + rnd() * 135);
    const created = dayStart + Math.floor(minute * 60_000);
    return {
      id: `dpl_${date.replaceAll("-", "")}_${i}`,
      appId: app.id,
      status: isFailed ? "failed" : "ready",
      commit,
      branch: app.environment === "development" ? "dev" : "main",
      message,
      trigger: "push",
      createdAt: new Date(created).toISOString(),
      finishedAt: new Date(Math.min(created + dur * 1000, now.getTime())).toISOString(),
      app: { id: app.id, name: app.name, displayName: app.displayName, kind: app.kind },
      projectSlug: app.projectSlug,
      environment: app.environment,
      actor: deployActor(i),
      author: deployAuthor(i),
      repo: previewRepo(app.projectSlug, app.kind),
    };
  });

  return rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
