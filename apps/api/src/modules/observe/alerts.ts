/**
 * Alert rules, events and mutes. The worker evaluates and delivers; the api only edits rules and
 * mutes and lists what happened. Deleting or disabling a rule resolves its open events here, so the
 * bell never shows a firing alert nobody can act on.
 */
import { LIVE_ALERT_METRIC, type Db, type Prisma, type Tx, type WebhookProvider } from "@dockify/db";
import type { Actor } from "../../actor.ts";
import { audit } from "../../audit.ts";
import { HttpError } from "../../errors.ts";
import { webhookRefs } from "../integrations/webhooks.ts";
import { TO_API_METRIC, TO_DB_METRIC, validateRule, withBell, type DbMetric, type RuleChannel, type RuleInput, type ValidRule } from "./logic.ts";
import { notFound } from "./scope.ts";

const EVENTS_SHOWN = 100;
const RETAIN_MS = 90 * 86_400_000;

const APP_SELECT = { id: true, name: true, displayName: true, kind: true, environment: { select: { name: true, project: { select: { slug: true } } } } } as const;
type AppRow = Prisma.AppGetPayload<{ select: typeof APP_SELECT }>;

const alertApp = (a: AppRow | null) =>
  a ? { id: a.id, name: a.name, ...(a.displayName ? { displayName: a.displayName } : {}), kind: a.kind, projectSlug: a.environment.project.slug, environment: a.environment.name } : null;

const RULE_INCLUDE = { app: { select: APP_SELECT }, webhooks: { select: { webhookId: true } } } as const;
type RuleRow = Prisma.AlertRuleGetPayload<{ include: typeof RULE_INCLUDE }>;

/** Email and the bell: the database enum also holds discord and webhook, which nothing sends to. */
const sendChannels = (channels: readonly string[]): RuleChannel[] => channels.filter((c): c is RuleChannel => c === "email" || c === "bell");

function ruleView(r: RuleRow, firing: Set<string>) {
  return {
    id: r.id,
    metric: TO_API_METRIC[r.metric as DbMetric],
    app: alertApp(r.app),
    service: r.service,
    threshold: r.threshold,
    durationMin: r.durationMin,
    channels: sendChannels(r.channels),
    webhooks: r.webhooks.map((w) => w.webhookId),
    enabled: r.enabled,
    firing: firing.has(r.id),
    lastFiredAt: r.lastFiredAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** The webhooks a rule sends to after this write: those named, each of which must exist, or else the links it has. */
async function resolveWebhooks(db: Tx, v: ValidRule, current: Array<{ id: string }>): Promise<string[]> {
  if (v.webhooks) {
    if (!v.webhooks.length) return [];
    const found = await db.notificationWebhook.findMany({ where: { id: { in: v.webhooks } }, select: { id: true } });
    if (found.length !== v.webhooks.length) throw new HttpError(400, "One of the webhooks does not exist any more", "INVALID_REQUEST", { field: "webhooks" });
    return v.webhooks;
  }
  return current.map((w) => w.id);
}

async function webhookNames(db: Tx, ids: readonly string[]): Promise<string> {
  if (!ids.length) return "none";
  const rows = await db.notificationWebhook.findMany({ where: { id: { in: [...ids] } }, select: { name: true }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => r.name).join(", ");
}

async function firingRules(db: Db, ids?: string[]): Promise<Set<string>> {
  const rows = await db.alertEvent.findMany({
    where: { state: "firing", ruleId: ids ? { in: ids } : { not: null } },
    select: { ruleId: true },
    distinct: ["ruleId"],
  });
  return new Set(rows.map((r) => r.ruleId).filter((x): x is string => !!x));
}

/**
 * `projects`: a token limited to these projects sees only what concerns their apps, as every other
 * list it can read does. Server-wide rules and events belong to no project, so it sees none of them.
 */
export async function alertsPayload(db: Db, now = Date.now(), projects: string[] | null = null) {
  const inScope = projects ? { app: { environment: { projectId: { in: projects } } } } : {};
  const [rules, events, mutes, email, webhooks, firing] = await Promise.all([
    db.alertRule.findMany({ where: { metric: LIVE_ALERT_METRIC, ...inScope }, include: RULE_INCLUDE, orderBy: { createdAt: "asc" } }),
    db.alertEvent.findMany({
      where: { metric: LIVE_ALERT_METRIC, startedAt: { gte: new Date(now - RETAIN_MS) }, ...inScope },
      include: { app: { select: APP_SELECT } },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: EVENTS_SHOWN,
    }),
    db.alertMute.findMany({ where: { until: { gt: new Date(now) }, ...inScope }, orderBy: { until: "asc" } }),
    db.integration.count({ where: { kind: "email", secretId: { not: null }, status: { not: "disconnected" } } }),
    webhookRefs(db),
    firingRules(db),
  ]);
  const live = (p: string) => webhooks.some((w) => w.enabled && w.provider === p);
  return {
    rules: rules.map((r) => ruleView(r, firing)),
    events: events.map((e) => ({
      id: e.id,
      ruleId: e.ruleId,
      metric: TO_API_METRIC[e.metric as DbMetric],
      app: alertApp(e.app),
      service: e.service,
      status: e.state,
      startedAt: e.startedAt.toISOString(),
      resolvedAt: e.resolvedAt?.toISOString() ?? null,
      detail: e.detail,
      href: e.href,
      muted: e.muted,
    })),
    mutes: mutes.map((m) => ({ appId: m.appId, until: m.until.toISOString(), createdAt: m.createdAt.toISOString() })),
    // Webhooks and channels are the server's, not a project's.
    channels: projects ? { discord: false, webhook: false, email: false } : { discord: live("discord"), webhook: live("generic"), email: email > 0 },
    webhooks: projects ? [] : webhooks,
  };
}

const who = (actor: Actor | null, ip: string, ua: string | undefined) => ({
  actorType: actor?.kind === "token" ? ("token" as const) : ("user" as const),
  actorId: actor ? (actor.kind === "token" ? actor.tokenId : actor.userId) : null,
  actorName: actor?.name ?? null,
  ip,
  userAgent: ua ?? null,
});

export interface Caller {
  actor: Actor | null;
  ip: string;
  ua: string | undefined;
}

async function assertApp(db: Db, appId: string | null): Promise<void> {
  if (appId && !(await db.app.findUnique({ where: { id: appId }, select: { id: true } }))) throw notFound();
}

export async function createRule(db: Db, body: RuleInput, c: Caller) {
  const r = validateRule(body);
  await assertApp(db, r.appId);
  const webhooks = await resolveWebhooks(db, r, []);
  const channels = withBell(r.channels, webhooks);
  const row = await db.alertRule.create({
    data: {
      metric: TO_DB_METRIC[r.metric], appId: r.appId, service: r.service, threshold: r.threshold,
      durationMin: r.durationMin, channels, enabled: r.enabled,
      webhooks: { create: webhooks.map((webhookId) => ({ webhookId })) },
    },
    include: RULE_INCLUDE,
  });
  await audit(db, {
    category: "config", action: "alert.rule.create", verb: "created alert rule", targetType: "alert_rule", targetId: row.id, targetLabel: r.metric,
    changes: [
      { key: "metric", before: null, after: r.metric },
      { key: "threshold", before: null, after: r.threshold === null ? "default" : String(r.threshold) },
      { key: "channels", before: null, after: channels.join(", ") || "none" },
      { key: "webhooks", before: null, after: await webhookNames(db, webhooks) },
    ],
    ...who(c.actor, c.ip, c.ua),
  });
  return ruleView(row, new Set());
}

export async function patchRule(db: Db, id: string, patch: Partial<RuleInput>, c: Caller) {
  const cur = await db.alertRule.findFirst({ where: { id, metric: LIVE_ALERT_METRIC }, include: { webhooks: { select: { webhook: { select: { id: true, provider: true } } } } } });
  if (!cur) throw notFound();
  const merged = validateRule({
    metric: patch.metric ?? TO_API_METRIC[cur.metric as DbMetric],
    appId: patch.appId !== undefined ? patch.appId : cur.appId,
    service: patch.service !== undefined ? patch.service : cur.service,
    threshold: patch.threshold !== undefined ? patch.threshold : cur.threshold,
    durationMin: patch.durationMin ?? cur.durationMin,
    channels: patch.channels ?? sendChannels(cur.channels),
    webhooks: patch.webhooks,
    enabled: patch.enabled ?? cur.enabled,
  });
  await assertApp(db, merged.appId);
  const currentLinks = cur.webhooks.map((w) => w.webhook);
  const webhooks = await resolveWebhooks(db, merged, currentLinks);
  const channels = withBell(merged.channels, webhooks);
  const subjectChanged = merged.metric !== TO_API_METRIC[cur.metric as DbMetric] || merged.appId !== cur.appId || merged.service !== cur.service;
  const row = await db.$transaction(async (tx) => {
    // Open events describe the old rule; a disabled rule or a new subject starts clean.
    if (!merged.enabled || subjectChanged) {
      await tx.alertEvent.updateMany({ where: { ruleId: id, state: "firing" }, data: { state: "resolved", resolvedAt: new Date() } });
    }
    await tx.alertRuleWebhook.deleteMany({ where: { ruleId: id } });
    return tx.alertRule.update({
      where: { id },
      data: {
        metric: TO_DB_METRIC[merged.metric], appId: merged.appId, service: merged.service, threshold: merged.threshold,
        durationMin: merged.durationMin, channels, enabled: merged.enabled,
        webhooks: { create: webhooks.map((webhookId) => ({ webhookId })) },
      },
      include: RULE_INCLUDE,
    });
  });
  await audit(db, {
    category: "config", action: "alert.rule.update", verb: "changed alert rule", targetType: "alert_rule", targetId: id, targetLabel: merged.metric,
    changes: [
      { key: "enabled", before: String(cur.enabled), after: String(merged.enabled) },
      { key: "threshold", before: cur.threshold === null ? "default" : String(cur.threshold), after: merged.threshold === null ? "default" : String(merged.threshold) },
      { key: "durationMin", before: String(cur.durationMin), after: String(merged.durationMin) },
      { key: "channels", before: sendChannels(cur.channels).join(", ") || "none", after: channels.join(", ") || "none" },
      { key: "webhooks", before: await webhookNames(db, currentLinks.map((w) => w.id)), after: await webhookNames(db, webhooks) },
    ],
    ...who(c.actor, c.ip, c.ua),
  });
  return ruleView(row, await firingRules(db, [id]));
}

export async function deleteRule(db: Db, id: string, c: Caller): Promise<void> {
  const cur = await db.alertRule.findFirst({ where: { id, metric: LIVE_ALERT_METRIC }, select: { id: true, metric: true } });
  if (!cur) throw notFound();
  await db.$transaction([
    db.alertEvent.updateMany({ where: { ruleId: id, state: "firing" }, data: { state: "resolved", resolvedAt: new Date() } }),
    db.alertRule.delete({ where: { id } }),
  ]);
  await audit(db, { category: "config", action: "alert.rule.delete", verb: "deleted alert rule", targetType: "alert_rule", targetId: id, targetLabel: TO_API_METRIC[cur.metric as DbMetric], ...who(c.actor, c.ip, c.ua) });
}

export async function putMute(db: Db, appId: string, hours: 1 | 8 | 24, c: Caller) {
  const app = await db.app.findUnique({ where: { id: appId }, select: { id: true, name: true } });
  if (!app) throw notFound();
  const until = new Date(Date.now() + hours * 3_600_000);
  const row = await db.$transaction(async (tx) => {
    const m = await tx.alertMute.upsert({ where: { appId }, create: { appId, until }, update: { until } });
    // Already firing events go quiet too: no resolution message is sent for a muted event.
    await tx.alertEvent.updateMany({ where: { appId, state: "firing" }, data: { muted: true } });
    return m;
  });
  await audit(db, { category: "config", action: "alert.mute", verb: "muted alerts for", targetType: "app", targetId: appId, targetLabel: app.name, suffix: `for ${hours} h`, ...who(c.actor, c.ip, c.ua) });
  return { appId: row.appId, until: row.until.toISOString(), createdAt: row.createdAt.toISOString() };
}

export async function deleteMute(db: Db, appId: string, c: Caller): Promise<void> {
  const n = await db.alertMute.deleteMany({ where: { appId } });
  if (n.count > 0) {
    await audit(db, { category: "config", action: "alert.unmute", verb: "unmuted alerts for", targetType: "app", targetId: appId, ...who(c.actor, c.ip, c.ua) });
  }
}
