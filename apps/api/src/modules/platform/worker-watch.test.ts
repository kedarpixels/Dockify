/**
 * A dead worker was invisible, because the "worker down" rule
 * was evaluated by the worker itself.
 */
import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { testRing } from "../../test-helpers.ts";
import { WORKER_SILENT_MS } from "./server.ts";
import { checkWorker, workerDownSince, type WebhookRow } from "./worker-watch.ts";

const NOW = Date.parse("2026-11-06T10:00:00Z");
const RULE = "0f0e0d0c-0000-4000-8000-000000000001";
const HOOK = "0f0e0d0c-0000-4000-8000-000000000002";

function fakeDb(o: { seenAt: Date | null; rules?: Array<Record<string, unknown>>; firing?: boolean }) {
  const events: Array<Record<string, unknown>> = [];
  const jobs: Array<Record<string, unknown>> = [];
  const locks: string[] = [];
  const ruleWhere: unknown[] = [];
  const tx = {
    $executeRaw: async (_s: TemplateStringsArray, key: string) => {
      locks.push(key);
      return 1;
    },
    alertEvent: {
      findFirst: async () => (o.firing || events.length ? { id: "open" } : null),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `ev-${events.length + 1}`, startedAt: new Date(NOW), ...data };
        events.push(row);
        return { id: row.id, startedAt: row.startedAt };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(events.find((e) => e.id === where.id)!, data),
    },
    alertRule: { update: async () => ({}) },
    job: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        jobs.push(data);
        return { id: "j1" };
      },
    },
  };
  const db = {
    ...tx,
    instance: { findUnique: async () => ({ workerSeenAt: o.seenAt, name: "Acme" }) },
    alertRule: {
      ...tx.alertRule,
      findMany: async (q: { where: unknown }) => {
        ruleWhere.push(q.where);
        return o.rules ?? [];
      },
    },
    notificationWebhook: {
      findMany: async () => [{ id: HOOK, provider: "discord", chatId: null, secretId: "s1", secondSecretId: null }],
    },
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  } as unknown as Db;
  return { db, events, jobs, locks, ruleWhere };
}

const rule = (over: Record<string, unknown> = {}) => ({ id: RULE, durationMin: 1, channels: ["bell"], webhooks: [{ webhookId: HOOK }], ...over });

describe("workerDownSince", () => {
  it("is null while the heartbeat is fresh, and the moment it went stale otherwise", () => {
    expect(workerDownSince(new Date(NOW - 30_000), NOW - 3_600_000, NOW)).toBeNull();
    const seen = NOW - WORKER_SILENT_MS - 60_000;
    expect(workerDownSince(new Date(seen), NOW - 3_600_000, NOW)).toBe(seen + WORKER_SILENT_MS);
    // A worker that never reported counts from when this api started.
    expect(workerDownSince(null, NOW - WORKER_SILENT_MS - 1, NOW)).toBe(NOW - 1);
    expect(workerDownSince(null, NOW, NOW)).toBeNull();
  });
});

describe("checkWorker", () => {
  const deps = (db: Db, sent: Array<{ hook: WebhookRow; title: string }>) => ({
    db, ring: testRing(), publicUrl: new URL("https://dockify.example.com"), startedAt: NOW - 3_600_000,
    sendWebhook: async (hook: WebhookRow, m: { title: string }) => {
      sent.push({ hook, title: m.title });
      return true;
    },
  });

  it("opens one event for a silent worker, sends it to the rule's webhooks from the api, and queues the email", async () => {
    const f = fakeDb({ seenAt: new Date(NOW - WORKER_SILENT_MS - 2 * 60_000), rules: [rule({ channels: ["email", "bell"] })] });
    const sent: Array<{ hook: WebhookRow; title: string }> = [];
    expect(await checkWorker(deps(f.db, sent), NOW)).toEqual(["ev-1"]);
    expect(f.events[0]).toMatchObject({ ruleId: RULE, metric: "service", service: "worker", appId: null, href: "/server" });
    expect(f.locks).toContain(`alert:${RULE}:service:worker`);
    expect(sent).toEqual([{ hook: expect.objectContaining({ id: HOOK }), title: "Firing: Control plane service down" }]);
    // Delivered, so the worker later sends the resolution where this went.
    expect(f.events[0]?.notifiedAt).toBeInstanceOf(Date);
    expect(f.jobs[0]).toMatchObject({ kind: "alert_notify", payload: { eventId: "ev-1", channel: "email", transition: "firing" } });
    // Rules for the worker, for any service, or naming none.
    expect(JSON.stringify(f.ruleWhere[0])).toContain('"service":"worker"');
    expect(JSON.stringify(f.ruleWhere[0])).toContain('"service":"any"');
  });

  it("does nothing while the heartbeat is fresh, before the rule's duration, or when the event is already open", async () => {
    const sent: Array<{ hook: WebhookRow; title: string }> = [];
    const fresh = fakeDb({ seenAt: new Date(NOW - 20_000), rules: [rule()] });
    expect(await checkWorker(deps(fresh.db, sent), NOW)).toEqual([]);
    const early = fakeDb({ seenAt: new Date(NOW - WORKER_SILENT_MS - 30_000), rules: [rule({ durationMin: 5 })] });
    expect(await checkWorker(deps(early.db, sent), NOW)).toEqual([]);
    const open = fakeDb({ seenAt: new Date(NOW - WORKER_SILENT_MS - 10 * 60_000), rules: [rule()], firing: true });
    expect(await checkWorker(deps(open.db, sent), NOW)).toEqual([]);
    expect(sent).toEqual([]);
  });
});
