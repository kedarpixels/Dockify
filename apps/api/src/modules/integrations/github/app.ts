/**
 * GitHub App plumbing, ported from the old api (github.ts) onto the one secrets table: the App
 * JWT, the webhook HMAC check, signed single-use state for the install and manifest round trips,
 * the manifest code exchange, the REST helper and the in-memory installation token cache.
 *
 * The App lives in the integrations table as kind github_app, name "default":
 *   config        { appId, slug, clientId?, htmlUrl?, owner?, source?, clientSecretId? }
 *   secretId      the private key (github_private_key)
 *   secondSecretId the webhook secret (github_webhook_secret)
 *   clientSecretId the OAuth client secret GitHub hands over once with a manifest App
 *                  (github_client_secret, owned by the row like the other two). Kept sealed for a
 *                  later sign-in with GitHub; nothing reads it today and nothing ever shows it.
 */
import { createHash, createHmac, createPrivateKey, randomBytes, timingSafeEqual } from "node:crypto";
import type { Keyring } from "@dockify/crypto";
import { githubAppJwt, readSecret } from "@dockify/crypto";
import { storeSecret, type Integration, type Tx } from "@dockify/db";
import { HttpError } from "../../../errors.ts";
import { jsonOf, OutboundError, type HttpClient, type HttpResponse } from "@dockify/net-guard";
import { asJson, configOf, findIntegration, openSecret, setupDone } from "../store.ts";

export const GITHUB_API = "https://api.github.com";
export const GITHUB_WEB = "https://github.com";

export interface GitHubAppOwner {
  login: string;
  type: "User" | "Organization";
}

export interface GitHubAppConfig {
  appId: number;
  slug: string;
  clientId?: string;
  htmlUrl?: string;
  /** The account the App was created under, from the manifest exchange. */
  owner?: GitHubAppOwner;
  /** manifest: created from the dashboard. installer: handed to the installer. */
  source?: "manifest" | "installer";
  /** The sealed OAuth client secret's row. */
  clientSecretId?: string;
}

export interface GitHubAppRow {
  row: Integration;
  config: GitHubAppConfig;
}

const isOwner = (v: unknown): v is GitHubAppOwner =>
  !!v && typeof v === "object" && typeof (v as GitHubAppOwner).login === "string" && ((v as GitHubAppOwner).type === "User" || (v as GitHubAppOwner).type === "Organization");

export async function loadGitHubApp(db: Tx): Promise<GitHubAppRow | null> {
  const row = await findIntegration(db, "github_app");
  if (!row || row.status === "disconnected") return null;
  const c = configOf<Partial<GitHubAppConfig>>(row);
  if (typeof c.appId !== "number" || typeof c.slug !== "string") return null;
  return {
    row,
    config: {
      appId: c.appId, slug: c.slug, clientId: c.clientId, htmlUrl: c.htmlUrl,
      owner: isOwner(c.owner) ? { login: c.owner.login, type: c.owner.type } : undefined,
      // A manifest App always came with a client id; an App from the installer's variables never does.
      source: c.source === "manifest" || c.source === "installer" ? c.source : c.clientId ? "manifest" : "installer",
      clientSecretId: typeof c.clientSecretId === "string" ? c.clientSecretId : undefined,
    },
  };
}

export async function requireGitHubApp(db: Tx): Promise<GitHubAppRow> {
  const app = await loadGitHubApp(db);
  if (!app) throw new HttpError(409, "No GitHub App is configured on this server", "GITHUB_APP_MISSING");
  return app;
}

/**
 * Seeds the App row from the environment on boot when no row exists: DOCKIFY_GITHUB_APP_ID,
 * DOCKIFY_GITHUB_APP_SLUG, DOCKIFY_GITHUB_APP_PRIVATE_KEY(_FILE), DOCKIFY_GITHUB_WEBHOOK_SECRET(_FILE).
 * Returns true when it created the row. Both secrets are sealed on arrival.
 */
export async function seedGitHubAppFromEnv(db: Tx, ring: Keyring, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const appId = Number(readSecret("DOCKIFY_GITHUB_APP_ID", env));
  const slug = readSecret("DOCKIFY_GITHUB_APP_SLUG", env);
  const pem = readSecret("DOCKIFY_GITHUB_APP_PRIVATE_KEY", env);
  const hook = readSecret("DOCKIFY_GITHUB_WEBHOOK_SECRET", env);
  if (!Number.isInteger(appId) || appId <= 0 || !slug || !pem || !hook) return false;
  // Only before setup completes. The secret files stay mounted, so seeding on every boot would bring
  // back an integration the owner disconnected (or a key they rotated away) at the next restart.
  if ((await setupDone(db)) || (await findIntegration(db, "github_app"))) return false;
  const row = await db.integration.create({ data: { kind: "github_app", name: "default", config: asJson({ appId, slug, source: "installer" }) } });
  const pk = await storeSecret(db, ring, { kind: "github_private_key", ownerType: "integration", ownerId: row.id }, pem, null);
  const wh = await storeSecret(db, ring, { kind: "github_webhook_secret", ownerType: "integration", ownerId: row.id }, hook, null);
  await db.integration.update({ where: { id: row.id }, data: { secretId: pk, secondSecretId: wh } });
  return true;
}

// ------------------------------------------------------------------ manifest (for the create flow)

/** Host labels that say nothing about who runs this server. */
const GENERIC_LABEL = /^(?:dockify|www|app|apps|dash|dashboard|console|deploy|deploys|paas|panel|admin|cloud|server|host|sslip|nip|xip|localhost)$/;

/**
 * The App's default name, which is also its bot's name on every pull request: dockify-<word>-<hash>,
 * or dockify-<hash> when the host offers no word. GitHub App names are unique across all of GitHub
 * and at most 34 characters, so the hash of the whole host keeps two installs apart, and the word is
 * the first label that names someone: dash.acme.dev reads dockify-acme-3fa9c1. An address never
 * becomes the word, so an IP host (1-2-3-4.sslip.io) does not publish the server's IP in the name.
 * GitHub shows the name before creating the App, so a name that is taken anyway can be changed there.
 */
export function manifestAppName(origin: string): string {
  const host = new URL(origin).hostname.toLowerCase();
  const hash = createHash("sha256").update(host).digest("hex").slice(0, 6);
  const labels = host.split(".").slice(0, -1);
  const word = labels.find((l) => /^[a-z][a-z0-9-]*$/.test(l) && !l.startsWith("xn--") && !GENERIC_LABEL.test(l));
  return word ? `dockify-${word.slice(0, 18).replace(/-+$/, "")}-${hash}` : `dockify-${hash}`;
}

/** Least privilege: clone and read (contents), the sticky PR comment (pull_requests), the preview commit status (statuses), metadata. */
export function buildManifest(origin: string): Record<string, unknown> {
  return {
    name: manifestAppName(origin),
    url: origin,
    hook_attributes: { url: `${origin}/api/v1/webhooks/github`, active: true },
    redirect_url: `${origin}/api/v1/git/app/callback`,
    setup_url: `${origin}/api/v1/git/setup`,
    setup_on_update: true,
    public: false,
    default_permissions: { contents: "read", metadata: "read", pull_requests: "write", statuses: "write" },
    default_events: ["push", "pull_request"],
  };
}

/** A GitHub App page always lives on github.com; anything else becomes the URL the slug predicts. */
export function safeAppHtmlUrl(candidate: string | undefined, slug: string): string {
  const fallback = `${GITHUB_WEB}/apps/${encodeURIComponent(slug)}`;
  try {
    const u = new URL(candidate ?? "");
    if (u.protocol === "https:" && u.hostname === "github.com") return u.toString();
  } catch {
    // fall through
  }
  return fallback;
}

/**
 * Where the browser posts the manifest. The App is private, and a private App can only be
 * installed on the account that owns it, so an organization's repositories need the App created
 * under that organization. The login was checked against GitHub's rules by the contract.
 */
export function manifestPostUrl(state: string, organization?: string): string {
  const page = organization ? `${GITHUB_WEB}/organizations/${encodeURIComponent(organization)}/settings/apps/new` : `${GITHUB_WEB}/settings/apps/new`;
  return `${page}?state=${encodeURIComponent(state)}`;
}

/** What Dockify keeps from GitHub's answer to the manifest code exchange. */
export interface ManifestConversion {
  appId: number;
  slug: string;
  clientId: string;
  htmlUrl: string;
  pem: string;
  webhookSecret: string;
  /** The OAuth client secret; GitHub shows it only in this answer. Null when it sent none. */
  clientSecret: string | null;
  /** The account the App belongs to; null when GitHub's answer did not say in a usable form. */
  owner: GitHubAppOwner | null;
}

// The worker reads appId back with /^\d{1,12}$/, so a larger id could never sign a clone token.
const MAX_APP_ID = 999_999_999_999;
const APP_SLUG = /^[A-Za-z0-9][\w.-]{0,99}$/;
const CLIENT_ID = /^[\w.-]{1,100}$/;
const CLIENT_SECRET = /^[\w.-]{20,256}$/;
const WEBHOOK_SECRET = /^[\x21-\x7e]{8,256}$/;
const PEM_HEAD = /^-----BEGIN (?:RSA )?PRIVATE KEY-----\r?\n/;
const OWNER_LOGIN = /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/;

/** True for an unencrypted RSA private key in PEM form, the only kind githubAppJwt can sign with. */
function isRsaPrivateKeyPem(pem: string): boolean {
  if (pem.length > 16_384 || !PEM_HEAD.test(pem)) return false;
  try {
    return createPrivateKey({ key: pem, format: "pem" }).asymmetricKeyType === "rsa";
  } catch {
    return false;
  }
}

/**
 * Checks every field Dockify stores before anything is written, so a malformed answer can never
 * leave a half usable App behind. The client secret and the owner are optional extras: a malformed
 * one is dropped, never a reason to refuse the App. The page link goes through safeAppHtmlUrl, so
 * only a github.com link is kept.
 */
export function parseManifestConversion(body: unknown): ManifestConversion | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const { id, slug, client_id: clientId, client_secret: clientSecret, pem, webhook_secret: webhookSecret, html_url: htmlUrl, owner } = b;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || id > MAX_APP_ID) return null;
  if (typeof slug !== "string" || !APP_SLUG.test(slug)) return null;
  if (typeof clientId !== "string" || !CLIENT_ID.test(clientId)) return null;
  if (typeof webhookSecret !== "string" || !WEBHOOK_SECRET.test(webhookSecret)) return null;
  if (typeof pem !== "string" || !isRsaPrivateKeyPem(pem)) return null;
  const o = owner && typeof owner === "object" ? (owner as Record<string, unknown>) : null;
  const login = typeof o?.login === "string" && OWNER_LOGIN.test(o.login) ? o.login : null;
  const type = o?.type === "User" || o?.type === "Organization" ? o.type : null;
  return {
    appId: id, slug, clientId, htmlUrl: safeAppHtmlUrl(typeof htmlUrl === "string" ? htmlUrl : undefined, slug), pem, webhookSecret,
    clientSecret: typeof clientSecret === "string" && CLIENT_SECRET.test(clientSecret) ? clientSecret : null,
    owner: login && type ? { login, type } : null,
  };
}

/** GitHub answers the exchange quickly; past this the owner gets a failure they can retry. */
export const CONVERSION_TIMEOUT_MS = 10_000;

export type ConversionResult = { ok: true; app: ManifestConversion } | { ok: false; reason: string };

/**
 * Trades the code GitHub put on the redirect for the new App's id, private key and webhook secret.
 * The call takes no credential because the code is the credential: it stays valid for an hour, so
 * it never goes into a reason, an error or a log line, and neither does anything GitHub sends back.
 */
export async function convertManifestCode(http: HttpClient, code: string): Promise<ConversionResult> {
  let res: HttpResponse;
  try {
    res = await http({
      method: "POST",
      url: `${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`,
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      timeoutMs: CONVERSION_TIMEOUT_MS,
      maxBytes: 64 * 1024,
    });
  } catch (e) {
    return { ok: false, reason: `GitHub could not be reached (${e instanceof OutboundError ? e.code : "NETWORK"})` };
  }
  if (res.status < 200 || res.status >= 300) return { ok: false, reason: `GitHub refused the code exchange (HTTP ${res.status})` };
  const app = parseManifestConversion(jsonOf(res));
  return app ? { ok: true, app } : { ok: false, reason: "GitHub answered the code exchange with fields Dockify cannot use" };
}

// ------------------------------------------------------------------ webhook signature

/**
 * Verifies X-Hub-Signature-256 over the RAW request bytes. sha256 only; the regex pins the length so
 * timingSafeEqual compares equal-length buffers.
 */
export function verifyGitHubSignature(secret: string, payload: Buffer, header: unknown): boolean {
  if (typeof header !== "string" || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  return timingSafeEqual(Buffer.from(header, "utf8"), Buffer.from(expected, "utf8"));
}

/** The JSON text of a delivery, for either hook content type. The MAC is always over the raw bytes. */
export function webhookPayloadText(contentType: string | undefined, raw: Buffer): string | null {
  if (contentType?.toLowerCase().includes("application/x-www-form-urlencoded")) {
    return new URLSearchParams(raw.toString("utf8")).get("payload");
  }
  return raw.toString("utf8");
}

// ------------------------------------------------------------------ signed, single-use state
//
// GitHub redirects the browser back cross-site, so the SameSite=Strict session cookie is not sent.
// The state is an HMAC over { nonce, purpose, session, exp } keyed by a key derived from the master
// key for that purpose (no separate SESSION_SECRET), and its nonce is remembered server side with
// its purpose: it can be used once, only before it expires, only by the round trip it was minted
// for, and only while the session that started the flow is still alive.
//
// Two round trips use it. "install" returns through git.setup after the App is installed on an
// account; "manifest" returns through git.app.callback after GitHub created the App. Each purpose
// has its own key, so an install state cannot open the manifest callback, nor the other way round.

const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 1_000;

export type StatePurpose = "install" | "manifest";

export interface PendingState {
  sessionId: string;
  purpose: StatePurpose;
  exp: number;
}

export interface StateStore {
  put(nonce: string, entry: PendingState): void;
  /** Removes the nonce and returns what it was minted for, or null when unknown, expired or already used. */
  take(nonce: string, now: number): PendingState | null;
}

export function memoryStateStore(): StateStore {
  const m = new Map<string, PendingState>();
  return {
    put(nonce, entry) {
      if (m.size >= MAX_PENDING) {
        const now = Date.now();
        for (const [k, v] of m) if (v.exp < now) m.delete(k);
        if (m.size >= MAX_PENDING) m.delete(m.keys().next().value as string);
      }
      m.set(nonce, { ...entry });
    },
    take(nonce, now) {
      const v = m.get(nonce);
      m.delete(nonce);
      return v && v.exp >= now ? v : null;
    },
  };
}

// The install label is the one the install state always used, so only the manifest key is new.
const STATE_LABEL: Record<StatePurpose, string> = {
  install: "dockify.github.install-state.v1",
  manifest: "dockify.github.manifest-state.v1",
};

function stateKey(ring: Keyring, purpose: StatePurpose): Buffer {
  const kek = ring.keys.get(ring.active);
  if (!kek) throw new Error("The active master key is missing from the keyring");
  return createHmac("sha256", kek).update(STATE_LABEL[purpose]).digest();
}

const sessionTag = (sessionId: string) => createHmac("sha256", "dockify.state.session").update(sessionId).digest("base64url").slice(0, 16);

export function signState(ring: Keyring, store: StateStore, purpose: StatePurpose, sessionId: string, now = Date.now()): string {
  const n = randomBytes(16).toString("base64url");
  const exp = now + STATE_TTL_MS;
  const body = Buffer.from(JSON.stringify({ n, p: purpose, s: sessionTag(sessionId), exp }), "utf8").toString("base64url");
  const mac = createHmac("sha256", stateKey(ring, purpose)).update(body).digest("base64url");
  store.put(n, { sessionId, purpose, exp });
  return `${body}.${mac}`;
}

/**
 * Returns the session id that started this purpose's round trip, or null. The MAC is checked
 * under that purpose's own key before the nonce is touched, so a state minted for the other round
 * trip does not even use up its nonce here. The nonce is consumed once the MAC holds.
 */
export function consumeState(ring: Keyring, store: StateStore, purpose: StatePurpose, token: string, now = Date.now()): string | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || token.length > 512) return null;
  const body = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1), "utf8");
  const expected = Buffer.from(createHmac("sha256", stateKey(ring, purpose)).update(body).digest("base64url"), "utf8");
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  let p: { n?: unknown; p?: unknown; s?: unknown; exp?: unknown } | null;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as typeof p;
  } catch {
    return null;
  }
  if (!p || typeof p !== "object" || typeof p.n !== "string" || p.p !== purpose || typeof p.exp !== "number" || p.exp < now) return null;
  const entry = store.take(p.n, now);
  if (!entry || entry.purpose !== purpose || sessionTag(entry.sessionId) !== p.s) return null;
  return entry.sessionId;
}

export const signInstallState = (ring: Keyring, store: StateStore, sessionId: string, now = Date.now()): string => signState(ring, store, "install", sessionId, now);
export const consumeInstallState = (ring: Keyring, store: StateStore, token: string, now = Date.now()): string | null => consumeState(ring, store, "install", token, now);
export const signManifestState = (ring: Keyring, store: StateStore, sessionId: string, now = Date.now()): string => signState(ring, store, "manifest", sessionId, now);
export const consumeManifestState = (ring: Keyring, store: StateStore, token: string, now = Date.now()): string | null => consumeState(ring, store, "manifest", token, now);

export function installUrl(slug: string, state: string): string {
  return `${GITHUB_WEB}/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`;
}

// ------------------------------------------------------------------ REST

export class GitHubApiError extends HttpError {
  readonly upstreamStatus: number;
  constructor(message: string, upstreamStatus: number) {
    super(502, message, "GITHUB_UPSTREAM");
    this.upstreamStatus = upstreamStatus;
  }
}

export type GitHubAuth = { jwt: string } | { token: string } | { none: true };

/** One JSON call. The error text never echoes the response body, which can quote a credential. */
export async function githubJson<T>(http: HttpClient, method: "GET" | "POST" | "DELETE" | "PATCH", path: string, auth: GitHubAuth, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if ("jwt" in auth) headers.Authorization = `Bearer ${auth.jwt}`;
  if ("token" in auth) headers.Authorization = `Bearer ${auth.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await http({ method, url: `${GITHUB_API}${path}`, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return undefined as T;
  if (res.status < 200 || res.status >= 300) throw new GitHubApiError(`GitHub ${method} ${path.split("?")[0]} returned ${res.status}`, res.status);
  const out = jsonOf<T>(res);
  if (out === null) throw new GitHubApiError(`GitHub ${method} ${path.split("?")[0]} sent a body that is not JSON`, res.status);
  return out;
}

/**
 * Talks to GitHub as the App and as its installations. Installation tokens are cached in memory
 * only, until five minutes before they expire; the PEM is opened per JWT and never kept.
 */
export class GitHubClient {
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly http: HttpClient;
  constructor(http: HttpClient) {
    this.http = http;
  }

  async jwt(db: Tx, ring: Keyring, app: GitHubAppRow): Promise<string> {
    const pem = await openSecret(db, ring, app.row, "primary");
    if (!pem) throw new HttpError(409, "The GitHub App has no private key stored", "GITHUB_APP_MISSING");
    return githubAppJwt(pem, app.config.appId);
  }

  async installationToken(db: Tx, ring: Keyring, app: GitHubAppRow, installationId: string): Promise<string> {
    const hit = this.tokens.get(installationId);
    if (hit && hit.expiresAt - 5 * 60_000 > Date.now()) return hit.token;
    const jwt = await this.jwt(db, ring, app);
    const t = await githubJson<{ token: string; expires_at: string }>(this.http, "POST", `/app/installations/${encodeURIComponent(installationId)}/access_tokens`, { jwt });
    this.tokens.set(installationId, { token: t.token, expiresAt: new Date(t.expires_at).getTime() });
    return t.token;
  }

  forget(installationId?: string): void {
    if (installationId) this.tokens.delete(installationId);
    else this.tokens.clear();
  }

  call<T>(method: "GET" | "POST" | "DELETE" | "PATCH", path: string, auth: GitHubAuth, body?: unknown): Promise<T> {
    return githubJson<T>(this.http, method, path, auth, body);
  }
}
