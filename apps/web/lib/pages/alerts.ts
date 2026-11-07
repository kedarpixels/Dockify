import "server-only";
import { connection } from "next/server";
import { buildPreviewOverview } from "@/lib/preview-fixture";
import {
  APP_METRICS, CHANNELS, DURATIONS, isOneOf, MAX_RULE_WEBHOOKS, SERVER_METRICS, SERVICES, THRESHOLD,
  type AlertApp, type AlertChannel, type AlertEvent, type AlertMetric, type AlertMute, type AlertRule, type AlertsPayload, type AlertsResult,
  type MuteHours, type RuleInput,
} from "./alerts-shared";
import { apiRequest } from "@/lib/api";
import { upstreamStatus, type RouteAnswer } from "@/lib/http";
import { webhookRefOf } from "@/lib/webhooks";
import { previewWebhooks } from "./integrations";
import { isPreviewMode } from "@/lib/preview-mode";

/*
 * Alerts loader. The routes are in packages/contracts/src/endpoints.ts (every call forwards the session cookie,
 * every answer is JSON, nothing is cached, every failure answers `{ error }` with a 4xx or 5xx).
 *
 * Evaluation (worker): a rule fires once its condition has held for `durationMin` minutes and
 * resolves once it has been false for one full sample. Crash loop reads `threshold` restarts
 * within `durationMin` minutes. Firing and resolving each notify the rule's channels once, with
 * a deep link to `href`. "bell" means the console's notification panel; "email" mails every
 * admin through the email integration, so it needs email set up in Settings, Integrations.
 */

export * from "./alerts-shared";

// -------------- Validation --------------

/** Ids are opaque, but always short and URL safe; anything else is refused before the API. */
export const isAlertId = (v: string) => /^[\w.-]{1,128}$/.test(v);

/**
 * Checks a full rule body (create) or a partial one (`partial`, edit). Returns the clean input or
 * the reason it was refused. Unknown keys are dropped, never forwarded.
 */
export function parseRule(body: Record<string, unknown>, partial: boolean): { ok: true; input: Partial<RuleInput> } | { ok: false; error: string } {
  const out: Partial<RuleInput> = {};
  const has = (k: keyof RuleInput) => k in body;

  if (has("metric") || !partial) {
    if (!isOneOf([...SERVER_METRICS, ...APP_METRICS], body.metric)) return { ok: false, error: "Unknown metric" };
    out.metric = body.metric;
  }
  if (has("appId") || !partial) {
    if (body.appId !== null && !(typeof body.appId === "string" && isAlertId(body.appId))) return { ok: false, error: "Invalid app" };
    out.appId = body.appId;
  }
  if (has("service") || !partial) {
    if (body.service !== null && body.service !== undefined && !isOneOf(SERVICES, body.service)) return { ok: false, error: "Unknown service" };
    out.service = body.service ?? null;
  }
  if (has("threshold") || !partial) {
    if (body.threshold !== null && body.threshold !== undefined && !(typeof body.threshold === "number" && Number.isFinite(body.threshold))) {
      return { ok: false, error: "Invalid threshold" };
    }
    out.threshold = body.threshold ?? null;
  }
  if (has("durationMin") || !partial) {
    if (!isOneOf(DURATIONS, body.durationMin)) return { ok: false, error: "Invalid duration" };
    out.durationMin = body.durationMin;
  }
  if (has("channels") || !partial) {
    const list = body.channels;
    if (!Array.isArray(list) || list.length > CHANNELS.length || !list.every((c) => isOneOf(CHANNELS, c))) return { ok: false, error: "Unknown channel" };
    out.channels = [...new Set(list)];
  }
  if (has("webhooks") || !partial) {
    const list = body.webhooks ?? [];
    if (!Array.isArray(list) || list.length > MAX_RULE_WEBHOOKS || !list.every((w) => typeof w === "string" && isAlertId(w))) return { ok: false, error: "Unknown webhook" };
    out.webhooks = [...new Set(list as string[])];
  }
  // A rule that sends nowhere outside is fine (the bell lists every event), but a create or a full
  // edit has to name at least one place.
  if (!partial && !out.channels?.length && !out.webhooks?.length) return { ok: false, error: "Pick at least one channel" };
  if (has("enabled") || !partial) {
    if (typeof body.enabled !== "boolean") return { ok: false, error: "Invalid enabled flag" };
    out.enabled = body.enabled;
  }

  // Cross-field rules, checked whenever the metric is known.
  if (out.metric) {
    const server = SERVER_METRICS.includes(out.metric);
    if (server && out.appId) return { ok: false, error: "Server rules do not take an app" };
    if (!server && !partial && !out.appId) return { ok: false, error: "Pick an app" };
    if (out.metric === "service" && !out.service) out.service = "any";
    if (out.metric !== "service") out.service = null;
    const range = THRESHOLD[out.metric];
    if (range) {
      const t = out.threshold;
      if (t === null || t === undefined || !Number.isInteger(t) || t < range.min || t > range.max) {
        return { ok: false, error: `Threshold must be a whole number from ${range.min} to ${range.max}` };
      }
    } else {
      out.threshold = null;
    }
  }
  return { ok: true, input: out };
}

// -------------- API --------------

type ApiAnswer<T> = { ok: true; body: T } | { ok: false; status: number; error: string; code?: string };

/** One call to the Dockify API (lib/api.ts) with the viewer's cookie, never cached, always bounded. */
async function api<T>(path: string, init?: { method?: "POST" | "PATCH" | "PUT" | "DELETE"; body?: unknown }): Promise<ApiAnswer<T>> {
  const r = await apiRequest<T>(path, { method: init?.method, body: init?.body });
  // A 204 has no body; that is still a success.
  return r.ok ? { ok: true, body: (r.data ?? {}) as T } : { ok: false, status: r.status, error: r.error, code: r.code };
}

export async function getAlerts(): Promise<AlertsResult> {
  await connection();
  const fetchedAt = new Date().toISOString();
  if (process.env.DOCKIFY_API_URL) {
    const res = await api<AlertsPayload>("/api/v1/alerts");
    if (!res.ok) return { source: "api", data: null, error: res.error, fetchedAt };
    const b = res.body;
    return {
      source: "api",
      data: {
        rules: (b.rules ?? []).map((r) => ({ ...r, channels: (r.channels ?? []).filter((c) => isOneOf(CHANNELS, c)), webhooks: r.webhooks ?? [] })),
        events: b.events ?? [],
        mutes: b.mutes ?? [],
        channels: { email: !!b.channels?.email },
        webhooks: b.webhooks ?? [],
      },
      fetchedAt,
    };
  }
  // Design preview only. Never set in a deployed build: production must always read the API.
  if (isPreviewMode()) return { source: "preview", data: buildPreviewAlerts(new Date()), fetchedAt };
  return { source: "none", data: null, fetchedAt };
}

/** Forwards a write, or answers it from the fixture in preview, or refuses with no source. */
async function write<T>(path: string, method: "POST" | "PATCH" | "PUT" | "DELETE", body: unknown, simulate: () => T | null): Promise<RouteAnswer<T>> {
  if (process.env.DOCKIFY_API_URL) {
    const r = await api<T>(path, { method, body });
    return r.ok ? { status: 200, body: r.body } : { status: upstreamStatus(r.status), body: { error: r.error, code: r.code } };
  }
  if (isPreviewMode()) {
    // A short wait so the pending state is visible in the design preview.
    await new Promise((done) => setTimeout(done, 700));
    const out = simulate();
    return out ? { status: 200, body: out } : { status: 404, body: { error: "Not found" } };
  }
  return { status: 503, body: { error: "No data source" } };
}

const previewApp = (id: string | null): AlertApp | null => {
  if (!id) return null;
  const r = buildPreviewOverview(new Date()).resources.find((x) => x.id === id);
  return r ? { id: r.id, name: r.name, ...(r.displayName ? { displayName: r.displayName } : {}), kind: r.kind, projectSlug: r.projectSlug, environment: r.environment } : null;
};

export function createRule(input: RuleInput): Promise<RouteAnswer<AlertRule>> {
  return write<AlertRule>("/api/v1/alerts/rules", "POST", input, () => {
    const app = previewApp(input.appId);
    if (input.appId && !app) return null;
    const now = new Date().toISOString();
    return {
      id: `alr_${Date.now().toString(36)}`, metric: input.metric, app, service: input.service, threshold: input.threshold, durationMin: input.durationMin,
      channels: input.channels, webhooks: input.webhooks, enabled: input.enabled, firing: false, lastFiredAt: null, createdAt: now,
    };
  });
}

/** In preview the client holds the rule; the route echoes the patch over a stand-in it merges. */
export function patchRule(id: string, patch: Partial<RuleInput>): Promise<RouteAnswer<Partial<AlertRule> & { id: string }>> {
  return write(`/api/v1/alerts/rules/${encodeURIComponent(id)}`, "PATCH", patch, () => {
    const { appId, ...rest } = patch;
    return { id, ...rest, ...(appId !== undefined ? { app: previewApp(appId) } : {}) };
  });
}

export function deleteRule(id: string): Promise<RouteAnswer<{ ok: true }>> {
  return write(`/api/v1/alerts/rules/${encodeURIComponent(id)}`, "DELETE", undefined, () => ({ ok: true as const }));
}

export function muteApp(appId: string, hours: MuteHours): Promise<RouteAnswer<AlertMute>> {
  return write(`/api/v1/alerts/mutes/${encodeURIComponent(appId)}`, "PUT", { hours }, () => {
    if (!previewApp(appId)) return null;
    const now = Date.now();
    return { appId, until: new Date(now + hours * 3_600_000).toISOString(), createdAt: new Date(now).toISOString() };
  });
}

export function unmuteApp(appId: string): Promise<RouteAnswer<{ ok: true }>> {
  return write(`/api/v1/alerts/mutes/${encodeURIComponent(appId)}`, "DELETE", undefined, () => ({ ok: true as const }));
}

// -------------- Preview fixture --------------

/**
 * Rules and events that agree with lib/preview-fixture.ts: brightlane / postgres is degraded (its
 * memory rule fires), inkwell / chat-bot is stopped after a failed deploy (its crash loop
 * resolved into a down alert that still fires, under an 8 hour mute). Everything else is quiet.
 */
function buildPreviewAlerts(at: Date): AlertsPayload {
  const now = Math.floor(at.getTime() / 60_000) * 60_000;
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  const resources = buildPreviewOverview(at).resources;
  const app = (project: string, name: string, env = "production"): AlertApp => {
    const r = resources.find((x) => x.projectSlug === project && x.name === name && x.environment === env)!;
    return { id: r.id, name: r.name, ...(r.displayName ? { displayName: r.displayName } : {}), kind: r.kind, projectSlug: r.projectSlug, environment: r.environment };
  };
  const dbPg = app("brightlane", "postgres");
  const chatBot = app("inkwell", "chat-bot");
  const horseaiWeb = app("horseai", "web");
  const inkApi = app("inkwell", "api");
  const fieldnoteApi = app("fieldnote", "api");

  // Ops alerts is the Discord webhook every rule used before; the Inkwell team hears about its own apps on Slack.
  const rule = (id: string, metric: AlertMetric, a: AlertApp | null, threshold: number | null, durationMin: number, channels: AlertChannel[], webhooks: string[], extra: Partial<AlertRule> = {}): AlertRule => ({
    id, metric, app: a, service: metric === "service" ? "any" : null, threshold, durationMin, channels, webhooks, enabled: true, firing: false, lastFiredAt: null, createdAt: ago(60 * 24 * 21), ...extra,
  });

  const rules: AlertRule[] = [
    rule("alr_disk", "disk", null, 85, 5, ["bell"], ["wh_ops", "wh_oncall"], { lastFiredAt: ago(60 * 52) }),
    rule("alr_cp", "service", null, null, 1, ["bell"], ["wh_ops"], { lastFiredAt: ago(60 * 75) }),
    rule("alr_pg_mem", "memory", dbPg, 85, 10, ["bell"], ["wh_ops"], { firing: true, lastFiredAt: ago(38) }),
    rule("alr_pg_down", "down", dbPg, null, 2, ["email", "bell"], ["wh_ops"], { lastFiredAt: ago(372) }),
    rule("alr_bot_down", "down", chatBot, null, 2, ["bell"], ["wh_ops", "wh_ink"], { firing: true, lastFiredAt: ago(543) }),
    rule("alr_bot_loop", "crashLoop", chatBot, 3, 10, [], ["wh_ops", "wh_ink"], { lastFiredAt: ago(553) }),
    rule("alr_lw_down", "down", horseaiWeb, null, 1, ["bell"], ["wh_ops"]),
    rule("alr_ink_loop", "crashLoop", inkApi, 3, 10, ["bell"], ["wh_ops"]),
    rule("alr_sw_mem", "memory", fieldnoteApi, 80, 15, ["bell"], [], { enabled: false }),
  ];

  const ev = (id: string, ruleId: string, startMin: number, endMin: number | null, detail: string, muted = false): AlertEvent => {
    const r = rules.find((x) => x.id === ruleId)!;
    return {
      id, ruleId, metric: r.metric, app: r.app, service: r.metric === "service" ? "worker" : null,
      status: endMin === null ? "firing" : "resolved", startedAt: ago(startMin), resolvedAt: endMin === null ? null : ago(endMin),
      detail, href: r.app ? `/apps/${r.app.id}` : "/server", muted,
    };
  };

  const events: AlertEvent[] = [
    ev("ale_9", "alr_pg_mem", 38, null, "91% of its 2 GB limit"),
    ev("ale_8", "alr_pg_down", 372, 369, "Health check failed for 3 minutes"),
    ev("ale_7", "alr_bot_down", 543, null, "Stopped after a failed deploy", true),
    ev("ale_6", "alr_bot_loop", 553, 545, "Restarted 6 times in 10 minutes"),
    ev("ale_4", "alr_disk", 60 * 52, 60 * 52 - 41, "Disk reached 87%, pruned to 61%"),
    ev("ale_3", "alr_cp", 60 * 75, 60 * 75 - 2, "Worker stopped answering its health check"),
  ];

  // The stopped bot was muted for 8 hours, 3 hours ago.
  const mutes: AlertMute[] = [{ appId: chatBot.id, until: new Date(now + 5 * 3_600_000).toISOString(), createdAt: ago(180) }];

  return { rules, events, mutes, channels: { email: true }, webhooks: previewWebhooks(at).map(webhookRefOf) };
}
