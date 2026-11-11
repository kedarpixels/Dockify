export type AppKind = "frontend" | "backend" | "bot" | "postgres" | "redis" | "s3";
/**
 * What the daemon reports for an app (the worker's observe pass writes it). degraded: running but
 * failing its health check. restarting: crash looping. exited: its container stopped on its own.
 * missing: it should run and has no container. failed: its first deploy failed. unknown: never
 * deployed. Mirrors AppStatus in packages/contracts.
 */
export type AppStatus = "running" | "stopped" | "deploying" | "degraded" | "unknown" | "restarting" | "exited" | "missing" | "failed";
export type DeploymentStatus = "queued" | "building" | "deploying" | "ready" | "failed" | "cancelled";

/** How the signed-in user reads times: an IANA zone (null follows the browser) and the clock. */
export interface TimePrefs {
  timeZone: string | null;
  hour12: boolean;
}

/** A person, an API token, Dockify itself (schedules, webhooks), or a GitHub push author who is not a verified member. */
export type ActorKind = "user" | "token" | "system" | "github";

/**
 * Who acted. A member's `avatarUrl` comes only to a signed-in session. A `github` actor is named by
 * its `login`, with its GitHub avatar (null in the preview, which draws the default person instead).
 */
export interface ActorRef {
  name: string;
  avatarUrl: string | null;
  kind: ActorKind;
  login?: string;
}

/**
 * Who wrote a deployment's commit, whoever started the deployment. `login` is null when the author
 * has no GitHub account: `name` is then their git name, with no picture. `isActor` says the
 * deployment's `actor` is this same person.
 */
export interface GitAuthor {
  name: string;
  login: string | null;
  avatarUrl: string | null;
  isActor: boolean;
}

/** A deployment on Vercel, mirrored: its id there, its address, its inspector page and who started it. */
export interface ExternalDeployment {
  provider?: "vercel";
  id?: string | null;
  url?: string | null;
  inspectorUrl?: string | null;
  target?: "production" | "preview" | null;
  source?: string | null;
  creator?: string | null;
}

export interface RecentDeployment {
  id: string;
  appId: string;
  status: DeploymentStatus;
  commit: string | null;
  branch: string | null;
  message: string | null;
  trigger: string;
  createdAt: string;
  finishedAt: string | null;
  /** `kind` drives the row glyph; rows without it fall back to the plain status disc. */
  /** `displayName` is what people read (absent: show `name`); `name` stays the app's identity. */
  app: { id: string; name: string; displayName?: string | null; kind?: AppKind };
  projectSlug: string;
  environment: string;
  /** Who started it; null when Dockify queued it, absent from older APIs. */
  actor?: ActorRef | null;
  /** Who wrote its commit; null or absent when nobody is known, as on a row from before this was recorded. */
  author?: GitAuthor | null;
  /** What a deployment with no commit ran: a managed service's or an image app's reference. */
  image?: string | null;
  /** Set when it ran on Vercel: Vercel's record of it. Null or absent for a build on this server. */
  external?: ExternalDeployment | null;
  /** The app's repository URL; absent for image apps and from APIs that do not send it. */
  repo?: string | null;
}

export interface Resource {
  id: string;
  /** The app's identity: containers, links, preview hosts and the CLI use it. */
  name: string;
  /** What people read as its name; absent or null shows `name`. Read it through appTitle (lib/format.ts). */
  displayName?: string | null;
  kind: AppKind;
  status: AppStatus;
  projectId: string;
  projectSlug: string;
  environment: string;
  /** Hosted by Vercel, so nothing of it runs on this server. Absent otherwise. */
  onVercel?: true;
}

export interface HostSnapshot {
  name: string;
  region: string;
  uptimeSeconds: number;
  containers: number;
  load1: number;
  cpu: { usedPct: number; cores: number };
  memory: { usedBytes: number; totalBytes: number };
  disk: { usedBytes: number; totalBytes: number; reclaimableBytes: number };
  /** capacityMbps: the link speed the installer recorded, or null when nobody knows it (the pages hide the share then). */
  network: { outMbps: number; capacityMbps: number | null };
  /** Hourly samples, oldest first: cpu, memory and disk in percent, network in Mbps out. Absent until the sampler runs. */
  history?: Array<{ at: string; cpu: number; memory: number; disk: number; network: number }>;
}

/** Mirrors GET /api/v1/overview. `host` is optional because the API has no metrics sampler yet. */
export interface Overview {
  /** The signed-in operator, when the API sends one. */
  viewer?: { name: string; role: string; email?: string; avatarUrl?: string; time?: TimePrefs };
  /** The zone the trend counts days in: the viewer's saved zone, else UTC. */
  trendZone?: string;
  counts: {
    projects: { total: number; active: number; archived: number };
    environments: number;
    apps: {
      total: number;
      byKind: Record<AppKind, number>;
      byStatus: Record<AppStatus, number>;
    };
    domains: number;
    deployments: { total: number; last24h: number; inFlight: number };
  };
  recentDeployments: RecentDeployment[];
  /** Each app's newest deployment that left the queue, newest first. */
  lastDeployments: RecentDeployment[];
  /** Every active project, including ones with no apps yet. Older APIs leave it out. */
  projects?: Array<{ slug: string; name: string }>;
  resources: Resource[];
  /** Oldest first, zero-filled, one row per UTC day: the current calendar year through 31 Dec,
   * starting earlier when needed so there are always 60 days up to today for the 30-day KPIs. */
  deployTrend: Array<{ date: string; total: number; failed: number }>;
  /** Healthy app count per UTC day. Needs the status sampler; absent until it runs. */
  appHealth?: Array<{ date: string; healthy: number; total: number }>;
  host?: HostSnapshot;
  /** Dockify's own events for the bell: a release to install, an update that finished, failed or rolled back. */
  system?: SystemNotice[];
}

/** One of Dockify's own events in the bell. `href` points into the console, usually /server. */
export interface SystemNotice {
  id: string;
  kind: "updateAvailable" | "updated" | "updateFailed" | "updateRolledBack";
  tone: "info" | "ok" | "bad";
  title: string;
  detail: string;
  href: string;
  at: string;
}

export type OverviewSource = "api" | "preview" | "none";

export interface OverviewResult {
  source: OverviewSource;
  data: Overview | null;
  error?: string;
  fetchedAt: string;
}
