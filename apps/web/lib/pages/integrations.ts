import "server-only";
import { connection } from "next/server";
import { apiRequest, type Method } from "@/lib/api";
import type { OverviewSource } from "@/lib/types";
import { webhookRefOf, type Webhook, type WebhookRef } from "@/lib/webhooks";
import { isPreviewMode } from "@/lib/preview-mode";
import type { EmailTlsMode } from "@/components/activity-settings/integrations/email-rules";

// Integrations loader. Secrets are write-only: a token, key or webhook URL never comes back, only a
// hint (its last four characters). An empty or missing secret on a PATCH keeps the stored one.

export type IntegrationStatus = "connected" | "disconnected" | "error";

export interface VercelTeam {
  id: string;
  name: string;
  slug: string;
}

export interface VercelAccount {
  username: string;
  name: string | null;
}

export interface VercelCheck {
  account: VercelAccount;
  teams: VercelTeam[];
}

export interface VercelIntegration {
  account: VercelAccount;
  /** The team the token reads; null reads the personal account. */
  team: VercelTeam | null;
  tokenHint: string;
  connectedAt: string;
  /** Set when the API can no longer use the token. */
  error: string | null;
  webhook?: VercelWebhookState;
  mirror?: VercelMirrorState;
}

/** active: Vercel calls Dockify on each deployment event. unavailable: Vercel refused one, usually the plan. off: none registered. Dockify polls in both. */
export interface VercelWebhookState {
  state: "active" | "unavailable" | "off";
  /** Linked Vercel projects it covers, and those it does not cover yet. */
  projects: number;
  missingProjects: number;
  registeredAt: string | null;
  reason: string | null;
}

/** When the deployment mirror last read Vercel, and the last problem it hit. */
export interface VercelMirrorState {
  syncedAt: string | null;
  error: string | null;
  /** Vercel projects at least one app is linked to. */
  projects: number;
}

export type VercelTarget = "production" | "preview" | "development";

export interface VercelEnvVar {
  key: string;
  targets: VercelTarget[];
}

export interface VercelProject {
  id: string;
  name: string;
  framework: string | null;
  updatedAt: string;
  env: VercelEnvVar[];
  domains: string[];
}

export interface VercelImportInput {
  vercelProjectId: string;
  /** Dockify project slug and environment name. */
  project: string;
  environment: string;
  target: VercelTarget;
}

export interface VercelImportResult {
  domainsSkipped?: number;
  variables: number;
  domains: number;
}

export interface CloudflareIntegration {
  account: { id: string; name: string };
  tokenHint: string;
  connectedAt: string;
  error: string | null;
  /** Zones the token can edit, and how many of them Dockify manages. */
  zones: number;
  managed: number;
}

export interface CloudflareZone {
  id: string;
  name: string;
  status: "active" | "pending";
  managed: boolean;
}

export type RegistryKind = "ghcr" | "dockerhub" | "custom";

export interface Registry {
  id: string;
  kind: RegistryKind;
  /** ghcr.io, docker.io or the custom registry's host. */
  host: string;
  username: string;
  tokenHint: string;
  addedAt: string;
  error: string | null;
}

export interface RegistryInput {
  kind: RegistryKind;
  /** Custom registries only. */
  host?: string;
  username: string;
  token?: string;
}

export type StorageProvider = "r2" | "s3" | "minio" | "custom";

export interface StorageDestination {
  id: string;
  name: string;
  provider: StorageProvider;
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyHint: string;
  secretKeyHint: string;
  isDefault: boolean;
  lastTestedAt: string | null;
  error: string | null;
}

export interface StorageInput {
  name: string;
  provider: StorageProvider;
  endpoint: string;
  bucket: string;
  region: string;
  accessKey?: string;
  secretKey?: string;
  isDefault?: boolean;
}

/** This server's own GitHub App, once it has one. */
export interface GitHubApp {
  slug: string;
  /** Its page on github.com, where its owner manages or deletes it. */
  htmlUrl: string;
  /** The account it was created under; null for an App the installer was given. */
  owner: { login: string; type: "User" | "Organization" } | null;
  source: "manifest" | "installer";
  createdAt: string;
}

/** What the browser posts to GitHub to create the App. */
export interface GitHubManifest {
  postUrl: string;
  manifest: Record<string, unknown>;
}

export interface EmailIntegration {
  host: string;
  port: number;
  tlsMode: EmailTlsMode;
  username: string;
  /** Whether a password is stored. The password itself never comes back. */
  hasPassword: boolean;
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
  connectedAt: string;
  error: string | null;
}

export interface EmailInput {
  host: string;
  port: number;
  tlsMode: EmailTlsMode;
  username: string;
  password?: string;
  fromName: string;
  fromAddress: string;
  replyTo?: string | null;
}

/** What a Viewer is told: which integrations are connected, nothing about them. */
export interface IntegrationsConnected {
  limited: true;
  github: boolean;
  vercel: boolean;
  cloudflare: boolean;
  registries: boolean;
  storage: boolean;
  webhooks: boolean;
  email: boolean;
}

export interface IntegrationsSummary {
  /** Set for a Viewer, and then every card below is empty. */
  connected?: IntegrationsConnected;
  github: { accounts: number; app: GitHubApp | null };
  vercel: VercelIntegration | null;
  cloudflare: CloudflareIntegration | null;
  registries: Registry[];
  storage: StorageDestination[];
  webhooks: WebhookRef[];
  email: EmailIntegration | null;
}

export interface IntegrationsResult {
  source: OverviewSource;
  /** Always set: without a source every card reads Not connected. */
  data: IntegrationsSummary;
  error?: string;
  fetchedAt: string;
}

export interface IntegrationsAnswer<T> {
  source: OverviewSource;
  data: T | null;
  error?: string;
  /** step_up_required (lib/step-up.ts) when the write needs a fresh step-up. */
  code?: string;
}

/** Ids are opaque but short and URL safe; anything else is refused before the API. */
export const isIntegrationId = (v: unknown): v is string => typeof v === "string" && /^[\w-]{1,64}$/.test(v);

/** Hint for a secret: its last four characters. */
export const hintOf = (secret: string) => secret.slice(-4);

export function integrationsSource(): OverviewSource {
  if (process.env.DOCKIFY_API_URL) return "api";
  if (isPreviewMode()) return "preview";
  return "none";
}

export const NO_API = "No data source, set DOCKIFY_API_URL for this dashboard";

export type ApiAnswer<T> = { ok: true; body: T } | { ok: false; status: number; error: string; code?: string };

/** A test send reaches an outside service, so it may wait up to a minute. */
export async function integrationsApi<T>(method: Method, path: string, body?: unknown): Promise<ApiAnswer<T>> {
  if (!process.env.DOCKIFY_API_URL) return { ok: false, status: 503, error: NO_API };
  const r = await apiRequest<T>(path, { method, body, timeoutMs: method === "GET" ? undefined : 60_000 });
  return r.ok ? { ok: true, body: r.data } : { ok: false, status: r.status, error: r.error, code: r.code };
}

const EMPTY: IntegrationsSummary = {
  github: { accounts: 0, app: null },
  vercel: null,
  cloudflare: null,
  registries: [],
  storage: [],
  webhooks: [],
  email: null,
};

/** The summary for the Integrations section. Without a source every card reads Not connected. */
export async function getIntegrations(): Promise<IntegrationsResult> {
  await connection();
  const fetchedAt = new Date().toISOString();
  const source = integrationsSource();
  if (source === "api") {
    const res = await integrationsApi<IntegrationsSummary | IntegrationsConnected>("GET", "/api/v1/integrations");
    if (!res.ok) return { source, data: EMPTY, error: res.error, fetchedAt };
    if (res.body && "limited" in res.body) return { source, data: { ...EMPTY, connected: res.body }, fetchedAt };
    const d = res.body;
    return {
      source,
      data: {
        github: { accounts: d?.github?.accounts ?? 0, app: d?.github?.app ?? null },
        vercel: d?.vercel ?? null,
        cloudflare: d?.cloudflare ?? null,
        registries: d?.registries ?? [],
        storage: d?.storage ?? [],
        webhooks: d?.webhooks ?? [],
        email: d?.email ?? null,
      },
      fetchedAt,
    };
  }
  if (source === "preview") return { source, data: previewIntegrations(new Date()), fetchedAt };
  return { source, data: EMPTY, fetchedAt };
}

// Preview fixture. Accounts, zones and the R2 bucket match lib/pages/git.ts, lib/preview-fixture.ts and the Backups page.

const DAY = 86_400_000;
const ago = (now: Date, days: number) => new Date(now.getTime() - days * DAY).toISOString();

export const PREVIEW_ZONES: CloudflareZone[] = [
  { id: "zn_horseai", name: "horseai.example", status: "active", managed: true },
  { id: "zn_inkwell", name: "inkwell.example", status: "active", managed: true },
  { id: "zn_brightlane", name: "brightlane.example", status: "active", managed: true },
  { id: "zn_sword", name: "fieldnote.example", status: "active", managed: false },
];

export const PREVIEW_VERCEL_CHECK: VercelCheck = {
  account: { username: "sam", name: "Sam" },
  teams: [{ id: "team_acme", name: "acme-labs", slug: "acme-labs" }],
};

/** What is still on Vercel: the Inkwell site and admin before the move, and the portfolio. */
export function previewVercelProjects(now: Date): VercelProject[] {
  const all: VercelTarget[] = ["production", "preview", "development"];
  return [
    {
      id: "prj_ink_web",
      name: "inkwell-web",
      framework: "Next.js",
      updatedAt: ago(now, 2),
      domains: ["inkwell.example", "www.inkwell.example"],
      env: [
        { key: "NEXT_PUBLIC_API_URL", targets: ["production"] },
        { key: "NEXT_PUBLIC_API_URL", targets: ["preview", "development"] },
        { key: "NEXT_PUBLIC_SOCKET_URL", targets: ["production"] },
        { key: "DISCORD_CLIENT_ID", targets: all },
        { key: "SESSION_SECRET", targets: ["production"] },
        { key: "SESSION_SECRET", targets: ["preview"] },
      ],
    },
    {
      id: "prj_ink_admin",
      name: "inkwell-admin",
      framework: "Next.js",
      updatedAt: ago(now, 6),
      domains: ["admin.inkwell.example"],
      env: [
        { key: "NEXT_PUBLIC_API_URL", targets: ["production"] },
        { key: "ADMIN_SESSION_SECRET", targets: ["production", "preview"] },
      ],
    },
    {
      id: "prj_portfolio",
      name: "portfolio",
      framework: "Next.js",
      updatedAt: ago(now, 19),
      domains: [],
      env: [{ key: "NEXT_PUBLIC_SITE_URL", targets: all }],
    },
  ];
}

/** The webhooks the design preview starts with: one per kind of row the list can show. */
export function previewWebhooks(now: Date): Webhook[] {
  const auto = { choice: "auto" as const, image: null, logoUrl: null, favicon: null };
  const base = { enabled: true, updates: true, chatId: null, signingSecretHint: null, accessTokenHint: null, status: "ok" as const, error: null, lastFailedAt: null, icon: auto };
  return [
    { ...base, id: "wh_ops", name: "Ops alerts", provider: "discord", host: "discord.com", hint: "9mQe", lastSentAt: ago(now, 0.03), rules: 7, createdAt: ago(now, 64) },
    { ...base, id: "wh_ink", name: "Inkwell team", provider: "slack", host: "hooks.slack.com", hint: "Xw2P", updates: false, lastSentAt: ago(now, 1.4), rules: 2, createdAt: ago(now, 30) },
    {
      ...base, id: "wh_oncall", name: "On call", provider: "telegram", host: "api.telegram.org", hint: "Dsaw", chatId: "-1002214470356", status: "failing",
      error: "Telegram answered 403 (Forbidden: bot was kicked from the supergroup chat)", lastSentAt: ago(now, 6), lastFailedAt: ago(now, 0.2), rules: 1, createdAt: ago(now, 12),
    },
    {
      ...base, id: "wh_relay", name: "Status relay", provider: "generic", host: "hooks.horseai.example", hint: "", signingSecretHint: "f1Zq", updates: false, status: "never",
      lastSentAt: null, rules: 0, createdAt: ago(now, 2), icon: { ...auto, favicon: { origin: null, fetchedAt: null, checkedAt: ago(now, 2), error: "No favicon found" } },
    },
  ];
}

export function previewIntegrations(now: Date): IntegrationsSummary {
  return {
    github: {
      accounts: 2,
      app: {
        slug: "dockify-dash-horseai-example",
        htmlUrl: "https://github.com/apps/dockify-dash-horseai-example",
        owner: { login: "acme-labs", type: "Organization" },
        source: "manifest",
        createdAt: ago(now, 88),
      },
    },
    vercel: {
      account: PREVIEW_VERCEL_CHECK.account,
      team: PREVIEW_VERCEL_CHECK.teams[0] ?? null,
      tokenHint: "aK9f",
      connectedAt: ago(now, 12),
      error: null,
      webhook: { state: "off", projects: 0, missingProjects: 0, registeredAt: null, reason: null },
      mirror: { syncedAt: new Date(now.getTime() - 90_000).toISOString(), error: null, projects: 1 },
    },
    cloudflare: {
      account: { id: "cf_acme", name: "acme-labs" },
      tokenHint: "Zr4k",
      connectedAt: ago(now, 41),
      error: null,
      zones: PREVIEW_ZONES.length,
      managed: PREVIEW_ZONES.filter((z) => z.managed).length,
    },
    registries: [{ id: "reg_ghcr", kind: "ghcr", host: "ghcr.io", username: "acme-labs", tokenHint: "x7Qe", addedAt: ago(now, 88), error: null }],
    storage: [
      {
        id: "dst_r2",
        name: "Cloudflare R2",
        provider: "r2",
        endpoint: "https://4c1d2e0f9a7b.r2.cloudflarestorage.com",
        bucket: "dockify-backups",
        region: "auto",
        accessKeyHint: "9f2c",
        secretKeyHint: "Lw0e",
        isDefault: true,
        lastTestedAt: ago(now, 0.2),
        error: null,
      },
    ],
    webhooks: previewWebhooks(now).map(webhookRefOf),
    email: previewEmail(now),
  };
}

/** A mail server for the horseai zone: the address alert emails come from. */
export function previewEmail(now: Date): EmailIntegration {
  return {
    host: "smtp.resend.com",
    port: 465,
    tlsMode: "implicit",
    username: "resend",
    hasPassword: true,
    fromName: "Dockify",
    fromAddress: "dockify@horseai.example",
    replyTo: null,
    connectedAt: ago(now, 12),
    error: null,
  };
}
