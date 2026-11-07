/**
 * Sends one message to one webhook through the net-guard client: https only, public addresses
 * checked inside the socket's own DNS lookup, no redirect followed, a hard timeout and a capped
 * answer. Nothing here ever puts the URL, a token or a secret into an error: a failure names the
 * provider, the status and, for a known provider, the short reason it gave.
 *
 * The generic webhook is signed. Each request carries
 *
 *   X-Dockify-Event: <event>
 *   X-Dockify-Delivery: <message id, the same across retries>
 *   X-Dockify-Timestamp: <unix seconds>
 *   X-Dockify-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" keyed by the signing secret>
 *
 * A receiver recomputes the HMAC over the raw bytes, compares in constant time, and refuses a
 * timestamp more than five minutes away from its own clock (verifySignature does exactly that).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WEBHOOK_PROVIDER_INFO, type WebhookProviderId } from "@dockify/contracts";
import { jsonOf, OutboundError, type HttpClient, type HttpResponse } from "@dockify/net-guard";
import { jsonBodyFor, ntfyRequest } from "./format.ts";
import type { NotifyMessage } from "./message.ts";

/** What a stored webhook opens to, right before a send. */
export interface WebhookTarget {
  provider: WebhookProviderId;
  /** The endpoint (for Telegram, the bot's sendMessage URL, token included). */
  url: string;
  /** Telegram: the chat to post to. */
  chatId?: string | null;
  /** Generic: the signing secret. ntfy: an access token, when the topic needs one. */
  secret?: string | null;
}

export interface PreparedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export const SIGNATURE_TOLERANCE_S = 300;
export const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_ANSWER = 64 * 1024;

export function sign(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** What a receiver of the generic webhook runs. True only for a fresh timestamp and a matching MAC. */
export function verifySignature(secret: string, body: string, timestamp: string | undefined, signature: string | undefined, nowMs = Date.now()): boolean {
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !signature || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_S) return false;
  const expected = Buffer.from(sign(secret, Number(timestamp), body), "utf8");
  const got = Buffer.from(signature, "utf8");
  return expected.length === got.length && timingSafeEqual(expected, got);
}

/** A new signing secret: 32 random bytes, with a prefix secret scanners can recognise. */
export const newSigningSecret = (): string => `dkwh_${randomBytes(32).toString("base64url")}`;

/** The exact request one message makes to one webhook. Pure apart from the clock, so tests read it whole. */
export function prepare(target: WebhookTarget, m: NotifyMessage, nowMs = Date.now()): PreparedRequest {
  const base = { "User-Agent": "Dockify-Webhooks/1" };
  if (target.provider === "ntfy") {
    const r = ntfyRequest(m);
    return { url: target.url, headers: { ...base, ...r.headers, ...(target.secret ? { Authorization: `Bearer ${target.secret}` } : {}) }, body: r.body };
  }
  const body = JSON.stringify(jsonBodyFor(target.provider, m, target.chatId));
  const headers: Record<string, string> = { ...base, "Content-Type": "application/json" };
  if (target.provider === "generic") {
    const ts = Math.floor(nowMs / 1000);
    headers["X-Dockify-Event"] = m.event;
    headers["X-Dockify-Delivery"] = m.id;
    headers["X-Dockify-Timestamp"] = String(ts);
    if (target.secret) headers["X-Dockify-Signature"] = sign(target.secret, ts, body);
  }
  return { url: target.url, headers, body };
}

export type DeliveryOutcome =
  | { ok: true; status: number; latencyMs: number }
  | { ok: false; retry: boolean; status: number; reason: string; latencyMs: number };

/** 2xx is delivered; 408, 425, 429, 5xx and no answer retry; anything else (3xx included) will not change. */
export function classifyStatus(status: number): "ok" | "retry" | "permanent" {
  if (status >= 200 && status < 300) return "ok";
  if (status === 0 || status === 408 || status === 425 || status === 429 || status >= 500) return "retry";
  return "permanent";
}

/**
 * The short reason a known provider gave (Slack's "no_service", Discord's "Unknown Webhook",
 * Telegram's "Bad Request: chat not found"), letters and simple punctuation only. A generic
 * endpoint's answer is never echoed: it could repeat anything it was sent.
 */
export function providerReason(provider: WebhookProviderId, res: HttpResponse): string | null {
  if (provider === "generic") return null;
  const json = jsonOf<Record<string, unknown>>(res);
  let raw: unknown;
  if (json && typeof json === "object") raw = [json.description, json.message, json.error].find((v) => typeof v === "string");
  else {
    // A short plain answer (Slack's "invalid_token"); an HTML error page says nothing useful.
    const text = res.body.toString("utf8").trim();
    raw = text.length <= 200 && !text.includes("<") ? text : undefined;
  }
  if (typeof raw !== "string") return null;
  const clean = raw.replace(/[^\w .,:'-]/g, "").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 120) : null;
}

/** Sends one message. Never throws: every way it can end is an outcome. */
export async function deliver(http: HttpClient, target: WebhookTarget, m: NotifyMessage, opts: { timeoutMs?: number; now?: () => number } = {}): Promise<DeliveryOutcome> {
  const label = WEBHOOK_PROVIDER_INFO[target.provider].label;
  const now = opts.now ?? Date.now;
  const started = now();
  let req: PreparedRequest;
  try {
    req = prepare(target, m, started);
  } catch {
    return { ok: false, retry: false, status: 0, reason: `The ${label} message could not be built`, latencyMs: 0 };
  }
  let res: HttpResponse;
  try {
    res = await http({ method: "POST", url: req.url, headers: req.headers, body: req.body, timeoutMs: opts.timeoutMs ?? DELIVERY_TIMEOUT_MS, maxBytes: MAX_ANSWER });
  } catch (e) {
    const latencyMs = now() - started;
    if (e instanceof OutboundError) {
      // A refused address or URL will be refused again; too large an answer means it arrived.
      if (e.code === "URL_REFUSED" || e.code === "EBLOCKED") return { ok: false, retry: false, status: 0, reason: e.message, latencyMs };
      if (e.code === "TOO_LARGE") return { ok: false, retry: false, status: 0, reason: `${label} answered with more than 64 KB`, latencyMs };
      return { ok: false, retry: true, status: 0, reason: e.message, latencyMs };
    }
    return { ok: false, retry: true, status: 0, reason: `${label} could not be reached`, latencyMs };
  }
  const latencyMs = now() - started;
  const verdict = classifyStatus(res.status);
  if (verdict === "ok") return { ok: true, status: res.status, latencyMs };
  const why = providerReason(target.provider, res);
  return { ok: false, retry: verdict === "retry", status: res.status, reason: `${label} answered ${res.status}${why ? ` (${why})` : ""}`, latencyMs };
}
