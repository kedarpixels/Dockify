import "server-only";
import { connection } from "next/server";
import { apiRequest, type Method } from "../api";
import { buildPreviewOverview } from "../preview-fixture";
import { PREVIEW_LENA, PREVIEW_OWNER, PREVIEW_OWNER_AVATAR, PREVIEW_OWNER_GITHUB } from "../preview-owner";
import type { ActorKind, OverviewSource } from "../types";
import { isPreviewMode } from "@/lib/preview-mode";

/*
 * Activity and Settings loaders. The routes are in packages/contracts/src/endpoints.ts (all JSON, the
 * session cookie authenticates, every write answers `{ error }` with a 4xx on failure).
 *
 * Webhooks live under /api/v1/integrations/webhooks, see lib/pages/integrations.ts.
 * `notifications` here holds only which events notify.
 *
 */

/* ============== Types ============== */

export type ActivityCategory = "deploys" | "config" | "access" | "system";

export interface ActivityActor {
  id: string;
  name: string;
  avatarUrl?: string | null;
  /** "user" or "token"; Dockify itself is a null actor. Absent from older APIs, read as a user. */
  kind?: ActorKind;
}

/** One changed key on a config event. The API masks both values; null means added or removed. */
export interface ActivityChange {
  key: string;
  before: string | null;
  after: string | null;
}

export interface ActivityEvent {
  id: string;
  at: string;
  category: ActivityCategory;
  /** Machine name, e.g. "deploy.redeploy", "env.update", "auth.login". Drives the row glyph. */
  action: string;
  /** Null when Dockify itself did it (backups, prunes, renewals, failed builds). */
  actor: ActivityActor | null;
  /** Lowercase phrase between actor and target: "redeployed", "added domain". */
  verb: string;
  target: { label: string; href: string | null } | null;
  /** Plain words after the target: "from main", "to fieldnote / api". */
  suffix?: string | null;
  /** Set when the event is a failure. */
  tone?: "bad" | null;
  ip: string | null;
  location: string | null;
  changes?: ActivityChange[];
}

export interface ActivityPage {
  items: ActivityEvent[];
  nextCursor: string | null;
  /** Everyone who appears in the log, for the actor filter. */
  actors: ActivityActor[];
}

export interface ActivityQuery {
  cursor?: string | null;
  category?: ActivityCategory | null;
  actor?: string | null;
  q?: string | null;
}

export interface ActivityResult {
  source: OverviewSource;
  data: ActivityPage | null;
  error?: string;
  fetchedAt: string;
}

/** Two roles: Admin does everything (team, instance, tokens, env, danger zone), Viewer reads. */
export type Role = "admin" | "viewer";

export interface Me {
  id: string;
  name: string;
  email: string;
  role: Role;
  avatarUrl: string | null;
  twoFactor: { enabled: boolean };
  /** Confirmed by an emailed code. Always false on an instance without email. */
  emailVerified: boolean;
  /** Lowercased GitHub login; pushes by it show as this user once verified. */
  githubLogin: string | null;
  /** An admin's own link, or one an admin approved. Until then nothing is attributed by it. */
  githubVerified: boolean;
  /** IANA zone for times in the dashboard; null follows the browser. */
  timeZone: string | null;
  hour12: boolean;
  /** Email choices. `security` is always true for admins. */
  notify: { deployFailed: boolean; security: boolean };
}

export interface Session {
  id: string;
  /** "Chrome on macOS". */
  device: string;
  /** The device shape, for its icon: a script or an empty agent string is "unknown". */
  kind: "desktop" | "mobile" | "tablet" | "unknown";
  ip: string;
  location: string | null;
  lastSeenAt: string;
  /** When this session signed in. */
  createdAt: string;
  current: boolean;
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: Role;
  avatarUrl: string | null;
  joinedAt: string;
  githubLogin: string | null;
  githubVerified: boolean;
}

export interface Invite {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
  /** Null when no email was asked for. Written by the worker once the send settles. */
  emailStatus?: "queued" | "sent" | "failed" | null;
  emailError?: string | null;
}

export type NotifyEvent = "deployFailed" | "appDown" | "backupFailed" | "tlsExpiring" | "previewDeployments" | "jobFailed";

export interface InstanceSettings {
  instanceName: string;
  publicUrl: string;
  defaultBranch: string;
  buildConcurrency: number;
  logRetentionDays: number;
  notifications: {
    events: Record<NotifyEvent, boolean>;
  };
  /** Where previews answer: pr-<n>-<app>.<previewDomain>. Projects may override it. */
  previewDomain: string | null;
  /** preview.<parent of the dashboard host>, used while previewDomain is not set by hand. */
  previewDomainDefault?: string | null;
  previewDomainCustom?: boolean;
  /** The off switch for the web terminal, for the whole instance. */
  terminalEnabled?: boolean;
}

export type TokenScope = "read" | "deploy" | "admin";
/** Explicit powers on top of the scope. env:write needs the admin scope and still cannot touch secrets. */
export type TokenGrant = "env:write";

export interface ApiToken {
  id: string;
  name: string;
  scope: TokenScope;
  /** First characters of the secret, safe to show: "dk_8f3a". */
  prefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  /** Chosen at creation: every project, or only `projects`. Never implied by an empty list. */
  allProjects?: boolean;
  projects?: string[];
  grants?: TokenGrant[];
}

export interface TotpSetup {
  /** Base32 secret for manual entry. */
  secret: string;
  otpauthUrl: string;
  /** A rendered QR image when the API provides one; otherwise the UI shows its placeholder. */
  qrDataUrl?: string | null;
}

export interface SettingsData {
  me: Me;
  sessions: Session[];
  team: { members: TeamMember[]; invites: Invite[] };
  settings: InstanceSettings;
  tokens: ApiToken[];
}

export interface SettingsResult {
  source: OverviewSource;
  data: SettingsData | null;
  error?: string;
  fetchedAt: string;
}

/**
 * What every write returns to the client. `code` names a refusal the page acts on:
 * step_up_required (lib/step-up.ts), or the API's own code.
 */
export type Outcome<T = null> = { ok: true; data: T } | { ok: false; error: string; code?: string };

/* ============== Transport ============== */

export function dataSource(): OverviewSource {
  if (process.env.DOCKIFY_API_URL) return "api";
  // Design preview only, and only with no API configured at all (an empty DOCKIFY_API_URL is a
  // misconfigured deploy, not a preview). Production must always read the API.
  if (isPreviewMode()) return "preview";
  return "none";
}

/**
 * One call to the Dockify API with the visitor's cookie forwarded, never cached and always bounded
 * (lib/api.ts). A step-up refusal comes back as the shared refusal (lib/step-up.ts), never as raw text.
 */
export async function apiCall<T>(method: Method, path: string, body?: unknown): Promise<Outcome<T>> {
  if (!process.env.DOCKIFY_API_URL) return { ok: false, error: "No data source" };
  const r = await apiRequest<T>(path, { method, body });
  return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error, code: r.code };
}

/* ============== Loaders ============== */

const PAGE_SIZE = 20;
export const CATEGORIES: ActivityCategory[] = ["deploys", "config", "access", "system"];

export async function getActivity(query: ActivityQuery = {}): Promise<ActivityResult> {
  await connection();
  const fetchedAt = new Date().toISOString();
  const source = dataSource();

  if (source === "api") {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) params.set(k, v);
    const qs = params.toString();
    const res = await apiCall<ActivityPage>("GET", `/api/v1/activity${qs ? `?${qs}` : ""}`);
    return res.ok
      ? { source, data: { items: res.data?.items ?? [], nextCursor: res.data?.nextCursor ?? null, actors: res.data?.actors ?? [] }, fetchedAt }
      : { source, data: null, error: res.error, fetchedAt };
  }

  if (source === "preview") return { source, data: queryPreviewActivity(query, new Date()), fetchedAt };

  return { source, data: null, fetchedAt };
}

export async function getSettings(): Promise<SettingsResult> {
  await connection();
  const fetchedAt = new Date().toISOString();
  const source = dataSource();

  if (source === "api") {
    const [me, sessions, team, settings, tokens] = await Promise.all([
      apiCall<Me>("GET", "/api/v1/me"),
      apiCall<Session[]>("GET", "/api/v1/me/sessions"),
      apiCall<SettingsData["team"]>("GET", "/api/v1/team"),
      apiCall<InstanceSettings>("GET", "/api/v1/settings"),
      apiCall<ApiToken[]>("GET", "/api/v1/tokens"),
    ]);
    const failed = [me, sessions, team, settings, tokens].find((r) => !r.ok);
    if (failed && !failed.ok) return { source, data: null, error: failed.error, fetchedAt };
    if (!me.ok || !sessions.ok || !team.ok || !settings.ok || !tokens.ok) return { source, data: null, error: "API unreachable", fetchedAt };
    return {
      source,
      data: {
        me: me.data,
        sessions: sessions.data ?? [],
        team: { members: team.data?.members ?? [], invites: team.data?.invites ?? [] },
        settings: settings.data,
        tokens: tokens.data ?? [],
      },
      fetchedAt,
    };
  }

  if (source === "preview") return { source, data: buildPreviewSettings(new Date()), fetchedAt };

  return { source, data: null, fetchedAt };
}

/* ============== Preview fixture ============== */
/* Derived from buildPreviewOverview so projects, apps, deploy ids and the viewer agree everywhere.
   IPs come from the documentation ranges (RFC 5737) and people use example.com addresses. */

const MIN = 60_000;
const ago = (now: Date, minutes: number) => new Date(now.getTime() - minutes * MIN).toISOString();

const HOME = { ip: "203.0.113.24", location: "Berlin, DE" };
const LENA_AT = { ip: "198.51.100.40", location: "Lisbon, PT" };

function previewPeople(now: Date) {
  const viewer = buildPreviewOverview(now).viewer ?? { name: PREVIEW_OWNER.name, role: "Admin" };
  return {
    sam: { id: "usr_sam", name: viewer.name, avatarUrl: PREVIEW_OWNER_AVATAR, kind: "user" as const },
    lena: { id: "usr_lena", name: PREVIEW_LENA.name, avatarUrl: null, kind: "user" as const },
    tomas: { id: "usr_tomas", name: "Tomas Berg", avatarUrl: null, kind: "user" as const },
    role: viewer.role.toLowerCase() as Role,
  };
}

function buildPreviewActivity(now: Date): ActivityEvent[] {
  const o = buildPreviewOverview(now);
  const { sam, lena, tomas } = previewPeople(now);
  const app = (project: string, name: string, env = "production") =>
    o.resources.find((r) => r.projectSlug === project && r.name === name && r.environment === env);
  const appTarget = (project: string, name: string, env?: string) => {
    const r = app(project, name, env);
    return { label: `${project} / ${name}`, href: r ? `/apps/${r.id}` : `/projects/${project}` };
  };

  // Every recent deployment becomes one deploy event at the moment it started.
  const deploys: ActivityEvent[] = o.recentDeployments.map((d, i) => {
    const target = { label: `${d.projectSlug} / ${d.app.name}`, href: `/deployments/${d.id}` };
    const base = { id: `act_${d.id}`, at: d.createdAt, category: "deploys" as const, target, suffix: d.branch ? `from ${d.branch}` : null };
    if (d.status === "failed") return { ...base, action: "deploy.failed", actor: null, verb: "could not deploy", tone: "bad" as const, ip: null, location: null };
    const redeploy = d.status === "ready" && i % 3 === 1;
    const verbs: Record<string, string> = { ready: "deployed", cancelled: "cancelled a deploy of", queued: "queued a deploy of", building: "started a deploy of", deploying: "started a deploy of" };
    const verb = redeploy ? "redeployed" : (verbs[d.status] ?? "deployed");
    if (d.actor?.kind !== "user") return { ...base, action: `deploy.${d.status}`, actor: null, verb, ip: null, location: null };
    return { ...base, action: redeploy ? "deploy.redeploy" : `deploy.${d.status}`, actor: sam, verb, ...HOME };
  });

  const ev = (id: string, minutes: number, e: Omit<ActivityEvent, "id" | "at">): ActivityEvent => ({ id: `act_${id}`, at: ago(now, minutes), ...e });
  const system = { actor: null, ip: null, location: null };

  const others: ActivityEvent[] = [
    ev("env1", 35, {
      category: "config", action: "env.update", actor: sam, verb: "updated environment variables of", target: appTarget("horseai", "api"), suffix: null, ...HOME,
      changes: [
        { key: "PARTNER_SECRET", before: "••••••••91c2", after: "••••••••0b7e" },
        { key: "LOG_LEVEL", before: "••••", after: "•••••" },
        { key: "PARTNER_API_KEY", before: null, after: "••••••••d41a" },
      ],
    }),
    ev("login1", 95, { category: "access", action: "auth.login", actor: lena, verb: "signed in", target: null, ...LENA_AT }),
    ev("tls1", 180, { category: "system", action: "tls.renew", ...system, verb: "renewed the certificate for", target: { label: "fieldnote.example", href: "/domains" } }),
    ev("dom1", 240, { category: "config", action: "domain.add", actor: sam, verb: "added domain", target: { label: "dev-api.fieldnote.example", href: "/domains" }, suffix: "to fieldnote / api", ...HOME }),
    ev("bk1", 300, { category: "system", action: "backup.run", ...system, verb: "backed up", target: { label: "inkwell / postgres", href: "/backups" }, suffix: "412 MB" }),
    ev("loginx", 430, { category: "access", action: "auth.login_failed", ...system, verb: "blocked a sign-in for", target: null, suffix: "sam@example.com, wrong password", tone: "bad", ip: "192.0.2.77", location: null }),
    ev("set1", 600, {
      category: "config", action: "settings.update", actor: sam, verb: "changed", target: { label: "instance settings", href: "/settings?section=instance" }, ...HOME,
      changes: [{ key: "buildConcurrency", before: "2", after: "3" }],
    }),
    ev("prune1", 900, { category: "system", action: "prune", ...system, verb: "pruned", target: { label: "build cache", href: "/server" }, suffix: "6.4 GB freed" }),
    ev("tok1", 1100, { category: "access", action: "token.create", actor: sam, verb: "created API token", target: { label: "ci-deploy", href: "/settings?section=tokens" }, suffix: "with deploy scope", ...HOME }),
    ev("bk2", 1440, { category: "system", action: "backup.run", ...system, verb: "backed up", target: { label: "horseai / postgres", href: "/backups" }, suffix: "1.2 GB" }),
    ev("join1", 1650, { category: "access", action: "team.join", actor: tomas, verb: "joined the team as", target: null, suffix: "Viewer", ip: "198.51.100.12", location: "Hamburg, DE" }),
    ev("inv1", 1700, { category: "access", action: "team.invite", actor: sam, verb: "created an invite link for", target: { label: "tomas@example.com", href: "/settings?section=team" }, suffix: "as Viewer", ...HOME }),
    ev("env2", 2300, {
      category: "config", action: "env.update", actor: lena, verb: "updated environment variables of", target: appTarget("inkwell", "web"), ...LENA_AT,
      changes: [
        { key: "NEXT_PUBLIC_API_URL", before: "••••••••e.gg", after: "••••••••e.gg" },
        { key: "DISCORD_BOT_TOKEN", before: "••••••••Qx7w", after: null },
      ],
    }),
    ev("bkx", 2600, { category: "system", action: "backup.failed", ...system, verb: "could not back up", target: { label: "brightlane / postgres", href: "/backups" }, suffix: "health check failed", tone: "bad" }),
    ev("2fa1", 3000, { category: "access", action: "auth.2fa_enabled", actor: lena, verb: "turned on two-factor authentication", target: null, ...LENA_AT }),
    ev("dom2", 4300, { category: "config", action: "domain.remove", actor: sam, verb: "removed domain", target: { label: "old.horseai.example", href: "/domains" }, suffix: "from horseai / web", ...HOME }),
    ev("prune2", 5200, { category: "system", action: "prune", ...system, verb: "pruned", target: { label: "unused images", href: "/server" }, suffix: "12.1 GB freed" }),
    ev("sess1", 6000, { category: "access", action: "session.revoke", actor: sam, verb: "signed out a session on", target: null, suffix: "Edge on Windows", ...HOME }),
    ev("dom3", 7000, { category: "config", action: "domain.add", actor: sam, verb: "added domain", target: { label: "dev.brightlane.example", href: "/domains" }, suffix: "to brightlane / web", ...HOME }),
    ev("login2", 8200, { category: "access", action: "auth.login", actor: sam, verb: "signed in", target: null, ...HOME }),
    ev("ntf1", 9500, {
      category: "config", action: "settings.update", actor: lena, verb: "changed", target: { label: "notification settings", href: "/settings?section=notifications" }, ...LENA_AT,
      changes: [
        { key: "discordWebhookUrl", before: null, after: "••••••••/9mQe" },
        { key: "tlsExpiring", before: "on", after: "off" },
      ],
    }),
  ];

  return [...deploys, ...others].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** The preview applies the same filters and cursor paging the API must. The cursor is an offset. */
function queryPreviewActivity(query: ActivityQuery, now: Date): ActivityPage {
  const all = buildPreviewActivity(now);
  const q = query.q?.trim().toLowerCase();
  const rows = all.filter(
    (e) =>
      (!query.category || e.category === query.category) &&
      (!query.actor || (query.actor === "system" ? !e.actor : e.actor?.id === query.actor)) &&
      (!q || [e.actor?.name ?? "dockify", e.verb, e.target?.label ?? "", e.suffix ?? ""].join(" ").toLowerCase().includes(q)),
  );
  const start = Math.max(0, Number(query.cursor) || 0);
  const end = start + PAGE_SIZE;
  const actors = new Map<string, ActivityActor>();
  for (const e of all) if (e.actor) actors.set(e.actor.id, e.actor);
  return { items: rows.slice(start, end), nextCursor: end < rows.length ? String(end) : null, actors: [...actors.values()] };
}

export function buildPreviewSettings(now: Date): SettingsData {
  const { sam, lena, tomas, role } = previewPeople(now);
  const day = 24 * 60;
  return {
    me: {
      id: sam.id, name: sam.name, email: "sam@example.com", role, avatarUrl: sam.avatarUrl, twoFactor: { enabled: false }, emailVerified: true,
      githubLogin: PREVIEW_OWNER_GITHUB, githubVerified: true, timeZone: null, hour12: false, notify: { deployFailed: true, security: true },
    },
    sessions: [
      { id: "ses_1", device: "Chrome on macOS", kind: "desktop", ...HOME, lastSeenAt: ago(now, 0), createdAt: ago(now, 2 * day + 300), current: true },
      { id: "ses_2", device: "Safari on iPhone", kind: "mobile", ...HOME, lastSeenAt: ago(now, 190), createdAt: ago(now, 9 * day), current: false },
      { id: "ses_3", device: "Firefox on Windows", kind: "desktop", ip: "198.51.100.12", location: "Hamburg, DE", lastSeenAt: ago(now, 4 * day), createdAt: ago(now, 21 * day), current: false },
    ],
    team: {
      members: [
        { id: sam.id, name: sam.name, email: "sam@example.com", role, avatarUrl: sam.avatarUrl, joinedAt: ago(now, 300 * day), githubLogin: PREVIEW_OWNER_GITHUB, githubVerified: true },
        { id: lena.id, name: lena.name, email: "lena@example.com", role: "admin", avatarUrl: null, joinedAt: ago(now, 120 * day), githubLogin: "lenahart", githubVerified: false },
        { id: tomas.id, name: tomas.name, email: "tomas@example.com", role: "viewer", avatarUrl: null, joinedAt: ago(now, 1650), githubLogin: null, githubVerified: false },
      ],
      invites: [{ id: "inv_1", email: "noa@example.com", role: "viewer", createdAt: ago(now, 2 * day), expiresAt: ago(now, -5 * day) }],
    },
    settings: {
      instanceName: "Dockify",
      publicUrl: "https://dockify.example.com",
      defaultBranch: "main",
      buildConcurrency: 3,
      logRetentionDays: 14,
      notifications: {
        events: { deployFailed: true, appDown: true, backupFailed: true, tlsExpiring: false, previewDeployments: true, jobFailed: true },
      },
      previewDomain: "preview.example.com",
      previewDomainDefault: "preview.example.com",
      previewDomainCustom: false,
      terminalEnabled: true,
    },
    tokens: [
      { id: "tok_1", name: "ci-deploy", scope: "deploy", allProjects: false, projects: ["horseai", "inkwell"], prefix: "dk_8f3a", createdAt: ago(now, 1100), expiresAt: ago(now, 1100 - 90 * day), lastUsedAt: ago(now, 40) },
      { id: "tok_2", name: "grafana-read", scope: "read", allProjects: true, prefix: "dk_21c9", createdAt: ago(now, 30 * day), expiresAt: null, lastUsedAt: ago(now, 5) },
      { id: "tok_3", name: "ops-env-sync", scope: "admin", grants: ["env:write"], allProjects: false, projects: ["fieldnote"], prefix: "dk_c07e", createdAt: ago(now, 85 * day), expiresAt: ago(now, -5 * day), lastUsedAt: null },
    ],
  };
}

/* Deterministic helpers for preview writes (2FA secret, tokens, invite links). */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function seededString(seed: string, length: number, alphabet = B32) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  let out = "";
  for (let i = 0; i < length; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = (h + 0x9e3779b9) >>> 0;
    out += alphabet[h % alphabet.length];
  }
  return out;
}
