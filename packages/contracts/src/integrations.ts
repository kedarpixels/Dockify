import { z } from "zod";
import { Cursor, Email, EnvName, ExternalId, Hostname, HttpsUrl, Iso, SafeLabel, Slug, Uuid } from "./common.ts";
import { FaviconFacts, IconChoice, IconImageRef, LogoBase64 } from "./icons.ts";
import { TELEGRAM_CHAT, TELEGRAM_TOKEN, WEBHOOK_PROVIDERS, WEBHOOK_URL_MAX } from "./webhooks.ts";

// ------------------------------------------------------------------ git (GitHub App)

export const GitInstallation = z.object({
  id: z.string(),
  account: z.object({ login: z.string(), type: z.enum(["User", "Organization"]), avatarUrl: z.string().nullable() }),
  repositorySelection: z.enum(["all", "selected"]),
  selectedCount: z.number().optional(),
  manageUrl: z.string(),
});
export const GitInstallUrl = z.object({ url: z.string() });
/** GitHub's redirect after an install; the signed single-use state is the authentication. */
export const GitSetupQuery = z.strictObject({
  installation_id: z.string().regex(/^\d{1,20}$/).optional(),
  setup_action: z.enum(["install", "update", "request"]).optional(),
  state: z.string().max(512).optional(),
});
/**
 * A GitHub organization login, by GitHub's rules: letters, digits and single hyphens, not starting
 * or ending with a hyphen, at most 39 characters. It goes into a github.com path, so nothing else passes.
 */
export const GitHubLogin = z
  .string()
  .regex(/^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/, "Use the organization's GitHub login: letters, digits and single hyphens");
/** Where to create the App: the signed-in GitHub account when left out, or this organization. */
export const GitAppManifestBody = z.strictObject({ organization: GitHubLogin.optional() }).optional();
/** The form the web posts to GitHub to create this instance's GitHub App from a manifest. */
export const GitAppManifest = z.object({ postUrl: z.string(), manifest: z.record(z.string(), z.unknown()) });
/**
 * GitHub's redirect after it created the App; the signed single-use state is the authentication.
 * Both fields are optional and unknown ones are dropped, so even a malformed redirect lands on the
 * settings page with a failure instead of a bare JSON error. The handler checks the values.
 */
export const GitAppCallbackQuery = z.object({ code: z.string().max(2048).optional(), state: z.string().max(2048).optional() });
/** The GitHub App this instance created or was given; null until there is one. */
export const GitHubAppSummary = z.object({
  slug: z.string(),
  htmlUrl: z.string(),
  /** The account the App was created under; null for an App the installer was given. */
  owner: z.object({ login: z.string(), type: z.enum(["User", "Organization"]) }).nullable(),
  /** How it got here: created from the dashboard, or handed to the installer. */
  source: z.enum(["manifest", "installer"]),
  createdAt: Iso,
});
export const GitReposQuery = z.strictObject({ installation: ExternalId, q: z.string().max(100).optional(), cursor: Cursor.optional() });
export const GitRepo = z.object({
  id: z.string(),
  fullName: z.string(),
  name: z.string(),
  owner: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
  pushedAt: Iso,
  language: z.string().nullable(),
  framework: z.string().nullable().optional(),
});
export const GitRepoPage = z.object({ items: z.array(GitRepo), nextCursor: z.string().nullable() });
export const GitBranch = z.object({ name: z.string(), default: z.boolean() });
export const GitRef = z.strictObject({ installationId: ExternalId, repoId: ExternalId });

// ------------------------------------------------------------------ integrations
//
// Secrets are write-only: they go in through a body and only a hint ever comes back.

const Secret = z.string().min(1).max(4096);
const IntegrationError = z.string().nullable();

export const VercelTeam = z.object({ id: z.string(), name: z.string(), slug: z.string() });
export const VercelAccount = z.object({ username: z.string(), name: z.string().nullable() });
export const VercelCheck = z.object({ account: VercelAccount, teams: z.array(VercelTeam) });
/**
 * The deployment webhook Dockify registered with Vercel. active: Vercel calls Dockify on every
 * deployment event and the mirror syncs at once. unavailable: Vercel refused one (webhooks need a
 * Pro or Enterprise plan), so the mirror polls only. off: none registered; the mirror polls.
 */
export const VercelWebhookState = z.object({
  state: z.enum(["active", "unavailable", "off"]),
  /** Linked Vercel projects the webhook covers. */
  projects: z.number(),
  /** Linked Vercel projects it does not cover yet; registering again adds them. */
  missingProjects: z.number(),
  registeredAt: Iso.nullable(),
  /** Why Vercel refused it, when it did. */
  reason: z.string().nullable(),
});
/** The worker's deployment mirror: when it last read Vercel, and the last problem it hit. */
export const VercelMirrorState = z.object({
  syncedAt: Iso.nullable(),
  error: z.string().nullable(),
  /** Vercel projects linked to at least one app, which the mirror follows. */
  projects: z.number(),
});
export const VercelIntegration = z.object({
  account: VercelAccount,
  team: VercelTeam.nullable(),
  tokenHint: z.string(),
  connectedAt: Iso,
  error: IntegrationError,
  webhook: VercelWebhookState.optional(),
  mirror: VercelMirrorState.optional(),
});
/**
 * How far back Vercel keeps runtime logs. Vercel does not report the plan, so it is known only as
 * far as Dockify can tell: an accepted webhook means Pro or Enterprise (Hobby has no webhooks).
 */
export const VercelLogRetention = z.object({
  plan: z.enum(["pro_or_enterprise", "unknown"]),
  /** The shortest window the known plan guarantees, in hours; null when it depends on the plan. */
  minHours: z.number().nullable(),
  /** One sentence for the page, saying exactly that. */
  note: z.string(),
  /** Vercel's published windows, in hours. */
  byPlanHours: z.object({ hobby: z.number(), pro: z.number(), enterprise: z.number(), observabilityPlus: z.number() }),
  /** Lines Vercel returns per request. */
  linesPerRequest: z.number(),
});
export const VercelConnectBody = z.strictObject({ token: Secret, teamId: ExternalId.nullable().optional(), check: z.literal(true).optional() });
export const VercelTarget = z.enum(["production", "preview", "development"]);
export const VercelProject = z.object({
  id: z.string(),
  name: z.string(),
  framework: z.string().nullable(),
  updatedAt: Iso,
  env: z.array(z.object({ key: z.string(), targets: z.array(VercelTarget) })),
  domains: z.array(z.string()),
});
export const VercelImportBody = z.strictObject({ vercelProjectId: ExternalId, project: Slug, environment: EnvName, target: VercelTarget, confirmDangerous: z.boolean().optional() });
export const VercelImportResult = z.object({
  variables: z.number(),
  domains: z.number(),
  /** Domains left out because the environment has no single app to attach them to. */
  domainsSkipped: z.number(),
});

/**
 * One Vercel deployment as an app that follows a Vercel project shows it, read live from Vercel.
 * `deploymentId` is Dockify's mirrored row of it, when the mirror has one, so the page can link there.
 */
export const VercelDeploymentView = z.object({
  id: z.string(),
  /** Its own https address on Vercel. */
  url: z.string().nullable(),
  /** Vercel's inspector page, https on vercel.com. */
  inspectorUrl: z.string().nullable(),
  status: z.enum(["queued", "building", "ready", "failed", "cancelled"]),
  target: z.enum(["production", "preview"]),
  branch: z.string().nullable(),
  commit: z.string().nullable(),
  /** The commit message's first line. */
  message: z.string().nullable(),
  /** The commit on its Git host, https only. */
  commitUrl: z.string().nullable(),
  /** The Git login that wrote the commit, else the Vercel user that started it. */
  author: z.string().nullable(),
  createdAt: Iso,
  readyAt: Iso.nullable(),
  /** Build start to ready, as Vercel reports both; null while either is missing. */
  durationMs: z.number().nullable(),
  /** The hostnames Vercel assigned it: custom domains first, then its vercel.app names. */
  aliases: z.array(z.string()),
  deploymentId: z.string().nullable(),
});
/** A domain on the Vercel project. Read only: domains of a followed app are managed on Vercel. */
export const VercelProjectDomain = z.object({
  name: z.string(),
  verified: z.boolean(),
  /** Where it redirects to, when it is a redirect. */
  redirect: z.string().nullable(),
  redirectStatusCode: z.number().nullable(),
  /** Set when the domain serves one branch's preview rather than production. */
  gitBranch: z.string().nullable(),
  createdAt: Iso.nullable(),
});
/** Links into the Vercel dashboard for this project, https on vercel.com. */
export const VercelProjectLinks = z.object({ project: z.string(), deployments: z.string(), domains: z.string(), env: z.string(), settings: z.string() });
/** What Vercel knows about the project an app follows, for its Overview and Domains tabs. */
export const VercelProjectView = z.object({
  id: z.string(),
  name: z.string(),
  framework: z.string().nullable(),
  nodeVersion: z.string().nullable(),
  rootDirectory: z.string().nullable(),
  buildCommand: z.string().nullable(),
  installCommand: z.string().nullable(),
  outputDirectory: z.string().nullable(),
  repo: z.object({ provider: z.enum(["github", "gitlab", "bitbucket"]), slug: z.string(), url: z.string().nullable(), productionBranch: z.string().nullable() }).nullable(),
  links: VercelProjectLinks,
  production: VercelDeploymentView.nullable(),
  domains: z.array(VercelProjectDomain),
  /** Why the domain list could not be read; the rest of the project still shows. */
  domainsError: z.string().nullable(),
  fetchedAt: Iso,
});
/**
 * A Vercel project's environment variable. `value` is set only for a plain variable, as Vercel
 * returns it without decrypting, and only to an admin; Dockify never asks Vercel to decrypt one.
 */
export const VercelEnvVar = z.object({
  id: z.string(),
  key: z.string(),
  targets: z.array(VercelTarget),
  /** plain, encrypted, sensitive or system, as Vercel names it. */
  type: z.string(),
  gitBranch: z.string().nullable(),
  /** The comment on Vercel; for admins only. */
  comment: z.string().nullable(),
  updatedAt: Iso.nullable(),
  value: z.string().nullable(),
});
export const VercelEnvList = z.object({
  variables: z.array(VercelEnvVar),
  /** Production variables Vercel holds back from this token. */
  hiddenProductionCount: z.number(),
  /** Whether plain values are included for this caller. */
  values: z.boolean(),
  /** The project's environment variables page on vercel.com. */
  manageUrl: z.string(),
  fetchedAt: Iso,
});

export const CloudflareIntegration = z.object({
  account: z.object({ id: z.string(), name: z.string() }),
  tokenHint: z.string(),
  connectedAt: Iso,
  error: IntegrationError,
  zones: z.number(),
  managed: z.number(),
});
export const CloudflareConnectBody = z.strictObject({ token: Secret });
export const CloudflareZone = z.object({ id: z.string(), name: z.string(), status: z.enum(["active", "pending"]), managed: z.boolean() });
export const CloudflareZonePatch = z.strictObject({ managed: z.boolean() });

export const RegistryKind = z.enum(["ghcr", "dockerhub", "custom"]);
export const Registry = z.object({
  id: z.string(),
  kind: RegistryKind,
  host: z.string(),
  username: z.string(),
  tokenHint: z.string(),
  addedAt: Iso,
  error: IntegrationError,
});
const RegistryFields = {
  kind: RegistryKind,
  host: Hostname.optional(),
  username: z.string().min(1).max(200),
};
export const RegistryCreateBody = z.strictObject({ ...RegistryFields, token: Secret });
export const RegistryPatchBody = z.strictObject({
  kind: RegistryKind.optional(),
  host: Hostname.optional(),
  username: z.string().min(1).max(200).optional(),
  token: z.string().max(4096).optional(),
});

export const StorageProvider = z.enum(["r2", "s3", "minio", "custom"]);
export const StorageDestination = z.object({
  id: z.string(),
  name: z.string(),
  provider: StorageProvider,
  endpoint: z.string(),
  bucket: z.string(),
  region: z.string(),
  accessKeyHint: z.string(),
  secretKeyHint: z.string(),
  isDefault: z.boolean(),
  lastTestedAt: Iso.nullable(),
  error: IntegrationError,
});
const Bucket = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
const Region = z.string().regex(/^[a-z0-9-]{1,40}$/);
export const StorageCreateBody = z.strictObject({
  name: SafeLabel(60, 1),
  provider: StorageProvider,
  endpoint: HttpsUrl,
  bucket: Bucket,
  region: Region,
  accessKey: Secret,
  secretKey: Secret,
  isDefault: z.boolean().optional(),
});
export const StoragePatchBody = z.strictObject({
  name: SafeLabel(60, 1).optional(),
  provider: StorageProvider.optional(),
  endpoint: HttpsUrl.optional(),
  bucket: Bucket.optional(),
  region: Region.optional(),
  accessKey: z.string().max(4096).optional(),
  secretKey: z.string().max(4096).optional(),
  isDefault: z.boolean().optional(),
});
export const StorageTestResult = z.object({ latencyMs: z.number() });

// ------------------------------------------------------------------ notification webhooks
//
// A list of named webhooks, each with a provider that decides the message format (webhooks.ts has
// the providers and how a URL is recognised). The URL, a Telegram bot token, a generic webhook's
// signing secret and an ntfy access token are write-only: only the host and a four character hint
// come back. A generated signing secret is answered once, by the call that made it.

export const WebhookProvider = z.enum(WEBHOOK_PROVIDERS);
export type WebhookProvider = z.infer<typeof WebhookProvider>;

const WebhookName = z.string().trim().min(1, "Give the webhook a name").max(60, "Use 60 characters or fewer").regex(/^[^\u0000-\u001f\u007f<>]+$/, "Leave out angle brackets");
const WebhookUrl = z.string().trim().min(1, "Paste the webhook URL").max(WEBHOOK_URL_MAX);
const TelegramToken = z.string().trim().regex(TELEGRAM_TOKEN, "Paste the token BotFather gave you: digits, a colon, then letters");
const TelegramChat = z.string().trim().regex(TELEGRAM_CHAT, "Use the chat's numeric id, or @name for a public channel");
const SigningSecret = z.string().regex(/^[\x21-\x7e]{16,256}$/, "Use 16 to 256 printable characters, no spaces");
const AccessToken = z.string().trim().regex(/^[\x21-\x7e]{8,256}$/, "Paste the access token as ntfy shows it");

/**
 * A generic webhook's logo: auto is its site's favicon, url a link Dockify downloads once and keeps,
 * upload an image sent here. PNG, JPEG, WebP, GIF, ICO or SVG, at most 128 KB; an SVG is rebuilt
 * from an allowlist before it is stored. Built-in providers always show their own mark.
 */
export const WebhookLogoBody = z.discriminatedUnion("choice", [
  z.strictObject({ choice: z.literal("auto") }),
  z.strictObject({ choice: z.literal("url"), url: HttpsUrl }),
  z.strictObject({ choice: z.literal("upload"), image: LogoBase64 }),
]);
export type WebhookLogoBody = z.infer<typeof WebhookLogoBody>;

export const WebhookCreateBody = z.strictObject({
  /** Defaults to the provider's name, numbered when taken. */
  name: WebhookName.optional(),
  /** Recognised from the URL when left out. */
  provider: WebhookProvider.optional(),
  /** Every provider's endpoint. Telegram takes botToken and chatId instead, or a bot URL. */
  url: WebhookUrl.optional(),
  botToken: TelegramToken.optional(),
  chatId: TelegramChat.optional(),
  /** Generic only: the HMAC secret. Dockify makes one when it is left out and answers it once. */
  signingSecret: SigningSecret.optional(),
  /** ntfy only: an access token for a protected topic. */
  accessToken: AccessToken.optional(),
  enabled: z.boolean().optional(),
  /** Also send Dockify update notices here (default on). */
  updates: z.boolean().optional(),
  logo: WebhookLogoBody.optional(),
});
export type WebhookCreateBody = z.infer<typeof WebhookCreateBody>;

export const WebhookPatchBody = z.strictObject({
  name: WebhookName.optional(),
  provider: WebhookProvider.optional(),
  /** A new endpoint replaces the stored one. */
  url: WebhookUrl.optional(),
  botToken: TelegramToken.optional(),
  chatId: TelegramChat.optional(),
  /** Generic: a value replaces the secret, "rotate" has Dockify make a new one (answered once). */
  signingSecret: z.union([z.literal("rotate"), SigningSecret]).optional(),
  /** ntfy: a value replaces the token, null removes it. */
  accessToken: AccessToken.nullable().optional(),
  enabled: z.boolean().optional(),
  updates: z.boolean().optional(),
  logo: WebhookLogoBody.optional(),
});
export type WebhookPatchBody = z.infer<typeof WebhookPatchBody>;

export const WebhookIcon = z.object({
  /** auto: the provider's mark, or a generic webhook's favicon. upload: a logo the owner gave. */
  choice: IconChoice,
  /** The stored image a generic webhook shows (integrations.webhooks.icon); null draws the provider's mark or the webhook glyph. */
  image: IconImageRef.nullable(),
  /** The link a logo was downloaded from, when it came from one. */
  logoUrl: z.string().nullable(),
  /** A generic webhook's last favicon fetch while automatic. */
  favicon: FaviconFacts.nullable(),
});
export type WebhookIcon = z.infer<typeof WebhookIcon>;

export const Webhook = z.object({
  id: z.string(),
  name: z.string(),
  provider: WebhookProvider,
  enabled: z.boolean(),
  updates: z.boolean(),
  host: z.string(),
  /** The last four characters of the URL's secret part (token, signature or topic); "" when too short to show. */
  hint: z.string(),
  /** Telegram: the chat the bot posts to. */
  chatId: z.string().nullable(),
  /** Generic: the signing secret's last four characters. */
  signingSecretHint: z.string().nullable(),
  /** ntfy: the access token's last four characters, when one is stored. */
  accessTokenHint: z.string().nullable(),
  /** ok: the last delivery got through. failing: it did not, and error says why. never: nothing sent yet. */
  status: z.enum(["ok", "failing", "never"]),
  error: z.string().nullable(),
  lastSentAt: Iso.nullable(),
  lastFailedAt: Iso.nullable(),
  /** How many alert rules send here. */
  rules: z.number(),
  icon: WebhookIcon,
  createdAt: Iso,
});
export type Webhook = z.infer<typeof Webhook>;

/** Create and patch answer the webhook, and a signing secret only when Dockify just made one. */
export const WebhookSaved = z.object({ webhook: Webhook, signingSecret: z.string().nullable() });

/** A webhook as the alert rules and the integrations row name it: no hints, no errors. */
export const WebhookRef = z.object({ id: z.string(), name: z.string(), provider: WebhookProvider, enabled: z.boolean(), icon: WebhookIcon });
export type WebhookRef = z.infer<typeof WebhookRef>;

/** Sends one test message: to a saved webhook, or to one not saved yet (the add form). */
export const WebhookTestBody = z.union([
  z.strictObject({ id: Uuid }),
  z.strictObject({
    provider: WebhookProvider.optional(),
    url: WebhookUrl.optional(),
    botToken: TelegramToken.optional(),
    chatId: TelegramChat.optional(),
    signingSecret: SigningSecret.optional(),
    accessToken: AccessToken.optional(),
  }),
]);
export const WebhookTestResult = z.object({ provider: WebhookProvider, status: z.number(), latencyMs: z.number() });

// ------------------------------------------------------------------ email (SMTP)
//
// Optional per install: each self-hoster brings their own mail server and login. Without it Dockify
// keeps the copy-link invites and the host CLI reset (dockify admin), and sends nothing.

/** How the connection is encrypted. There is no plain option: mail and credentials never cross one. */
export const EmailTlsMode = z.enum(["implicit", "starttls"]);
/** The mail ports Dockify connects to; packages/email SMTP_PORTS holds the same list (an apps/api test keeps them equal). */
export const EmailPort = z.union([z.literal(25), z.literal(465), z.literal(587), z.literal(2465), z.literal(2525), z.literal(2587)]);
export const EmailIntegration = z.object({
  host: z.string(),
  port: z.number(),
  tlsMode: EmailTlsMode,
  username: z.string(),
  /** Whether a password is stored. The password itself never comes back. */
  hasPassword: z.boolean(),
  fromName: z.string(),
  fromAddress: z.string(),
  replyTo: z.string().nullable(),
  connectedAt: Iso,
  error: IntegrationError,
});
const FromName = z.string().trim().min(1).max(60).regex(/^[^"<>\\\r\n]+$/, "Leave out quotes and angle brackets");
export const EmailConnectBody = z.strictObject({
  host: Hostname,
  port: EmailPort,
  tlsMode: EmailTlsMode,
  username: z.string().trim().min(1).max(254).refine((v) => !/[\p{Cc}]/u.test(v), "One line, no control characters"),
  /** Required the first time and when the host or username changes; left out, the stored one stays. */
  password: z.string().min(1).max(1024).refine((v) => !/[\r\n]/.test(v), "One line").optional(),
  fromName: FromName,
  fromAddress: Email,
  replyTo: Email.nullable().optional(),
});
/** The stored settings with no body or an empty one, or the form's values, unsaved. */
export const EmailTestBody = z.union([z.strictObject({}), EmailConnectBody]).optional();
/** The test goes to the signed-in user's own address, never to one typed in. */
export const EmailTestResult = z.object({ to: z.string() });

/** What a Viewer gets from the summary: what is connected, and none of the details the admin routes hold. */
export const IntegrationsConnected = z.object({
  limited: z.literal(true),
  github: z.boolean(),
  vercel: z.boolean(),
  cloudflare: z.boolean(),
  registries: z.boolean(),
  storage: z.boolean(),
  webhooks: z.boolean(),
  email: z.boolean(),
});

export const IntegrationsSummary = z.object({
  github: z.object({ accounts: z.number(), app: GitHubAppSummary.nullable() }),
  vercel: VercelIntegration.nullable(),
  cloudflare: CloudflareIntegration.nullable(),
  registries: z.array(Registry),
  storage: z.array(StorageDestination),
  webhooks: z.array(WebhookRef),
  email: EmailIntegration.nullable(),
});
