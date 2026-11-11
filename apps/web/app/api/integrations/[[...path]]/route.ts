import { randomBytes } from "node:crypto";
import { guardWrite, json, readJsonBody, upstreamStatus } from "@/lib/http";
import { previewElevated } from "@/lib/preview-step-up";
import { requestOrigin } from "@/lib/request-origin";
import { crossSiteRefusal } from "@/lib/same-origin";
import { STEP_UP_MESSAGE, STEP_UP_REQUIRED } from "@/lib/step-up";
import { isRecord } from "@/lib/validation";
import { checkWebhookUrl, detectWebhook, isWebhookProvider, TELEGRAM_CHAT, TELEGRAM_TOKEN, WEBHOOK_PROVIDER_INFO, webhookSecretHint } from "@/lib/webhook-providers";
import type { Webhook, WebhookInput, WebhookLogo } from "@/lib/webhooks";
import {
  hintOf,
  integrationsApi,
  integrationsSource,
  isIntegrationId,
  NO_API,
  PREVIEW_VERCEL_CHECK,
  PREVIEW_ZONES,
  previewIntegrations,
  previewVercelProjects,
  previewWebhooks,
  type IntegrationsAnswer,
  type RegistryInput,
  type RegistryKind,
  type StorageInput,
  type StorageProvider,
  type VercelImportInput,
  type VercelTarget,
  previewEmail,
  type EmailInput,
} from "@/lib/pages/integrations";
import { emailFormErrors, type EmailTlsMode } from "@/components/activity-settings/integrations/email-rules";

// Every body is rebuilt from its checked fields, so a crafted call cannot smuggle extra keys to the API.
// Secrets pass through once and are never answered back, and nothing here may log.

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type Reply = { status: number; body: IntegrationsAnswer<unknown> };
type Body = Record<string, unknown>;

const MAX_BODY = 16_384;
/** A webhook may carry a logo upload: 128 KB of image is 174,764 base64 characters. */
const MAX_WEBHOOK_BODY = 192 * 1024;
const LOGO_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const SIGNING_SECRET = /^[\x21-\x7e]{16,256}$/;
const ACCESS_TOKEN = /^[\x21-\x7e]{8,256}$/;

const SECRET = /^\S{8,512}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/i;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,62}$/;
const REGION = /^[\w-]{1,40}$/;
const USERNAME = /^[\w.@-]{1,128}$/;
const HTTPS = /^https:\/\/\S+$/;
const ENDPOINT = /^https?:\/\/[^\s/]+\/?$/;
const GITHUB_LOGIN = /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/;

const TARGETS: VercelTarget[] = ["production", "preview", "development"];
const KINDS: RegistryKind[] = ["ghcr", "dockerhub", "custom"];
const PROVIDERS: StorageProvider[] = ["r2", "s3", "minio", "custom"];
const KIND_HOST: Record<Exclude<RegistryKind, "custom">, string> = { ghcr: "ghcr.io", dockerhub: "docker.io" };

const str = (v: unknown, max = 500): v is string => typeof v === "string" && v.length <= max;
const pick = <T extends string>(list: readonly T[], v: unknown): v is T => list.some((x) => x === v);

const reply = (status: number, data: unknown, error?: string, source = integrationsSource(), code?: string): Reply => ({ status, body: { source, data, error, ...(code ? { code } : {}) } });
const refuse = (status: number, error: string) => reply(status, null, error);
const ok = (data: unknown) => reply(200, data);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Through the API, else the preview answer, else no API. `elevated` writes need a fresh step-up, in the preview too. */
async function forward(method: Method, path: string, body: unknown, demo: () => Reply | Promise<Reply>, elevated = false): Promise<Reply> {
  return forwardTo(method, `/api/v1/integrations${path}`, body, demo, elevated);
}

/** forward() for an API path outside /integrations (the GitHub App's own routes). */
async function forwardTo(method: Method, apiPath: string, body: unknown, demo: () => Reply | Promise<Reply>, elevated = false): Promise<Reply> {
  const source = integrationsSource();
  if (source === "api") {
    const res = await integrationsApi<unknown>(method, apiPath, body);
    if (!res.ok) return reply(upstreamStatus(res.status), null, res.error, source, res.code);
    return ok(res.body ?? { ok: true });
  }
  if (source === "preview") return elevated && !previewElevated() ? reply(403, null, STEP_UP_MESSAGE, source, STEP_UP_REQUIRED) : demo();
  return refuse(503, NO_API);
}

// Body checks: each returns the clean value, or the first problem as a string.

function cleanSecret(v: unknown, what: string, required: boolean): string | undefined | Error {
  if (v === undefined || v === "") return required ? new Error(`Enter the ${what}`) : undefined;
  if (!str(v, 512) || !SECRET.test(v.trim())) return new Error(`The ${what} does not look right`);
  return v.trim();
}

function cleanRegistry(b: Body, create: boolean): RegistryInput | string {
  if (!pick(KINDS, b.kind)) return "Pick a registry";
  if (!str(b.username, 128) || !USERNAME.test(b.username.trim())) return "Enter the username";
  const token = cleanSecret(b.token, "token", create);
  if (token instanceof Error) return token.message;
  let host: string | undefined;
  if (b.kind === "custom") {
    if (!str(b.host, 253) || !HOST.test(b.host.trim())) return "Enter the registry host, like registry.example.com";
    host = b.host.trim().toLowerCase();
  }
  return { kind: b.kind, host, username: b.username.trim(), token };
}

function cleanStorage(b: Body, create: boolean): StorageInput | string {
  if (!str(b.name, 60) || !b.name.trim()) return "Give the destination a name";
  if (!pick(PROVIDERS, b.provider)) return "Pick a provider";
  if (!str(b.endpoint, 500) || !ENDPOINT.test(b.endpoint.trim())) return "Enter the endpoint as a URL, like https://s3.example.com";
  if (!str(b.bucket, 63) || !BUCKET.test(b.bucket.trim())) return "Enter a bucket name in lowercase";
  if (!str(b.region, 40) || !REGION.test(b.region.trim())) return "Enter the region, or auto";
  const accessKey = cleanSecret(b.accessKey, "access key", create);
  if (accessKey instanceof Error) return accessKey.message;
  const secretKey = cleanSecret(b.secretKey, "secret key", create);
  if (secretKey instanceof Error) return secretKey.message;
  if (b.isDefault !== undefined && typeof b.isDefault !== "boolean") return "Default must be on or off";
  return {
    name: b.name.trim(),
    provider: b.provider,
    endpoint: b.endpoint.trim().replace(/\/+$/, ""),
    bucket: b.bucket.trim(),
    region: b.region.trim(),
    accessKey,
    secretKey,
    isDefault: b.isDefault,
  };
}

function cleanLogo(v: unknown): WebhookLogo | string {
  if (!isRecord(v)) return "Pick how the webhook’s logo is set";
  if (v.choice === "auto") return { choice: "auto" };
  if (v.choice === "url") {
    if (!str(v.url, 2048) || !HTTPS.test(v.url.trim())) return "Use an https link to the logo";
    return { choice: "url", url: v.url.trim() };
  }
  if (v.choice === "upload") {
    if (!str(v.image, 174_764) || !LOGO_BASE64.test(v.image)) return "Use a logo of 128 KB or less";
    return { choice: "upload", image: v.image };
  }
  return "Pick how the webhook’s logo is set";
}

/** A webhook body rebuilt from the fields this route knows. The API checks every value again before it stores anything. */
function cleanWebhook(b: Body, create: boolean, draft = false): WebhookInput | string {
  const out: WebhookInput = {};
  if (b.name !== undefined) {
    if (!str(b.name, 60) || !b.name.trim() || /[\u0000-\u001f\u007f<>]/.test(b.name)) return "Give the webhook a name, without angle brackets";
    out.name = b.name.trim();
  }
  if (b.provider !== undefined) {
    if (!isWebhookProvider(b.provider)) return "Unknown webhook type";
    out.provider = b.provider;
  }
  if (b.url !== undefined && b.url !== "") {
    if (!str(b.url, 2048)) return "That URL is too long";
    const checked = checkWebhookUrl(b.url);
    if (!checked.ok) return checked.reason;
    out.url = b.url.trim();
  }
  if (b.botToken !== undefined && b.botToken !== "") {
    if (!str(b.botToken, 100) || !TELEGRAM_TOKEN.test(b.botToken.trim())) return "Paste the token BotFather gave you: digits, a colon, then letters";
    out.botToken = b.botToken.trim();
  }
  if (b.chatId !== undefined && b.chatId !== "") {
    if (!str(b.chatId, 40) || !TELEGRAM_CHAT.test(b.chatId.trim())) return "Use the chat’s numeric ID, or @name for a public channel";
    out.chatId = b.chatId.trim();
  }
  if (b.signingSecret !== undefined && b.signingSecret !== "") {
    const rotate = b.signingSecret === "rotate" && !create && !draft;
    if (!rotate && !(str(b.signingSecret, 256) && SIGNING_SECRET.test(b.signingSecret))) return "Use 16 to 256 printable characters for the signing secret";
    out.signingSecret = b.signingSecret as string;
  }
  if (b.accessToken !== undefined && b.accessToken !== "") {
    if (b.accessToken === null && !create && !draft) out.accessToken = null;
    else if (!str(b.accessToken, 256) || !ACCESS_TOKEN.test(b.accessToken.trim())) return "Paste the access token as ntfy shows it";
    else out.accessToken = b.accessToken.trim();
  }
  if (!draft) {
    for (const k of ["enabled", "updates"] as const) {
      if (b[k] === undefined) continue;
      if (typeof b[k] !== "boolean") return `${k === "enabled" ? "On" : "Update notices"} must be on or off`;
      out[k] = b[k];
    }
    if (b.logo !== undefined) {
      const logo = cleanLogo(b.logo);
      if (typeof logo === "string") return logo;
      out.logo = logo;
    }
  }
  if ((create || draft) && !out.url && !out.botToken) return "Paste the webhook URL";
  return out;
}

const previewSecret = () => `dkwh_${randomBytes(32).toString("base64url")}`;

/** The webhook the preview answers for a create or an edit, built from hints only. */
function previewWebhook(input: WebhookInput, now: Date, base?: Webhook): { webhook: Webhook; signingSecret: string | null } | string {
  const provider = input.provider ?? (input.url ? detectWebhook(input.url)?.provider : undefined) ?? (input.botToken ? "telegram" : base?.provider);
  if (!provider) return "Paste the webhook URL";
  const telegram = provider === "telegram";
  const url = input.url ?? null;
  const host = telegram ? "api.telegram.org" : url ? new URL(url).hostname : (base?.host ?? "");
  const generic = provider === "generic";
  const made = generic && (input.signingSecret === "rotate" || (!input.signingSecret && !base?.signingSecretHint)) ? previewSecret() : null;
  const secret = made ?? (generic && input.signingSecret && input.signingSecret !== "rotate" ? input.signingSecret : null);
  const logo = generic ? input.logo : undefined;
  const webhook: Webhook = {
    id: base?.id ?? `wh_${now.getTime().toString(36)}`,
    name: input.name ?? base?.name ?? WEBHOOK_PROVIDER_INFO[provider].label,
    provider,
    enabled: input.enabled ?? base?.enabled ?? true,
    updates: input.updates ?? base?.updates ?? true,
    host,
    hint: url ? webhookSecretHint(provider, url) : input.botToken ? hintOf(input.botToken) : (base?.hint ?? ""),
    chatId: telegram ? (input.chatId ?? base?.chatId ?? null) : null,
    signingSecretHint: generic ? (secret ? hintOf(secret) : (base?.signingSecretHint ?? null)) : null,
    accessTokenHint: provider === "ntfy" ? (input.accessToken ? hintOf(input.accessToken) : input.accessToken === null ? null : (base?.accessTokenHint ?? null)) : null,
    status: base?.status ?? "never",
    error: url || input.botToken ? null : (base?.error ?? null),
    lastSentAt: base?.lastSentAt ?? null,
    lastFailedAt: base?.lastFailedAt ?? null,
    rules: base?.rules ?? 0,
    // The preview stores no image: a logo shows in the form it was picked in, the row keeps the glyph.
    icon: logo && logo.choice !== "auto"
      ? { choice: "upload", image: null, logoUrl: logo.choice === "url" ? logo.url : null, favicon: null }
      : { choice: "auto", image: null, logoUrl: null, favicon: null },
    createdAt: base?.createdAt ?? now.toISOString(),
  };
  return { webhook, signingSecret: made };
}

async function handleWebhooks(method: Method, id: string | undefined, leaf: string | undefined, body: Body, now: Date): Promise<Reply> {
  const list = () => previewWebhooks(now);
  if (id === undefined && method === "GET") return forward("GET", "/webhooks", undefined, () => ok(list()));
  if (id === undefined && method === "POST") {
    const input = cleanWebhook(body, true);
    if (typeof input === "string") return refuse(400, input);
    return forward("POST", "/webhooks", input, async () => {
      await wait(600);
      const made = previewWebhook(input, now);
      return typeof made === "string" ? refuse(400, made) : ok(made);
    }, true);
  }
  if (id === "test" && leaf === undefined && method === "POST") {
    if (body.id !== undefined) {
      if (!isIntegrationId(body.id)) return refuse(404, "Unknown webhook");
      const saved = body.id;
      return forward("POST", "/webhooks/test", { id: saved }, async () => {
        await wait(700);
        const w = list().find((x) => x.id === saved);
        if (w?.status === "failing") return refuse(502, w.error ?? "The webhook refused the test");
        return ok({ provider: w?.provider ?? "generic", status: 200, latencyMs: 184 });
      });
    }
    const draft = cleanWebhook(body, false, true);
    if (typeof draft === "string") return refuse(400, draft);
    // Only what reaches the endpoint: a test sends nothing about the name, the switches or a logo.
    const target: WebhookInput = { provider: draft.provider, url: draft.url, botToken: draft.botToken, chatId: draft.chatId, signingSecret: draft.signingSecret, accessToken: draft.accessToken };
    return forward("POST", "/webhooks/test", target, async () => {
      await wait(700);
      const made = previewWebhook(target, now);
      return typeof made === "string" ? refuse(400, made) : ok({ provider: made.webhook.provider, status: 200, latencyMs: 212 });
    });
  }
  if (id === undefined || !isIntegrationId(id) || leaf !== undefined) return refuse(404, "Not found");
  const path = `/webhooks/${encodeURIComponent(id)}`;
  if (method === "PATCH") {
    const input = cleanWebhook(body, false);
    if (typeof input === "string") return refuse(400, input);
    return forward("PATCH", path, input, async () => {
      await wait(500);
      const base = list().find((w) => w.id === id);
      const made = previewWebhook(input, now, base ?? previewBase(id, now));
      return typeof made === "string" ? refuse(400, made) : ok(made);
    }, true);
  }
  if (method === "DELETE") return forward("DELETE", path, undefined, () => ok({ ok: true }), true);
  return refuse(404, "Not found");
}

/** A webhook the preview added in this session: the page holds it, the route only needs its id. */
const previewBase = (id: string, now: Date): Webhook => ({
  id, name: "Webhook", provider: "generic", enabled: true, updates: true, host: "", hint: "", chatId: null, signingSecretHint: null, accessTokenHint: null,
  status: "never", error: null, lastSentAt: null, lastFailedAt: null, rules: 0, icon: { choice: "auto", image: null, logoUrl: null, favicon: null }, createdAt: now.toISOString(),
});

async function handleGithub(method: Method, id: string | undefined, leaf: string | undefined, body: Body, origin: string | null): Promise<Reply> {
  if (id !== "app") return refuse(404, "Not found");
  if (leaf === "manifest" && method === "POST") {
    let organization: string | undefined;
    if (body.organization !== undefined && body.organization !== "") {
      if (!str(body.organization, 39) || !GITHUB_LOGIN.test(body.organization.trim())) return refuse(400, "Use the organization’s GitHub login: letters, numbers and single hyphens");
      organization = body.organization.trim();
    }
    return forwardTo("POST", "/api/v1/git/app/manifest", organization ? { organization } : {}, async () => {
      await wait(500);
      // The design preview never leaves for GitHub: the card says so instead of posting.
      return ok({ postUrl: "", manifest: { name: "dockify-preview", url: origin ?? "" } });
    }, true);
  }
  if (leaf === undefined && method === "DELETE") return forwardTo("DELETE", "/api/v1/git/app", undefined, () => ok({ ok: true }), true);
  return refuse(404, "Not found");
}

/** The form's values, cleaned, or the first problem. The API has the last word on the password. */
function cleanEmail(b: Body): EmailInput | string {
  const text = (v: unknown, max: number) => (str(v, max) ? v : "");
  const values = {
    host: text(b.host, 253).trim().toLowerCase(),
    port: typeof b.port === "number" ? b.port : 0,
    tlsMode: (b.tlsMode === "implicit" ? "implicit" : b.tlsMode === "starttls" ? "starttls" : "") as EmailTlsMode,
    username: text(b.username, 254).trim(),
    password: text(b.password, 1024),
    fromName: text(b.fromName, 60).trim(),
    fromAddress: text(b.fromAddress, 254).trim().toLowerCase(),
    replyTo: text(b.replyTo, 254).trim().toLowerCase(),
  };
  // A blank password is the API's to judge: it knows what is stored.
  const stored = { host: values.host, username: values.username, hasPassword: true };
  const problem = Object.values(emailFormErrors(values, stored)).find(Boolean);
  if (problem) return problem;
  const { password, replyTo, ...rest } = values;
  return { ...rest, ...(password ? { password } : {}), replyTo: replyTo || null };
}

/** A refused host in the preview, for a browser pass over the form's field errors. */
const previewRefusal = (input: EmailInput): { status: number; error: string; code: string } | null => {
  if (input.host === "blocked.example.com") return { status: 502, code: "EMAIL_PORT", error: `Could not reach ${input.host} on port ${input.port}. Many VPS providers block outbound mail ports. Try the provider's alternate port, such as 2465 or 2587 for Resend, or ask your VPS provider to open it.` };
  if (input.password === "wrong-password") return { status: 400, code: "EMAIL_LOGIN", error: `${input.host} refused the login. Check the username and password fields.` };
  if (input.host === "badtls.example.com") return { status: 502, code: "EMAIL_TLS", error: `Could not make a secure connection to ${input.host} on port ${input.port}, so nothing was sent. Check that the TLS mode fits this port and that the server has a valid certificate.` };
  return null;
};

async function handleEmail(method: Method, leaf: string | undefined, body: Body, now: Date): Promise<Reply> {
  const base = previewEmail(now);
  if (leaf === undefined && method === "PUT") {
    const input = cleanEmail(body);
    if (typeof input === "string") return refuse(400, input);
    return forward("PUT", "/email", input, async () => {
      await wait(600);
      const bad = previewRefusal(input);
      if (bad) return reply(bad.status, null, bad.error, undefined, bad.code);
      const { password: _password, ...fields } = input;
      return ok({ ...base, ...fields, replyTo: fields.replyTo ?? null, hasPassword: true, connectedAt: now.toISOString() });
    }, true);
  }
  if (leaf === undefined && method === "DELETE") return forward("DELETE", "/email", undefined, () => ok({ ok: true }), true);
  if (leaf === "test" && method === "POST") {
    const draft = typeof body.host === "string" ? cleanEmail(body) : null;
    if (typeof draft === "string") return refuse(400, draft);
    return forward("POST", "/email/test", draft ?? {}, async () => {
      await wait(700);
      const bad = draft ? previewRefusal(draft) : null;
      if (bad) return reply(bad.status, null, bad.error, undefined, bad.code);
      return ok({ to: "sam@example.com" });
    }, true);
  }
  return refuse(404, "Not found");
}

async function handle(method: Method, path: string[], body: Body, origin: string | null): Promise<Reply> {
  const now = new Date();
  const fixture = () => previewIntegrations(now);
  const [area, id, leaf, ...rest] = path;
  if (rest.length) return refuse(404, "Not found");

  if (area === undefined && method === "GET") return forward("GET", "", undefined, () => ok(fixture()));

  if (area === "vercel") {
    if (id === undefined && method === "POST") {
      const token = cleanSecret(body.token, "token", true);
      if (token instanceof Error || token === undefined) return refuse(400, token instanceof Error ? token.message : "Enter the token");
      if (body.teamId !== undefined && body.teamId !== null && !isIntegrationId(body.teamId)) return refuse(400, "Unknown team");
      const check = body.check === true;
      const teamId = typeof body.teamId === "string" ? body.teamId : null;
      return forward("POST", "/vercel", check ? { token, check } : { token, teamId }, async () => {
        await wait(500);
        if (check) return ok(PREVIEW_VERCEL_CHECK);
        const team = teamId ? PREVIEW_VERCEL_CHECK.teams.find((t) => t.id === teamId) : null;
        if (team === undefined) return refuse(400, "Unknown team");
        return ok({ account: PREVIEW_VERCEL_CHECK.account, team, tokenHint: hintOf(token), connectedAt: now.toISOString(), error: null });
      }, true);
    }
    if (id === undefined && method === "DELETE") return forward("DELETE", "/vercel", undefined, () => ok({ ok: true }), true);
    if (id === "sync" && leaf === undefined && method === "POST") return forward("POST", "/vercel/sync", {}, () => ok({ ok: true }));
    if (id === "webhook" && leaf === undefined && method === "POST") {
      return forward("POST", "/vercel/webhook", {}, async () => {
        await wait(700);
        return ok({ state: "active", projects: 1, missingProjects: 0, registeredAt: now.toISOString(), reason: null });
      }, true);
    }
    if (id === "webhook" && leaf === undefined && method === "DELETE") return forward("DELETE", "/vercel/webhook", undefined, () => ok({ ok: true }), true);
    if (id === "projects" && leaf === undefined && method === "GET") return forward("GET", "/vercel/projects", undefined, () => ok(previewVercelProjects(now)));
    if (id === "import" && leaf === undefined && method === "POST") {
      const { vercelProjectId, project, environment, target } = body;
      if (!isIntegrationId(vercelProjectId)) return refuse(400, "Unknown Vercel project");
      if (!str(project, 63) || !SLUG.test(project) || !str(environment, 63) || !SLUG.test(environment)) return refuse(400, "Pick a Dockify project and environment");
      if (!pick(TARGETS, target)) return refuse(400, "Pick a Vercel environment");
      const input: VercelImportInput = { vercelProjectId, project, environment, target };
      return forward("POST", "/vercel/import", input, async () => {
        await wait(900);
        const p = previewVercelProjects(now).find((x) => x.id === vercelProjectId);
        if (!p) return refuse(404, "Unknown Vercel project");
        return ok({ variables: p.env.filter((e) => e.targets.includes(target)).length, domains: p.domains.length });
      }, true);
    }
  }

  if (area === "cloudflare") {
    if (id === undefined && method === "POST") {
      const token = cleanSecret(body.token, "token", true);
      if (token instanceof Error || token === undefined) return refuse(400, token instanceof Error ? token.message : "Enter the token");
      return forward("POST", "/cloudflare", { token }, async () => {
        await wait(500);
        const cf = fixture().cloudflare;
        return cf ? ok({ ...cf, tokenHint: hintOf(token), connectedAt: now.toISOString() }) : refuse(400, "The token cannot list zones");
      }, true);
    }
    if (id === undefined && method === "DELETE") return forward("DELETE", "/cloudflare", undefined, () => ok({ ok: true }), true);
    if (id === "zones" && leaf === undefined && method === "GET") return forward("GET", "/cloudflare/zones", undefined, () => ok(PREVIEW_ZONES));
    if (id === "zones" && leaf !== undefined && method === "PATCH") {
      if (!isIntegrationId(leaf)) return refuse(404, "Unknown zone");
      if (typeof body.managed !== "boolean") return refuse(400, "Managed must be on or off");
      const managed = body.managed;
      return forward("PATCH", `/cloudflare/zones/${encodeURIComponent(leaf)}`, { managed }, () => {
        const z = PREVIEW_ZONES.find((x) => x.id === leaf);
        return z ? ok({ ...z, managed }) : refuse(404, "Unknown zone");
      });
    }
  }

  if (area === "registries" && leaf === undefined) {
    if (id === undefined && method === "GET") return forward("GET", "/registries", undefined, () => ok(fixture().registries));
    if (id === undefined && method === "POST") {
      const input = cleanRegistry(body, true);
      if (typeof input === "string") return refuse(400, input);
      return forward("POST", "/registries", input, () => ok(previewRegistry(`reg_${now.getTime().toString(36)}`, input, now)), true);
    }
    if (id !== undefined && !isIntegrationId(id)) return refuse(404, "Unknown registry");
    if (id !== undefined && method === "PATCH") {
      const input = cleanRegistry(body, false);
      if (typeof input === "string") return refuse(400, input);
      const path = `/registries/${encodeURIComponent(id)}`;
      return forward("PATCH", path, input, () => ok(previewRegistry(id, input, now, fixture().registries.find((r) => r.id === id)?.tokenHint)), true);
    }
    if (id !== undefined && method === "DELETE") return forward("DELETE", `/registries/${encodeURIComponent(id)}`, undefined, () => ok({ ok: true }), true);
  }

  if (area === "storage") {
    if (id === undefined && method === "GET") return forward("GET", "/storage", undefined, () => ok(fixture().storage));
    if (id === undefined && method === "POST") {
      const input = cleanStorage(body, true);
      if (typeof input === "string") return refuse(400, input);
      return forward("POST", "/storage", input, () => ok(previewStorage(`dst_${now.getTime().toString(36)}`, input)), true);
    }
    if (id !== undefined && !isIntegrationId(id)) return refuse(404, "Unknown destination");
    const path = `/storage/${encodeURIComponent(id ?? "")}`;
    if (id !== undefined && leaf === "test" && method === "POST") {
      return forward("POST", `${path}/test`, undefined, async () => {
        await wait(800);
        return ok({ latencyMs: 84 });
      });
    }
    if (id !== undefined && leaf === undefined && method === "PATCH") {
      // A bare `{ isDefault: true }` only moves the default (the page flips its own copy); anything
      // else is a full edit.
      if (Object.keys(body).length === 1 && body.isDefault === true) {
        return forward("PATCH", path, { isDefault: true }, () => ok({ id, isDefault: true }), true);
      }
      const input = cleanStorage(body, false);
      if (typeof input === "string") return refuse(400, input);
      return forward("PATCH", path, input, () => ok(previewStorage(id, input, fixture().storage.find((s) => s.id === id))), true);
    }
    if (id !== undefined && leaf === undefined && method === "DELETE") return forward("DELETE", path, undefined, () => ok({ ok: true }), true);
  }

  if (area === "email" && leaf === undefined) return handleEmail(method, id, body, now);

  if (area === "webhooks") return handleWebhooks(method, id, leaf, body, now);

  if (area === "github") return handleGithub(method, id, leaf, body, origin);

  return refuse(404, "Not found");
}

function previewRegistry(id: string, input: RegistryInput, now: Date, oldHint?: string) {
  return {
    id,
    kind: input.kind,
    host: input.kind === "custom" ? (input.host ?? "") : KIND_HOST[input.kind],
    username: input.username,
    tokenHint: input.token ? hintOf(input.token) : (oldHint ?? ""),
    addedAt: now.toISOString(),
    error: null,
  };
}

function previewStorage(id: string, input: StorageInput, old?: { accessKeyHint: string; secretKeyHint: string; lastTestedAt: string | null }) {
  return {
    id,
    name: input.name,
    provider: input.provider,
    endpoint: input.endpoint,
    bucket: input.bucket,
    region: input.region,
    accessKeyHint: input.accessKey ? hintOf(input.accessKey) : (old?.accessKeyHint ?? ""),
    secretKeyHint: input.secretKey ? hintOf(input.secretKey) : (old?.secretKeyHint ?? ""),
    isDefault: input.isDefault ?? false,
    lastTestedAt: old?.lastTestedAt ?? null,
    error: null,
  };
}

async function serve(method: Method, request: Request, params: Promise<{ path?: string[] }>) {
  const send = ({ status, body }: Reply) => json(body, status);
  // Same origin always (lib/same-origin.ts); a write that carries a body must also be JSON.
  const bodyless = method === "GET" || method === "DELETE";
  if (bodyless) {
    const reason = crossSiteRefusal(request.headers);
    if (reason) return send(refuse(403, reason));
  } else {
    const hasBody = Number(request.headers.get("content-length") ?? 0) > 0 || request.headers.has("transfer-encoding");
    const refused = guardWrite(request, { json: hasBody });
    if (refused) return refused;
  }
  const { path = [] } = await params;
  if (path.some((p) => !/^[\w-]{1,64}$/.test(p))) return send(refuse(404, "Not found"));

  let body: Body = {};
  if (!bodyless) {
    const read = await readJsonBody(request, path[0] === "webhooks" ? MAX_WEBHOOK_BODY : MAX_BODY);
    if (!read.ok) return send(refuse(read.status, read.status === 413 ? "Request body is too large" : "Send a JSON body"));
    if (read.value !== undefined) {
      if (!isRecord(read.value)) return send(refuse(400, "Send a JSON object"));
      body = read.value;
    }
  }
  return send(await handle(method, path, body, requestOrigin(request)));
}

type Ctx = { params: Promise<{ path?: string[] }> };

export const GET = (request: Request, { params }: Ctx) => serve("GET", request, params);
export const POST = (request: Request, { params }: Ctx) => serve("POST", request, params);
export const PUT = (request: Request, { params }: Ctx) => serve("PUT", request, params);
export const PATCH = (request: Request, { params }: Ctx) => serve("PATCH", request, params);
export const DELETE = (request: Request, { params }: Ctx) => serve("DELETE", request, params);
