/**
 * An outage alert must survive the outage: the worker delivers from what it opened earlier
 * when the api does not answer, or the job waits without spending attempts, and the resolved message
 * follows the firing one.
 */
import { describe, expect, it } from "vitest";
import type { Db, SecretVault } from "@dockify/db";
import type { HttpClient } from "@dockify/net-guard";
import { DeferJobError } from "../errors.ts";
import { deliverAlert } from "../observe/channels.ts";
import { createAlertRunner } from "../observe/alert-runner.ts";
import { newSamplerState } from "../observe/sampler.ts";
import { backoffMs } from "../queue.ts";
import { VaultError } from "../vault.ts";
import { waitForApi } from "../wiring.ts";
import { DRAFT_OWNER, openWebhook, parseWebhookSend, primeWebhookTargets, runWebhookSend, WebhookTargets } from "./webhooks.ts";

const HOOK = "0f0e0d0c-0000-4000-8000-0000000000aa";
const EVENT = "0f0e0d0c-0000-4000-8000-0000000000bb";
const URL_SECRET = "0f0e0d0c-0000-4000-8000-0000000000cc";
const URL_VALUE = "https://hooks.example.com/alert";
const down = () => new VaultError(503, "the api did not answer the secrets call: fetch failed", "VAULT_UNREACHABLE");

function world(over: { webhook?: Record<string, unknown> | null; jobs?: Array<Record<string, unknown>>; event?: Record<string, unknown> } = {}) {
  const webhook = over.webhook === undefined
    ? { provider: "generic", enabled: true, chatId: null, secretId: URL_SECRET, secondSecretId: null, secret: { updatedAt: new Date(1000) }, secondSecret: null }
    : over.webhook;
  const jobs = over.jobs ?? [];
  const deliveries: unknown[] = [];
  const db = {
    notificationWebhook: {
      findUnique: async () => webhook,
      update: async (a: { data: unknown }) => void deliveries.push(a.data),
    },
    secret: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id })),
      deleteMany: async () => ({ count: 1 }),
    },
    instance: { findUnique: async () => ({ name: "Acme" }) },
    alertEvent: {
      findUnique: async () => ({ id: EVENT, ruleId: "r", muted: false, metric: "service", service: "api", detail: "api down", href: "/server", startedAt: new Date(0), resolvedAt: new Date(1), app: null, ...over.event }),
      update: async () => ({}),
    },
    job: {
      findFirst: async ({ where }: { where: { dedupeKey: string } }) => jobs.find((j) => j.dedupeKey === where.dedupeKey) ?? null,
      update: async (a: { data: unknown }) => void jobs.push(a.data as Record<string, unknown>),
    },
  } as unknown as Db;
  return { db, jobs, deliveries };
}

const vaultOf = (open: () => Promise<Map<string, string | null>>): SecretVault => ({ open, seal: async () => { throw new Error("no"); }, escrow: async () => { throw new Error("no"); } } as unknown as SecretVault);
const okVault = vaultOf(async () => new Map([[URL_SECRET, URL_VALUE]]));
const downVault = vaultOf(async () => { throw down(); });

function httpClient(status = 200) {
  const sent: string[] = [];
  const http = (async (r: { url: string }) => { sent.push(r.url); return { status, headers: {}, body: Buffer.from("ok") }; }) as unknown as HttpClient;
  return { http, sent };
}

describe("a webhook during an api outage", () => {
  it("uses what this process last opened, only when the api does not answer", async () => {
    const { db } = world();
    const targets = new WebhookTargets();
    const opened = await openWebhook(db, okVault, HOOK, { targets });
    expect(opened?.url).toBe(URL_VALUE);
    expect((await openWebhook(db, downVault, HOOK, { targets }))?.url).toBe(URL_VALUE);
  });

  it("never uses it for a refusal: only an api that did not answer", async () => {
    const { db } = world();
    const targets = new WebhookTargets();
    await openWebhook(db, okVault, HOOK, { targets });
    const refused = vaultOf(async () => { throw new VaultError(403, "refused", "SECRET_KIND_REFUSED"); });
    await expect(openWebhook(db, refused, HOOK, { targets })).rejects.toThrow(/refused/);
  });

  it("never sends the old URL of a webhook edited since", async () => {
    const targets = new WebhookTargets();
    await openWebhook(world().db, okVault, HOOK, { targets });
    const edited = world({ webhook: { provider: "generic", enabled: true, chatId: null, secretId: URL_SECRET, secondSecretId: null, secret: { updatedAt: new Date(2000) }, secondSecret: null } });
    await expect(openWebhook(edited.db, downVault, HOOK, { targets })).rejects.toThrow(/did not answer/);
  });

  it("primes the webhooks that would announce an api outage, and only those", async () => {
    const { db } = world();
    const asked: unknown[] = [];
    (db as unknown as { alertRuleWebhook: unknown }).alertRuleWebhook = {
      findMany: async (a: { where: unknown }) => { asked.push(a.where); return [{ webhookId: HOOK }]; },
    };
    const targets = new WebhookTargets();
    expect(await primeWebhookTargets({ db, vault: okVault, targets })).toBe(1);
    expect(asked[0]).toMatchObject({ webhook: { enabled: true }, rule: { enabled: true, metric: "service" } });
    expect((await openWebhook(db, downVault, HOOK, { targets }))?.url).toBe(URL_VALUE);
  });
});

describe("waitForApi", () => {
  const job = { id: "j", kind: "alert_notify" as const, lane: "maintenance" as const, payload: {}, attempts: 1, maxAttempts: 6, createdAt: new Date() };
  const signal = new AbortController().signal;

  it("defers instead of failing while the api is down, past every retry a job has", async () => {
    await expect(waitForApi(async () => { throw down(); })(job, signal)).rejects.toBeInstanceOf(DeferJobError);
    // A later attempt defers the same: nothing counts down.
    await expect(waitForApi(async () => { throw down(); })({ ...job, attempts: 6 }, signal)).rejects.toBeInstanceOf(DeferJobError);
  });

  it("counts an api answering 500 as down, and a refusal or any other error as a real failure", async () => {
    await expect(waitForApi(async () => { throw new VaultError(502, "bad gateway", "VAULT_ERROR"); })(job, signal)).rejects.toBeInstanceOf(DeferJobError);
    await expect(waitForApi(async () => { throw new VaultError(403, "no", "SECRET_KIND_REFUSED"); })(job, signal)).rejects.toThrow("no");
    await expect(waitForApi(async () => { throw new VaultError(403, "no", "SECRET_KIND_REFUSED"); })(job, signal)).rejects.not.toBeInstanceOf(DeferJobError);
    await expect(waitForApi(async () => { throw new Error("hook answered 500"); })(job, signal)).rejects.not.toBeInstanceOf(DeferJobError);
  });

  it("gives up after days, so an alert cannot wait forever", async () => {
    const old = { ...job, createdAt: new Date(Date.now() - 4 * 86_400_000) };
    await expect(waitForApi(async () => { throw down(); })(old, signal)).rejects.not.toBeInstanceOf(DeferJobError);
    expect(backoffMs(1)).toBeGreaterThan(0);
  });
});

describe("the resolved message of an alert held back by an outage", () => {
  const payload = { eventId: EVENT, channel: "webhook", webhookId: HOOK, transition: "resolved" };

  it("waits while the firing message for the same webhook is still queued", async () => {
    const { db } = world({ jobs: [{ id: "f", dedupeKey: `alert:${EVENT}:webhook:${HOOK}:firing` }] });
    await expect(deliverAlert({ db, vault: okVault, publicUrl: null, http: httpClient().http }, payload)).rejects.toBeInstanceOf(DeferJobError);
  });

  it("goes once the firing message is out", async () => {
    const { db } = world();
    const h = httpClient();
    expect(await deliverAlert({ db, vault: okVault, publicUrl: null, http: h.http }, payload)).toBe("sent");
    expect(h.sent).toEqual([URL_VALUE]);
  });

  it("the alert pass queues a resolution when the firing still waits, though it was never notified", async () => {
    const queued: Array<{ dedupeKey: string }> = [];
    const db = {
      alertRule: {
        findMany: async () => [],
        findUnique: async () => ({ channels: [], webhooks: [{ webhookId: HOOK }] }),
      },
      alertEvent: {
        findMany: async () => [{ id: EVENT, ruleId: null, metric: "service", appId: null, service: "api" }],
        updateManyAndReturn: async () => [{ id: EVENT, muted: false, notifiedAt: null, ruleId: "r" }],
      },
      alertMute: { findMany: async () => [] },
      app: { findMany: async () => [] },
      instance: { findUnique: async () => null },
      job: {
        findFirst: async ({ where }: { where: { dedupeKey: unknown } }) => (typeof where.dedupeKey === "object" ? { id: "firing-job" } : null),
        create: async (a: { data: { dedupeKey: string } }) => { queued.push(a.data); return { id: "x" }; },
      },
      $queryRaw: async () => [1],
      $transaction: async (fn: (tx: unknown) => unknown) => fn({
        $executeRaw: async () => 0,
        job: { findFirst: async () => null, create: async (a: { data: { dedupeKey: string } }) => { queued.push(a.data); return { id: "x" }; } },
      }),
    } as unknown as Db;
    const runner = createAlertRunner(db, { serverId: "s1", proxyUp: async () => null }, newSamplerState(), { probes: { api: null, proxy: null } } as never);
    expect((await runner.tick()).resolved).toBe(1);
    expect(queued.map((q) => q.dedupeKey)).toEqual([`alert:${EVENT}:webhook:${HOOK}:resolved`]);
  });

  it("the alert pass stays quiet when no firing went or waits", async () => {
    const queued: unknown[] = [];
    const db = {
      alertRule: { findMany: async () => [], findUnique: async () => ({ channels: [], webhooks: [{ webhookId: HOOK }] }) },
      alertEvent: {
        findMany: async () => [{ id: EVENT, ruleId: null, metric: "service", appId: null, service: "api" }],
        updateManyAndReturn: async () => [{ id: EVENT, muted: false, notifiedAt: null, ruleId: "r" }],
      },
      alertMute: { findMany: async () => [] },
      app: { findMany: async () => [] },
      instance: { findUnique: async () => null },
      job: { findFirst: async () => null, create: async (a: unknown) => { queued.push(a); return { id: "x" }; } },
      $queryRaw: async () => [1],
    } as unknown as Db;
    const runner = createAlertRunner(db, { serverId: "s1", proxyUp: async () => null }, newSamplerState(), { probes: { api: null, proxy: null } } as never);
    await runner.tick();
    expect(queued).toEqual([]);
  });
});

describe("Send test through the worker", () => {
  const message = { id: "message-1", event: "test", severity: "info", title: "Test notification", text: "x", url: null, fields: [], at: new Date(0).toISOString(), instance: { name: "Acme", url: null } };

  it("reports what the endpoint answered on its own row", async () => {
    const { db, jobs, deliveries } = world();
    const raw = { webhookId: HOOK, message, test: true };
    expect(await runWebhookSend({ db, vault: okVault, http: httpClient().http }, raw, "job-1")).toBe("sent");
    expect(jobs[0]).toMatchObject({ payload: { result: { ok: true, status: 200 } } });
    expect(deliveries).toHaveLength(1);
  });

  it("tests a switched off webhook, which a real send skips", async () => {
    const off = { provider: "generic", enabled: false, chatId: null, secretId: URL_SECRET, secondSecretId: null, secret: { updatedAt: new Date(1) }, secondSecret: null };
    const h = httpClient();
    expect(await runWebhookSend({ db: world({ webhook: off }).db, vault: okVault, http: h.http }, { webhookId: HOOK, message, test: true }, "j")).toBe("sent");
    expect(h.sent).toHaveLength(1);
    expect(await runWebhookSend({ db: world({ webhook: off }).db, vault: okVault, http: h.http }, { webhookId: HOOK, message })).toBe("skipped");
  });

  it("a failed test says why, never retries, and leaves the answer for the api", async () => {
    const { db, jobs } = world();
    await expect(runWebhookSend({ db, vault: okVault, http: httpClient(503).http }, { webhookId: HOOK, message, test: true }, "j")).rejects.toThrow(/503/);
    expect(jobs[0]).toMatchObject({ payload: { result: { ok: false, status: 503 } } });
  });

  it("opens a draft's sealed URL once and deletes it", async () => {
    const { db } = world();
    const removed: unknown[] = [];
    (db as unknown as { secret: { deleteMany: unknown } }).secret.deleteMany = async (a: { where: unknown }) => { removed.push(a.where); return { count: 1 }; };
    const h = httpClient();
    const raw = { draft: { provider: "generic", chatId: null, urlSecretId: URL_SECRET, secretSecretId: null }, message, test: true };
    expect(await runWebhookSend({ db, vault: okVault, http: h.http }, raw, "j")).toBe("sent");
    expect(h.sent).toEqual([URL_VALUE]);
    expect(removed).toEqual([{ id: { in: [URL_SECRET] }, ownerType: DRAFT_OWNER }]);
  });

  it("refuses a malformed payload for good", () => {
    expect(() => parseWebhookSend({ message })).toThrow(/malformed/);
    expect(() => parseWebhookSend({ draft: { provider: "generic", urlSecretId: "x", secretSecretId: null }, message, test: true })).toThrow(/malformed/);
    expect(() => parseWebhookSend({ draft: { provider: "generic", urlSecretId: URL_SECRET, secretSecretId: null }, message })).toThrow(/malformed/);
  });
});
