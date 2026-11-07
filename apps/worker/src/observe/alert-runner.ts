/**
 * The I/O around the alert engine: builds the World from the sampler's memory and the probes, loads
 * rules, open events and mutes, applies the decision in the database, and enqueues one alert_notify
 * job for email and one per webhook the rule sends to. Opening is race-safe: an event is created
 * only if no open event exists for the same rule and subject, checked under an advisory lock.
 */
import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { LIVE_ALERT_METRIC, type Db, type JobKind } from "@dockify/db";
import { enqueue } from "../queue.ts";
import { appsHere } from "../server/apps-here.ts";
import { requestOver } from "../server/http-over.ts";
import type { Dialer } from "../server/runtime.ts";
import { evaluate, subjectOfEvent, type AppView, type Channel, type Metric, type OpenEvent, type Rule, type Service, type Track, type World } from "./alerts.ts";
import type { Transition } from "./channels.ts";
import type { ObserveConfig } from "./config.ts";
import type { SamplerState } from "./sampler.ts";

/** The job kind that carries one alert delivery. */
export const ALERT_NOTIFY_KIND = "alert_notify" satisfies JobKind;


/** GET a control-plane health URL; up means any answer under 500 within the timeout. */
export function probe(url: string | null, timeoutMs = 3_000): Promise<boolean | null> {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      resolve(null);
      return;
    }
    const req = (u.protocol === "https:" ? httpsRequest : request)(u, { method: "GET", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** The proxy's ping, over the server's dialer; up means the same as probe() above. */
export function proxyPing(dial: Dialer, timeoutMs = 3_000): () => Promise<boolean> {
  return async () => {
    const socket = await dial({ proxy: 8080 }, { timeoutMs }).catch(() => null);
    if (!socket) return false;
    return new Promise((resolve) => {
      const req = requestOver(socket, { host: "dk-proxy", port: 8080, path: "/ping", method: "GET", timeoutMs }, (res) => {
        resolve((res.statusCode ?? 500) < 500);
        req.destroy();
      });
      req.on("error", () => resolve(false));
      req.end();
    });
  };
}

/** The messages of the issues the worker's heartbeat last wrote (Instance.workerIssues). */
export function workerIssueMessages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((i) => (i && typeof i === "object" && typeof (i as { message?: unknown }).message === "string" ? [(i as { message: string }).message] : []));
}

async function dbUp(db: Db): Promise<boolean> {
  try {
    await db.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export interface AlertRunner {
  tick(): Promise<{ opened: number; resolved: number }>;
}

export function createAlertRunner(
  db: Db,
  server: { serverId: string; proxyUp: () => Promise<boolean | null> },
  sampler: SamplerState,
  cfg: ObserveConfig,
): AlertRunner {
  const { serverId } = server;
  const tracks = new Map<string, Track>();

  async function world(now: number): Promise<World> {
    const apps = await db.app.findMany({
      where: appsHere(serverId),
      select: {
        id: true, name: true, displayName: true, desiredState: true, deployTarget: true, currentDeploymentId: true, status: true,
        deployments: { where: { status: { in: ["queued", "building", "deploying", "cancelling"] } }, select: { id: true }, take: 1 },
      },
    });
    const map = new Map<string, AppView>();
    for (const a of apps) {
      const latest = sampler.apps.get(a.id);
      const busy = a.status === "deploying" || a.deployments.length > 0;
      map.set(a.id, {
        id: a.id,
        // An alert's detail reads as the dashboard does: the display name when the app has one.
        name: a.displayName || a.name,
        expectRunning: a.desiredState === "running" && a.deployTarget === "server" && !!a.currentDeploymentId && !busy,
        container: !sampler.dockerSeen
          ? undefined
          : latest
            ? { state: latest.state, health: latest.health, memBytes: latest.memBytes, memLimitBytes: latest.memLimitBytes }
            : null,
        restarts: sampler.restarts.get(a.id) ?? [],
      });
    }
    const [api, proxy, database, inst] = await Promise.all([
      probe(cfg.probes.api), server.proxyUp(), dbUp(db),
      Promise.resolve()
        .then(() => db.instance.findUnique({ where: { id: 1 }, select: { workerIssues: true } }))
        .catch(() => null),
    ]);
    const issues = workerIssueMessages(inst?.workerIssues);
    const h = sampler.host;
    return {
      now,
      disk: h && h.diskUsedBytes !== null && h.diskTotalBytes ? { usedBytes: h.diskUsedBytes, totalBytes: h.diskTotalBytes } : null,
      // This code runs in the worker, so the worker is up; a dead worker is the api's to notice
      // (worker-watch.ts). One that reports an issue with its heartbeat (health.ts) is failing a part of its work.
      services: { api, worker: issues.length === 0, proxy, database },
      ...(issues.length ? { serviceDetail: { worker: issues.join(" ").slice(0, 500) } } : {}),
      apps: map,
      dockerSeen: sampler.dockerSeen,
    };
  }

  /** One job for email, and one per webhook, each retried on its own. */
  async function notify(eventId: string, to: { channels: Channel[]; webhooks: string[] }, transition: Transition): Promise<void> {
    const jobs: Array<{ payload: Record<string, string>; key: string }> = [];
    if (to.channels.includes("email")) jobs.push({ payload: { eventId, channel: "email", transition }, key: `alert:${eventId}:email:${transition}` });
    for (const webhookId of to.webhooks) {
      jobs.push({ payload: { eventId, channel: "webhook", webhookId, transition }, key: `alert:${eventId}:webhook:${webhookId}:${transition}` });
    }
    for (const j of jobs) {
      await enqueue(db, { kind: ALERT_NOTIFY_KIND, lane: "maintenance", payload: j.payload, dedupeKey: j.key, maxAttempts: 6 });
    }
  }

  async function tick(): Promise<{ opened: number; resolved: number }> {
    const now = Date.now();
    const [ruleRows, openRows, muteRows] = await Promise.all([
      db.alertRule.findMany({ where: { metric: LIVE_ALERT_METRIC }, include: { webhooks: { where: { webhook: { enabled: true } }, select: { webhookId: true } } } }),
      // An event of an app on another server is that server's runner's: to this one it would read as "app removed".
      db.alertEvent.findMany({ where: { state: "firing", metric: LIVE_ALERT_METRIC, OR: [{ appId: null }, { app: appsHere(serverId) }] }, select: { id: true, ruleId: true, metric: true, appId: true, service: true } }),
      db.alertMute.findMany({ where: { until: { gt: new Date(now) } }, select: { appId: true } }),
    ]);
    const rules: Rule[] = ruleRows.map((r) => ({
      id: r.id, metric: r.metric as Metric, appId: r.appId, service: r.service as Service | null,
      threshold: r.threshold, durationMin: r.durationMin, channels: r.channels, webhooks: r.webhooks.map((w) => w.webhookId), enabled: r.enabled,
    }));
    const open: OpenEvent[] = [];
    const orphans: string[] = [];
    for (const e of openRows) {
      if (!e.ruleId) orphans.push(e.id);
      else open.push({ id: e.id, ruleId: e.ruleId, subject: subjectOfEvent({ ...e, metric: e.metric as Metric }) });
    }
    const decision = evaluate(rules, await world(now), open, new Set(muteRows.map((m) => m.appId)), tracks);

    let opened = 0;
    for (const o of decision.open) {
      const id = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`alert:${o.rule.id}:${o.subject}`}))`;
        const dup = await tx.alertEvent.findFirst({
          where: { ruleId: o.rule.id, state: "firing", appId: o.appId, service: o.service },
          select: { id: true },
        });
        if (dup) return null;
        const ev = await tx.alertEvent.create({
          data: {
            ruleId: o.rule.id, metric: o.rule.metric, appId: o.appId, service: o.service,
            detail: o.detail, href: o.href, muted: o.muted,
          },
          select: { id: true },
        });
        await tx.alertRule.update({ where: { id: o.rule.id }, data: { lastFiredAt: new Date(now) } });
        return ev.id;
      });
      if (!id) continue;
      opened++;
      if (!o.muted) await notify(id, o.rule, "firing");
    }

    const resolveIds = [...decision.resolve.map((r) => r.eventId), ...orphans];
    let resolved = 0;
    for (const id of resolveIds) {
      const ev = await db.alertEvent.updateManyAndReturn({
        where: { id, state: "firing" },
        data: { state: "resolved", resolvedAt: new Date(now) },
        select: { id: true, muted: true, notifiedAt: true, ruleId: true },
      });
      const row = ev[0];
      if (!row) continue;
      resolved++;
      // A resolution goes only where a firing went, or is still waiting to go (an api outage holds
      // it back): the rule's email and its webhooks still enabled. The firing goes first (channels.ts).
      const firingWaits = !row.notifiedAt && !row.muted
        && !!(await db.job.findFirst({ where: { kind: ALERT_NOTIFY_KIND, dedupeKey: { startsWith: `alert:${row.id}:`, endsWith: ":firing" }, completedAt: null, failedAt: null }, select: { id: true } }));
      if (!row.muted && (row.notifiedAt || firingWaits) && row.ruleId) {
        const rule = await db.alertRule.findUnique({
          where: { id: row.ruleId },
          select: { channels: true, webhooks: { where: { webhook: { enabled: true } }, select: { webhookId: true } } },
        });
        if (rule) await notify(row.id, { channels: rule.channels, webhooks: rule.webhooks.map((w) => w.webhookId) }, "resolved");
      }
    }
    return { opened, resolved };
  }

  return { tick };
}
