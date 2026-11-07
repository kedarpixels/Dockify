/**
 * Notification webhooks: the list in Settings, Integrations, Webhooks. Each webhook has a provider
 * (recognised from its URL, or chosen) that decides how @dockify/notify formats its messages.
 *
 * What is stored, and where:
 *   secretId        the endpoint, sealed (kind channel_url). For Telegram the bot's sendMessage URL,
 *                   whose path holds the bot token.
 *   secondSecretId  the generic webhook's signing secret, or an ntfy access token (channel_secret).
 *   host, chatId    plain: shown back as they are. Every answer carries only hints of the rest.
 *   icon_images     a generic webhook's logo (uploaded, or downloaded once from the owner's link)
 *                   or its site's favicon (the worker's icon_fetch job). Built-in providers draw
 *                   their own mark in the dashboard and store nothing.
 *
 * Every endpoint is checked twice before it is stored: the provider's own URL rule
 * (@dockify/contracts webhooks.ts) and net-guard's public address rule. Every send, the test here
 * and the worker's deliveries, goes through the net-guard client again, which checks the address
 * at connect time.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  checkLogo, checkWebhookUrl, detectWebhook, LOGO_MAX_BYTES, telegramEndpoint, telegramFromUrl, WEBHOOK_PROVIDER_INFO, webhookSecretHint,
  webhookUrlProblem, type integrations, type WebhookProviderId,
} from "@dockify/contracts";
import type { Keyring } from "@dockify/crypto";
import { enqueue, hintOf, readSecretValue, SHOWN_WEBHOOK_ICON, shownWebhookIcon, storeSecret, type Db, type Prisma, type Tx } from "@dockify/db";
import { getFollowing, OutboundError, outboundUrlProblem, type HttpClient } from "@dockify/net-guard";

type WebhookLogoBody = integrations.WebhookLogoBody;
import { deliver, newSigningSecret, testMessage, type DeliveryOutcome, type WebhookTarget } from "@dockify/notify";
import type { Ctx, Handlers } from "../../app.ts";
import { audit } from "../../audit.ts";
import { badField, HttpError, isUniqueViolation } from "../../errors.ts";
import { sendImage } from "../icons/index.ts";
import { WORKER_SILENT_MS } from "../platform/server.ts";
import { who, type IntegrationDeps } from "./deps.ts";
import { WEBHOOK_REF_SELECT, WEBHOOK_SELECT, webhookRef, webhookView } from "./webhook-view.ts";

/** A server keeps at most this many webhooks. */
export const MAX_WEBHOOKS = 50;
/** Who owns a draft's sealed URL for one Send test; the worker deletes such rows as it opens them. */
const DRAFT_OWNER = "webhook_test";
const TEST_WAIT = { waitMs: 30_000, pollMs: 500 };
const LOGO_TIMEOUT_MS = 8_000;

const notFound = () => new HttpError(404, "Webhook not found", "NOT_FOUND");
const label = (p: WebhookProviderId) => WEBHOOK_PROVIDER_INFO[p].label;

// ------------------------------------------------------------------ the endpoint

export interface Endpoint {
  provider: WebhookProviderId;
  /** Normalised: what is sealed and called. */
  url: string;
  host: string;
  chatId: string | null;
}

export interface EndpointInput {
  provider?: WebhookProviderId;
  url?: string;
  botToken?: string;
  chatId?: string;
}

/**
 * The endpoint a create, a patch or a draft test describes, checked: the provider (given, else
 * recognised from the URL), the URL by the provider's rule and net-guard's public address rule, and
 * for Telegram the bot token and the chat (from their fields, the pasted URL, or what is stored).
 */
export function resolveEndpoint(input: EndpointInput, current?: Endpoint): Endpoint {
  const recognised = input.url ? detectWebhook(input.url)?.provider : undefined;
  const provider = input.provider ?? recognised ?? (input.botToken ? "telegram" : undefined) ?? current?.provider;
  if (!provider) {
    const checked = input.url ? checkWebhookUrl(input.url) : null;
    throw badField(checked && !checked.ok ? checked.reason : "Paste the webhook URL", "url");
  }
  if (provider === "telegram") {
    const fromUrl = input.url ? telegramFromUrl(input.url) : null;
    if (input.url && !fromUrl) throw badField(webhookUrlProblem("telegram", input.url) ?? "Use a Telegram bot URL", "url");
    const stored = current?.provider === "telegram" ? telegramFromUrl(current.url) : null;
    const token = input.botToken ?? fromUrl?.token ?? stored?.token;
    if (!token) throw badField("Paste the bot token BotFather gave you", "botToken");
    const chatId = input.chatId ?? fromUrl?.chatId ?? (current?.provider === "telegram" ? current.chatId : null);
    if (!chatId) throw badField("Add the chat the bot posts to", "chatId");
    return { provider, url: telegramEndpoint(token), host: "api.telegram.org", chatId };
  }
  if (input.botToken !== undefined || input.chatId !== undefined) throw badField("Only a Telegram webhook takes a bot token and a chat", input.botToken !== undefined ? "botToken" : "chatId");
  const raw = (input.url ?? (current && current.provider !== "telegram" ? current.url : undefined))?.trim();
  if (!raw) throw badField("Paste the webhook URL", "url");
  const problem = webhookUrlProblem(provider, raw) ?? outboundUrlProblem(raw);
  if (problem) throw badField(problem, "url");
  const u = new URL(raw);
  return { provider, url: u.toString(), host: u.hostname, chatId: null };
}

// ------------------------------------------------------------------ the second secret

type SecondAction = { action: "keep" } | { action: "drop" } | { action: "set"; value: string; generated: string | null };

/** What happens to the second secret slot: the generic webhook's signing secret, or an ntfy token. */
export function secondFor(
  provider: WebhookProviderId,
  input: { signingSecret?: string; accessToken?: string | null },
  current?: { provider: WebhookProviderId; hasSecret: boolean; hostMoved?: boolean },
): SecondAction {
  if (provider !== "generic" && input.signingSecret !== undefined) throw badField("Only a generic webhook takes a signing secret", "signingSecret");
  if (provider !== "ntfy" && input.accessToken !== undefined) throw badField("Only an ntfy webhook takes an access token", "accessToken");
  if (provider === "generic") {
    if (input.signingSecret === "rotate" || (input.signingSecret === undefined && !(current?.provider === "generic" && current.hasSecret))) {
      const value = newSigningSecret();
      return { action: "set", value, generated: value };
    }
    return input.signingSecret === undefined ? { action: "keep" } : { action: "set", value: input.signingSecret, generated: null };
  }
  if (provider === "ntfy") {
    if (input.accessToken === null) return current?.hasSecret ? { action: "drop" } : { action: "keep" };
    if (input.accessToken !== undefined) return { action: "set", value: input.accessToken, generated: null };
    return current?.hasSecret && (current.provider !== "ntfy" || current.hostMoved) ? { action: "drop" } : { action: "keep" };
  }
  return current?.hasSecret ? { action: "drop" } : { action: "keep" };
}

// ------------------------------------------------------------------ logos

export interface StoredLogo {
  mime: string;
  data: Uint8Array<ArrayBuffer>;
  sha256: string;
  width: number;
  height: number;
  /** Where the bytes came from (after redirects), for a downloaded logo. */
  origin: string | null;
  /** The link the owner gave, for a downloaded logo. */
  link: string | null;
}

const imageOf = (bytes: Uint8Array, check: { mime: string; width: number; height: number }, origin: string | null, link: string | null): StoredLogo => ({
  mime: check.mime, data: new Uint8Array(bytes), sha256: createHash("sha256").update(bytes).digest("hex"), width: check.width, height: check.height, origin, link,
});

/**
 * A logo the owner gave, checked and ready to store: an upload, or the bytes behind a link,
 * downloaded once through net-guard (https, public addresses, at most three redirects each checked
 * the same way, 128 KB, eight seconds). An SVG is stored only as its rebuild.
 */
export async function resolveLogo(http: HttpClient, logo: Exclude<WebhookLogoBody, { choice: "auto" }>): Promise<StoredLogo> {
  if (logo.choice === "upload") {
    const bytes = Buffer.from(logo.image, "base64");
    if (bytes.toString("base64").replace(/=+$/, "") !== logo.image.replace(/=+$/, "")) throw badField("Send the image as base64", "logo");
    const check = checkLogo(bytes);
    if (!check.ok) throw badField(check.reason, "logo");
    return imageOf(check.bytes, check.image, null, null);
  }
  const problem = outboundUrlProblem(logo.url);
  if (problem) throw badField(`The logo link: ${problem}`, "logo");
  let got: Awaited<ReturnType<typeof getFollowing>>;
  try {
    got = await getFollowing(http, logo.url, {
      headers: { accept: "image/png,image/svg+xml,image/webp,image/gif,image/jpeg,image/x-icon;q=0.9,*/*;q=0.1" },
      timeoutMs: LOGO_TIMEOUT_MS,
      maxBytes: LOGO_MAX_BYTES,
      maxRedirects: 3,
      refused: "The logo link redirects somewhere Dockify does not follow",
    });
  } catch (e) {
    if (e instanceof OutboundError) {
      if (e.code === "TOO_LARGE") throw badField("Use a logo of 128 KB or less", "logo");
      if (e.code === "REDIRECT_REFUSED") throw badField(e.message, "logo");
      throw badField(`The logo link could not be fetched: ${e.message}`, "logo");
    }
    throw badField("The logo link could not be fetched", "logo");
  }
  if (got.res.status !== 200) throw badField(`The logo link answered ${got.res.status}`, "logo");
  const check = checkLogo(got.res.body);
  if (!check.ok) throw badField(check.reason, "logo");
  return imageOf(check.bytes, check.image, got.url.slice(0, 2048), logo.url.slice(0, 2048));
}

// ------------------------------------------------------------------ storage

const sealUrl = (tx: Tx, ring: Keyring, id: string, e: Endpoint) =>
  storeSecret(tx, ring, { kind: "channel_url", ownerType: "webhook", ownerId: id }, e.url, webhookSecretHint(e.provider, e.url) || null);
const sealSecond = (tx: Tx, ring: Keyring, id: string, value: string) =>
  storeSecret(tx, ring, { kind: "channel_secret", ownerType: "webhook", ownerId: id }, value, hintOf(value));

/** The name asked for, or the provider's name numbered past the ones taken. A name asked for is never renamed. */
async function uniqueName(db: Tx, wanted: string, explicit: boolean, exceptId?: string): Promise<string> {
  const rows = await db.notificationWebhook.findMany({ select: { id: true, name: true } });
  const taken = new Set(rows.filter((r) => r.id !== exceptId).map((r) => r.name.toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  if (explicit) throw new HttpError(409, "Another webhook already has this name", "NAME_TAKEN", { field: "name" });
  for (let n = 2; n <= MAX_WEBHOOKS + 1; n++) {
    const candidate = `${wanted} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  throw new HttpError(409, "Give the webhook a name", "NAME_TAKEN", { field: "name" });
}

const nameTaken = (e: unknown) => {
  if (isUniqueViolation(e)) throw new HttpError(409, "Another webhook already has this name", "NAME_TAKEN", { field: "name" });
  throw e;
};

async function load(db: Tx, id: string) {
  const row = await db.notificationWebhook.findUnique({ where: { id }, select: WEBHOOK_SELECT });
  if (!row) throw notFound();
  return webhookView(row);
}

/** A generic webhook's automatic icon: its site's favicon, fetched by the worker's icon_fetch job. */
async function queueFavicon(db: Db, id: string): Promise<void> {
  await enqueue(db, { kind: "icon_fetch", lane: "maintenance", payload: { webhookId: id }, dedupeKey: `icon_fetch:webhook:${id}`, maxAttempts: 1 }).catch(() => undefined);
}

/** The endpoint and secrets of a stored webhook, opened for one send; null when its URL is gone. */
export async function openTarget(db: Tx, ring: Keyring, row: { provider: WebhookProviderId; chatId: string | null; secretId: string | null; secondSecretId: string | null }): Promise<WebhookTarget | null> {
  const url = row.secretId ? await readSecretValue(db, ring, row.secretId) : null;
  if (!url) return null;
  const secret = row.secondSecretId ? await readSecretValue(db, ring, row.secondSecretId) : null;
  return { provider: row.provider, url, chatId: row.chatId, secret };
}

/** The delivery state the list shows: a success clears the error, a failure records why. */
async function record(db: Db, id: string, out: DeliveryOutcome): Promise<void> {
  const data: Prisma.NotificationWebhookUpdateInput = out.ok ? { error: null, lastSentAt: new Date() } : { error: out.reason.slice(0, 300), lastFailedAt: new Date() };
  await db.notificationWebhook.update({ where: { id }, data }).catch(() => undefined);
}

async function instanceOf(ctx: Ctx) {
  const inst = await ctx.db.instance.findUnique({ where: { id: 1 }, select: { name: true } });
  return { name: inst?.name ?? "Dockify", url: ctx.config.publicUrl.origin };
}

const failed = (out: Extract<DeliveryOutcome, { ok: false }>) => new HttpError(502, out.reason, "WEBHOOK_FAILED", { status: out.status });

// ------------------------------------------------------------------ handlers

type Meta = ReturnType<typeof who>;

interface CreateInput {
  name?: string;
  provider?: WebhookProviderId;
  url?: string;
  botToken?: string;
  chatId?: string;
  signingSecret?: string;
  accessToken?: string;
  enabled?: boolean;
  updates?: boolean;
  logo?: WebhookLogoBody;
}

interface PatchInput extends Omit<CreateInput, "accessToken"> {
  accessToken?: string | null;
}

export function webhookHandlers(deps: IntegrationDeps): Handlers {
  /**
   * Sends the test message to an endpoint; answers what it got, or a 502 that says why. It goes
   * through the worker (a webhook_send job, integrations/webhooks.ts there), because that is where
   * every real alert leaves from: a green test must prove the path alerts take, whose network and
   * firewall are not this process's. A draft has no row, so its URL is sealed for that one job, which
   * deletes it once opened. Nothing plain goes in a job's payload.
   */
  async function sendTest(ctx: Ctx, target: WebhookTarget, savedId: string | null) {
    const message = testMessage(randomUUID(), await instanceOf(ctx));
    if (deps.inlineWebhookTests) {
      const out = await deliver(deps.http, target, message);
      if (savedId) await record(ctx.db, savedId, out);
      if (!out.ok) throw failed(out);
      return { provider: target.provider, status: out.status, latencyMs: out.latencyMs };
    }
    const seen = await ctx.db.instance.findUnique({ where: { id: 1 }, select: { workerSeenAt: true } });
    if (!seen?.workerSeenAt || Date.now() - seen.workerSeenAt.getTime() > WORKER_SILENT_MS) {
      throw new HttpError(503, "The worker is not running, and it sends every alert. Nothing was sent.", "WORKER_DOWN");
    }
    const draftSecrets: string[] = [];
    const jobId = await ctx.db.$transaction(async (tx) => {
      let payload: Prisma.InputJsonValue;
      if (savedId) {
        payload = { webhookId: savedId, message, test: true } as unknown as Prisma.InputJsonValue;
      } else {
        const owner = { ownerType: DRAFT_OWNER, ownerId: randomUUID() };
        const urlSecretId = await storeSecret(tx, ctx.ring, { kind: "channel_url", ...owner }, target.url);
        const secretSecretId = target.secret ? await storeSecret(tx, ctx.ring, { kind: "channel_secret", ...owner }, target.secret) : null;
        draftSecrets.push(urlSecretId, ...(secretSecretId ? [secretSecretId] : []));
        payload = { draft: { provider: target.provider, chatId: target.chatId, urlSecretId, secretSecretId }, message, test: true } as unknown as Prisma.InputJsonValue;
      }
      return (await tx.job.create({ data: { kind: "webhook_send", lane: "maintenance", payload, maxAttempts: 1 }, select: { id: true } })).id;
    });
    const wait = deps.webhookTestWait ?? TEST_WAIT;
    const deadline = Date.now() + wait.waitMs;
    for (;;) {
      const j = await ctx.db.job.findUnique({ where: { id: jobId }, select: { completedAt: true, failedAt: true, lastError: true, payload: true } });
      if (j?.completedAt || j?.failedAt) {
        const r = (j.payload as { result?: { ok?: unknown; status?: unknown; latencyMs?: unknown } } | null)?.result;
        const status = typeof r?.status === "number" ? r.status : 0;
        if (j.completedAt && r?.ok === true) return { provider: target.provider, status, latencyMs: typeof r.latencyMs === "number" ? r.latencyMs : 0 };
        throw new HttpError(502, j.lastError ?? "The webhook could not be reached", "WEBHOOK_FAILED", { status });
      }
      if (!j || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, wait.pollMs));
    }
    // Busy with a long job. Nothing should arrive minutes later, unasked, so an unclaimed test is withdrawn.
    const withdrawn = await ctx.db.job.updateMany({ where: { id: jobId, lockedUntil: null, completedAt: null, failedAt: null }, data: { failedAt: new Date(), lastError: "Withdrawn: the worker was busy" } });
    if (withdrawn.count && draftSecrets.length) await ctx.db.secret.deleteMany({ where: { id: { in: draftSecrets } } });
    throw new HttpError(503, "The worker is busy with a long job, so the test was not sent. Try again in a minute.", "WORKER_BUSY");
  }

  async function create(ctx: Ctx, body: CreateInput, meta: Meta) {
    if ((await ctx.db.notificationWebhook.count()) >= MAX_WEBHOOKS) throw new HttpError(409, `A server keeps at most ${MAX_WEBHOOKS} webhooks`, "TOO_MANY");
    const endpoint = resolveEndpoint(body);
    const second = secondFor(endpoint.provider, body);
    if (body.logo && endpoint.provider !== "generic") throw badField(`A ${label(endpoint.provider)} webhook shows ${label(endpoint.provider)}'s own mark`, "logo");
    const logo = body.logo && body.logo.choice !== "auto" ? await resolveLogo(deps.http, body.logo) : null;
    const name = await uniqueName(ctx.db, body.name ?? label(endpoint.provider), body.name !== undefined);
    const id = randomUUID();
    await ctx.db.$transaction(async (tx) => {
      const secretId = await sealUrl(tx, ctx.ring, id, endpoint);
      const secondSecretId = second.action === "set" ? await sealSecond(tx, ctx.ring, id, second.value) : null;
      await tx.notificationWebhook.create({
        data: {
          id, name, provider: endpoint.provider, enabled: body.enabled ?? true, updates: body.updates ?? true, host: endpoint.host, chatId: endpoint.chatId,
          secretId, secondSecretId, iconChoice: logo ? "upload" : "auto", logoUrl: logo?.link ?? null,
        },
      });
      if (logo) await tx.iconImage.create({ data: { webhookId: id, source: "upload", mime: logo.mime, data: logo.data, sha256: logo.sha256, width: logo.width, height: logo.height, origin: logo.origin } });
      await audit(tx, {
        category: "config", action: "integration.webhook.create", verb: "added the webhook", targetType: "webhook", targetId: id, targetLabel: name,
        suffix: `(${label(endpoint.provider)}, ${endpoint.host})`, ...meta,
      });
    }).catch(nameTaken);
    if (endpoint.provider === "generic" && !logo) await queueFavicon(ctx.db, id);
    return { webhook: await load(ctx.db, id), signingSecret: second.action === "set" ? second.generated : null };
  }

  async function patch(ctx: Ctx, id: string, body: PatchInput, meta: Meta) {
    const row = await ctx.db.notificationWebhook.findUnique({
      where: { id },
      select: { id: true, name: true, provider: true, host: true, chatId: true, secretId: true, secondSecretId: true, iconChoice: true, logoUrl: true },
    });
    if (!row) throw notFound();
    const provider = body.provider ?? row.provider;
    const moves = body.provider !== undefined || body.url !== undefined || body.botToken !== undefined || body.chatId !== undefined;
    let endpoint: Endpoint | null = null;
    if (moves) {
      const url = row.secretId ? await readSecretValue(ctx.db, ctx.ring, row.secretId) : null;
      const current = url ? { provider: row.provider, url, host: row.host, chatId: row.chatId } : undefined;
      endpoint = resolveEndpoint({ provider, url: body.url, botToken: body.botToken, chatId: body.chatId }, current);
    }
    // The stored token never follows the webhook to another host: an ntfy host is whatever the URL says.
    const second = secondFor(provider, body, { provider: row.provider, hasSecret: !!row.secondSecretId, hostMoved: !!endpoint && endpoint.host !== row.host });
    if (body.logo && provider !== "generic") throw badField(`A ${label(provider)} webhook shows ${label(provider)}'s own mark`, "logo");
    const logo = body.logo && body.logo.choice !== "auto" ? await resolveLogo(deps.http, body.logo) : null;
    const name = body.name !== undefined ? await uniqueName(ctx.db, body.name, true, row.id) : row.name;
    const leavesGeneric = row.provider === "generic" && provider !== "generic";
    const hostMoved = !!endpoint && endpoint.host !== row.host;
    const autoIcon = provider === "generic" && (body.logo?.choice === "auto" || (!body.logo && row.iconChoice === "auto"));
    const refetch = autoIcon && (body.logo?.choice === "auto" || hostMoved || row.provider !== "generic");

    await ctx.db.$transaction(async (tx) => {
      const data: Prisma.NotificationWebhookUncheckedUpdateInput = { name };
      if (body.enabled !== undefined) data.enabled = body.enabled;
      if (body.updates !== undefined) data.updates = body.updates;
      if (endpoint) {
        data.provider = endpoint.provider;
        data.host = endpoint.host;
        data.chatId = endpoint.chatId;
        data.secretId = await sealUrl(tx, ctx.ring, row.id, endpoint);
        // A new endpoint starts clean: the last delivery's error was about the old one.
        data.error = null;
      }
      if (second.action === "set") data.secondSecretId = await sealSecond(tx, ctx.ring, row.id, second.value);
      if (second.action === "drop") data.secondSecretId = null;
      if (logo) {
        data.iconChoice = "upload";
        data.logoUrl = logo.link;
        const image = { mime: logo.mime, data: logo.data, sha256: logo.sha256, width: logo.width, height: logo.height, origin: logo.origin };
        await tx.iconImage.upsert({ where: { webhookId_source: { webhookId: row.id, source: "upload" } }, create: { webhookId: row.id, source: "upload", ...image }, update: image });
      } else if (body.logo?.choice === "auto" || leavesGeneric) {
        data.iconChoice = "auto";
        data.logoUrl = null;
        await tx.iconImage.deleteMany({ where: { webhookId: row.id, source: "upload" } });
      }
      if (leavesGeneric || hostMoved) {
        // The favicon belonged to the old site.
        await tx.iconImage.deleteMany({ where: { webhookId: row.id, source: "favicon" } });
        data.faviconCheckedAt = null;
        data.faviconError = null;
      }
      await tx.notificationWebhook.update({ where: { id: row.id }, data });
      const dropped = [endpoint ? row.secretId : null, second.action !== "keep" ? row.secondSecretId : null].filter((x): x is string => !!x);
      if (dropped.length) await tx.secret.deleteMany({ where: { id: { in: dropped } } });
      const changes = [
        body.name !== undefined && body.name !== row.name ? { key: "name", before: row.name, after: name } : null,
        endpoint && endpoint.provider !== row.provider ? { key: "provider", before: label(row.provider), after: label(endpoint.provider) } : null,
        endpoint ? { key: "endpoint", before: row.host, after: endpoint.host } : null,
        body.enabled !== undefined ? { key: "enabled", before: null, after: String(body.enabled) } : null,
        body.updates !== undefined ? { key: "updates", before: null, after: String(body.updates) } : null,
        second.action !== "keep" ? { key: provider === "generic" ? "signingSecret" : "accessToken", before: null, after: second.action === "drop" ? "removed" : "replaced" } : null,
        body.logo ? { key: "logo", before: null, after: body.logo.choice } : null,
      ].filter((c): c is { key: string; before: string | null; after: string } => c !== null);
      await audit(tx, {
        category: "config", action: "integration.webhook.update", verb: "changed the webhook", targetType: "webhook", targetId: row.id, targetLabel: name,
        changes, ...meta,
      });
    }).catch(nameTaken);
    if (refetch) await queueFavicon(ctx.db, row.id);
    return { webhook: await load(ctx.db, row.id), signingSecret: second.action === "set" ? second.generated : null };
  }

  async function remove(ctx: Ctx, id: string, meta: Meta): Promise<void> {
    const row = await ctx.db.notificationWebhook.findUnique({ where: { id }, select: { id: true, name: true, provider: true, secretId: true, secondSecretId: true } });
    if (!row) throw notFound();
    await ctx.db.$transaction(async (tx) => {
      // Its rule links and its icons go with it (cascade); its sealed values go here.
      await tx.notificationWebhook.delete({ where: { id: row.id } });
      const ids = [row.secretId, row.secondSecretId].filter((x): x is string => !!x);
      if (ids.length) await tx.secret.deleteMany({ where: { id: { in: ids } } });
      await audit(tx, {
        category: "config", action: "integration.webhook.delete", verb: "removed the webhook", targetType: "webhook", targetId: row.id, targetLabel: row.name,
        suffix: `(${label(row.provider)})`, ...meta,
      });
    });
  }

  return {
    "integrations.webhooks.list": async ({ ctx }) => {
      const rows = await ctx.db.notificationWebhook.findMany({ select: WEBHOOK_SELECT, orderBy: { createdAt: "asc" } });
      return rows.map(webhookView);
    },

    "integrations.webhooks.create": async ({ body, actor, req, ctx }) => create(ctx, body, who(actor, req)),

    "integrations.webhooks.patch": async ({ params, body, actor, req, ctx }) => patch(ctx, params.id, body, who(actor, req)),

    "integrations.webhooks.delete": async ({ params, actor, req, ctx }) => {
      await remove(ctx, params.id, who(actor, req));
      return undefined;
    },

    "integrations.webhooks.test": async ({ body, ctx }) => {
      if ("id" in body) {
        const row = await ctx.db.notificationWebhook.findUnique({ where: { id: body.id }, select: { id: true, provider: true, chatId: true, secretId: true, secondSecretId: true } });
        if (!row) throw notFound();
        const target = await openTarget(ctx.db, ctx.ring, row);
        if (!target) throw new HttpError(409, "This webhook has no URL stored. Edit it and paste the URL again", "NOT_CONNECTED");
        return sendTest(ctx, target, row.id);
      }
      const endpoint = resolveEndpoint(body);
      const second = secondFor(endpoint.provider, body);
      // A draft generic webhook is signed with the secret the form will save, when it has one.
      const secret = second.action === "set" && second.generated === null ? second.value : null;
      return sendTest(ctx, { provider: endpoint.provider, url: endpoint.url, chatId: endpoint.chatId, secret }, null);
    },

    "integrations.webhooks.icon": async ({ params, query, req, reply, ctx }) => {
      const row = await ctx.db.notificationWebhook.findUnique({ where: { id: params.id }, select: SHOWN_WEBHOOK_ICON });
      return sendImage(ctx, row ? shownWebhookIcon(row) : null, query.v, req, reply);
    },
  };
}

/** Every webhook as the alert rules and the integrations row name it, oldest first. */
export async function webhookRefs(db: Tx) {
  const rows = await db.notificationWebhook.findMany({ select: WEBHOOK_REF_SELECT, orderBy: { createdAt: "asc" } });
  return rows.map(webhookRef);
}
