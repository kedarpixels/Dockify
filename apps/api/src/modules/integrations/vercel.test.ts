import { createHmac } from "node:crypto";
import Fastify from "fastify";
import type { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { storeSecret, type Db } from "@dockify/db";
import type { HttpClient, HttpResponse, StreamClient, StreamResponse } from "@dockify/net-guard";
import type { Ctx } from "../../app.ts";
import { RateLimits } from "../../ratelimit.ts";
import { testConfig, testRing } from "../../test-helpers.ts";
import { externalOf, vercelSteps } from "../deployments/mapping.ts";
import { defaultDeps } from "./deps.ts";
import { integrationsPlugin } from "./index.ts";
import { VercelApi, VERCEL_WEBHOOK_MAX_BYTES, verifyVercelSignature, webhookState } from "./vercel.ts";
import {
  clearVercelLogCache, eventToLine, GONE_NOTICE, parseEvents, readBuildLog, retentionNote, runtimeToLine, setVercelLogClients, tailRuntime, TRUNCATED_NOTICE,
} from "./vercel-logs.ts";

const ring = testRing();
const HOOK = "vercel-signing-secret";
const TOKEN = "vercel-token-value-123456";
const res = (status: number, body: unknown = {}): HttpResponse => ({ status, headers: {}, body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) });

/** Just enough of Prisma for the webhook and log paths, in memory. */
async function fakeDb(opts: { linked?: boolean; hook?: boolean; env?: Array<{ key: string; value: string; secret: boolean }> } = {}) {
  const secrets = new Map<string, Record<string, unknown>>();
  const deliveries: Array<Record<string, unknown>> = [];
  const jobs: Array<Record<string, unknown>> = [];
  const row: Record<string, unknown> = { id: "i1", kind: "vercel", name: "default", status: "connected", config: { team: { id: "team_1" } }, secretId: null, secondSecretId: null };
  const envRows: Array<Record<string, unknown>> = [];
  const tx = {
    $executeRaw: async () => 0,
    job: {
      findFirst: async ({ where }: { where: { dedupeKey: string } }) => jobs.find((j) => j.dedupeKey === where.dedupeKey) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const j = { id: `j${jobs.length}`, ...data };
        jobs.push(j);
        return j;
      },
    },
  };
  const db = {
    ...tx,
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
    secret: {
      create: async ({ data }: { data: Record<string, unknown> }) => (secrets.set(String(data.id), data), data),
      findUnique: async ({ where }: { where: { id: string } }) => secrets.get(where.id) ?? null,
    },
    integration: { findUnique: async () => row },
    webhookDelivery: {
      // A receiver never inserts in a way that can raise a unique violation: Prisma logs those raw.
      create: async () => {
        throw new Error("the webhook path must insert with skipDuplicates");
      },
      createMany: async ({ data, skipDuplicates }: { data: Array<Record<string, unknown>>; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const row of data) {
          if (deliveries.some((d) => d.deliveryId === row.deliveryId)) {
            if (!skipDuplicates) throw Object.assign(new Error("dup"), { code: "P2002" });
            continue;
          }
          deliveries.push({ id: `d${deliveries.length}`, ...row });
          count++;
        }
        return { count };
      },
      findFirstOrThrow: async ({ where }: { where: { deliveryId: string } }) => deliveries.find((d) => d.deliveryId === where.deliveryId),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(deliveries.find((d) => d.id === where.id) ?? {}, data),
    },
    app: {
      findFirst: async ({ where }: { where: { vercelProjectId: string } }) => (opts.linked !== false && where.vercelProjectId === "prj_1" ? { environment: { projectId: "p1" } } : null),
      findMany: async () => [{ id: "a1", name: "web", environmentId: "e1", kind: "frontend" }],
    },
    environment: { findMany: async () => [{ id: "e1", name: "production" }] },
    envVar: { findMany: async () => envRows },
  };
  row.secretId = await storeSecret(db as never, ring, { kind: "integration_token", ownerType: "integration", ownerId: "i1" }, TOKEN, null);
  if (opts.hook !== false) row.secondSecretId = await storeSecret(db as never, ring, { kind: "vercel_webhook_secret", ownerType: "integration", ownerId: "i1" }, HOOK, null);
  for (const e of opts.env ?? []) {
    const id = await storeSecret(db as never, ring, { kind: "env_value", ownerType: "environment", ownerId: "e1" } as never, e.value, null);
    envRows.push({ id: e.key, scopeType: "environment", scopeId: "e1", key: e.key, isSecret: e.secret, secretId: id, target: "both", updatedAt: new Date(), updatedBy: null });
  }
  return { db: db as unknown as Db, deliveries, jobs };
}

let app: ReturnType<typeof Fastify> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  setVercelLogClients(null);
  clearVercelLogCache();
});

async function build(db: Db, http: HttpClient = async () => { throw new Error("no network in tests"); }) {
  const f = Fastify();
  app = f;
  f.setValidatorCompiler(({ schema }) => (data: unknown) => {
    const r = (schema as z.ZodType).safeParse(data);
    return r.success ? { value: r.data } : { error: r.error as unknown as Error };
  });
  f.decorateRequest("actor", null);
  f.decorateRequest("clientIp", "");
  const ctx: Ctx = { db, ring, config: testConfig(), web: { origin: "https://dockify.test", secure: true }, limits: new RateLimits() };
  await f.register(integrationsPlugin, { ctx, deps: defaultDeps({ http }) });
  return f;
}

const sig = (body: string | Buffer, secret = HOOK) => createHmac("sha1", secret).update(body).digest("hex");
const event = (over: Record<string, unknown> = {}) => JSON.stringify({ id: "evt_1", type: "deployment.succeeded", createdAt: Date.now(), payload: { project: { id: "prj_1" }, deployment: { id: "dpl_1" } }, ...over });
const post = (f: Awaited<ReturnType<typeof build>>, body: string, signature: string | null = sig(body)) =>
  f.inject({ method: "POST", url: "/api/v1/webhooks/vercel", payload: body, headers: { "content-type": "application/json", ...(signature === null ? {} : { "x-vercel-signature": signature }) } });

describe("verifyVercelSignature", () => {
  const body = Buffer.from('{"id":"e"}');
  it("accepts the hex HMAC-SHA1 of the raw bytes", () => expect(verifyVercelSignature(HOOK, body, sig(body))).toBe(true));
  it("refuses another secret, another body, sha256, junk, an array and absence", () => {
    expect(verifyVercelSignature("other", body, sig(body))).toBe(false);
    expect(verifyVercelSignature(HOOK, Buffer.from('{"id": "e"}'), sig(body))).toBe(false);
    expect(verifyVercelSignature(HOOK, body, createHmac("sha256", HOOK).update(body).digest("hex"))).toBe(false);
    expect(verifyVercelSignature(HOOK, body, "xyz")).toBe(false);
    expect(verifyVercelSignature(HOOK, body, [sig(body)])).toBe(false);
    expect(verifyVercelSignature(HOOK, body, undefined)).toBe(false);
  });
});

describe("Vercel webhook through the plugin", () => {
  it("queues one mirror pass for the named project, and nothing else", async () => {
    const { db, jobs, deliveries } = await fakeDb();
    const f = await build(db);
    const r = await post(f, event());
    expect(r.statusCode).toBe(202);
    expect(jobs).toEqual([expect.objectContaining({ kind: "vercel_mirror", lane: "maintenance", payload: { projectId: "prj_1" }, dedupeKey: "vercel_mirror:prj_1" })]);
    expect(deliveries[0]).toMatchObject({ provider: "vercel", deliveryId: "evt_1", statusCode: 202 });
  });

  it("refuses a bad or missing signature before writing anything", async () => {
    const { db, jobs, deliveries } = await fakeDb();
    const f = await build(db);
    const body = event();
    expect((await post(f, body, sig(body, "wrong"))).statusCode).toBe(401);
    expect((await post(f, body, null)).statusCode).toBe(401);
    expect(jobs).toHaveLength(0);
    expect(deliveries).toHaveLength(0);
  });

  it("checks the bytes sent, not the JSON they parse to", async () => {
    const { db, jobs } = await fakeDb();
    const f = await build(db);
    const body = event();
    expect((await post(f, body.replace('"evt_1"', '"evt_1" '), sig(body))).statusCode).toBe(401);
    expect(jobs).toHaveLength(0);
  });

  it("takes a replay once", async () => {
    const { db, jobs, deliveries } = await fakeDb();
    const f = await build(db);
    const body = event();
    expect((await post(f, body)).statusCode).toBe(202);
    jobs.length = 0;
    expect((await post(f, body)).statusCode).toBe(202);
    expect(jobs).toHaveLength(0);
    expect(deliveries).toHaveLength(1);
  });

  it("ignores a signed body older than Vercel's retry window", async () => {
    const { db, jobs } = await fakeDb();
    const f = await build(db);
    expect((await post(f, event({ createdAt: Date.now() - 26 * 3600_000 }))).statusCode).toBe(202);
    expect(jobs).toHaveLength(0);
  });

  it("answers 202 and queues nothing for a project no app is linked to, or another event", async () => {
    const { db, jobs } = await fakeDb({ linked: false });
    const f = await build(db);
    expect((await post(f, event())).statusCode).toBe(202);
    expect((await post(f, event({ id: "evt_2", type: "project.created" }))).statusCode).toBe(202);
    expect(jobs).toHaveLength(0);
  });

  it("refuses an oversize body, another content type, and any delivery while no webhook is registered", async () => {
    const { db } = await fakeDb();
    const f = await build(db);
    const big = JSON.stringify({ id: "evt_3", type: "deployment.created", pad: "x".repeat(VERCEL_WEBHOOK_MAX_BYTES) });
    expect((await post(f, big)).statusCode).toBe(413);
    const form = await f.inject({ method: "POST", url: "/api/v1/webhooks/vercel", payload: "a=1", headers: { "content-type": "application/x-www-form-urlencoded", "x-vercel-signature": sig("a=1") } });
    expect(form.statusCode).toBe(415);
    const none = await fakeDb({ hook: false });
    await f.close();
    const g = await build(none.db);
    const body = event();
    expect((await post(g, body)).statusCode).toBe(404);
    expect(none.jobs).toHaveLength(0);
  });

  it("refuses malformed JSON and a delivery with no id, even correctly signed", async () => {
    const { db } = await fakeDb();
    const f = await build(db);
    expect((await post(f, "{nope")).statusCode).toBe(400);
    expect((await post(f, event({ id: "../../etc" }))).statusCode).toBe(400);
  });
});

describe("VercelApi webhooks", () => {
  const api = (status: number, body: unknown, calls: Array<{ method: string; url: string; body?: unknown }> = []) =>
    new VercelApi(async (r) => (calls.push({ method: r.method, url: r.url, body: r.body }), res(status, body)), TOKEN, "team_1");

  it("registers the deployment events for the linked projects, in the team", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const made = await api(200, { id: "hook_1", secret: "s3" }, calls).createWebhook("https://dock.example.com/api/v1/webhooks/vercel", ["prj_1"]);
    expect(made).toEqual({ ok: true, id: "hook_1", secret: "s3" });
    expect(calls[0]!.url).toBe("https://api.vercel.com/v1/webhooks?teamId=team_1");
    const sent = JSON.parse(String(calls[0]!.body)) as { url: string; events: string[]; projectIds: string[] };
    expect(sent.projectIds).toEqual(["prj_1"]);
    expect(sent.events.every((e) => e.startsWith("deployment"))).toBe(true);
  });

  it("turns a plan refusal into an answer, and a refused token into an error", async () => {
    expect(await api(403, {}).createWebhook("https://x.example/h", ["p"])).toMatchObject({ ok: false, reason: expect.stringContaining("Pro and Enterprise") });
    expect(await api(400, { error: { message: "url is invalid" } }).createWebhook("https://x.example/h", ["p"])).toEqual({ ok: false, reason: "url is invalid" });
    await expect(api(401, {}).createWebhook("https://x.example/h", ["p"])).rejects.toMatchObject({ code: "VERCEL_TOKEN" });
    await expect(api(500, {}).createWebhook("https://x.example/h", ["p"])).rejects.toMatchObject({ code: "UPSTREAM" });
  });

  it("does not accept a success with no secret", async () => {
    await expect(api(200, { id: "hook_1" }).createWebhook("https://x.example/h", ["p"])).rejects.toMatchObject({ code: "UPSTREAM" });
  });

  it("treats a webhook already gone as removed", async () => {
    await expect(api(404, {}).deleteWebhook("hook_1")).resolves.toBeUndefined();
    await expect(api(204, "").deleteWebhook("hook_1")).resolves.toBeUndefined();
    await expect(api(403, {}).deleteWebhook("hook_1")).rejects.toMatchObject({ code: "VERCEL_TOKEN" });
  });

  it("cancels through Vercel's own endpoint, and says when it already finished", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    await api(200, {}, calls).cancelDeployment("dpl_1");
    expect(calls[0]).toMatchObject({ method: "PATCH", url: "https://api.vercel.com/v12/deployments/dpl_1/cancel?teamId=team_1" });
    await expect(api(400, {}).cancelDeployment("dpl_1")).rejects.toMatchObject({ status: 409, code: "ALREADY_FINISHED" });
  });
});

describe("webhookState", () => {
  it("counts what the registration covers, and what was linked since", () => {
    const active = { id: "h", url: "u", projectIds: ["a", "b"], registeredAt: "2026-11-06T00:00:00.000Z", state: "active" as const, reason: null };
    expect(webhookState(active, ["a", "c"])).toMatchObject({ state: "active", projects: 1, missingProjects: 1 });
    expect(webhookState(null, ["a"])).toMatchObject({ state: "off", projects: 0 });
    expect(webhookState({ ...active, id: null, state: "unavailable", reason: "plan" }, ["a"])).toMatchObject({ state: "unavailable", reason: "plan" });
  });
});

describe("Vercel log lines", () => {
  it("reads both documented event shapes and skips what prints nothing", () => {
    expect(eventToLine({ type: "stdout", created: 1000, payload: { text: "hello\n" } })).toEqual({ ts: new Date(1000).toISOString(), stream: "stdout", text: "hello" });
    expect(eventToLine({ type: "stderr", created: 1000, text: "bad" })).toMatchObject({ stream: "stderr", text: "bad" });
    expect(eventToLine({ type: "fatal", created: 1000, payload: { text: "boom" } })).toMatchObject({ stream: "stderr" });
    for (const skipped of [{ type: "delimiter", payload: { text: "x" } }, { type: "deployment-state", payload: {} }, { type: "metric", text: "x" }, { type: "stdout" }, null, "x"]) expect(eventToLine(skipped)).toBeNull();
  });

  it("takes a JSON array, newline-delimited JSON, or nothing", () => {
    expect(parseEvents('[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(parseEvents('{"a":1}\n{"a":2}\nnot json')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseEvents("null")).toEqual([]);
    expect(parseEvents("")).toEqual([]);
  });

  it("maps runtime rows to levels and streams", () => {
    expect(runtimeToLine({ rowId: "r1", timestampInMs: 5, level: "warning", message: "careful", source: "serverless" }, "a1")).toMatchObject({ id: "r1", appId: "a1", level: "warn", stream: "stdout", text: "careful" });
    expect(runtimeToLine({ rowId: "r2", timestampInMs: 5, level: "fatal", message: "dead" }, "a1")).toMatchObject({ level: "error", stream: "stderr" });
    expect(runtimeToLine({ rowId: "r3", timestampInMs: 5, level: "info", message: "", requestMethod: "GET", requestPath: "/x", responseStatusCode: 200 }, "a1")).toMatchObject({ text: "GET /x 200" });
    expect(runtimeToLine({ source: "delimiter", message: "x" }, "a1")).toBeNull();
  });

  it("gives a retention note that says only what is known", () => {
    expect(retentionNote(false)).toMatchObject({ plan: "unknown", minHours: null, byPlanHours: { hobby: 1, pro: 24, enterprise: 72, observabilityPlus: 720 }, linesPerRequest: 256 });
    expect(retentionNote(false).note).toContain("does not tell Dockify the plan");
    expect(retentionNote(true)).toMatchObject({ plan: "pro_or_enterprise", minHours: 24 });
  });
});

function fakeClients(http: HttpClient, stream?: StreamClient) {
  setVercelLogClients({ http, stream: stream ?? (async () => { throw new Error("no stream expected"); }) });
}

function streamOf(lines: string[], status = 200): StreamResponse {
  return {
    status,
    headers: {},
    ended: "done",
    async *lines() {
      for (const l of lines) yield l;
    },
    text: async () => "",
    close: () => undefined,
  };
}

describe("readBuildLog", () => {
  const events = (texts: string[]) => texts.map((text, i) => ({ type: "stdout", created: 1000 + i, payload: { text } }));
  const dep = (over: Partial<{ externalId: string | null; terminal: boolean }> = {}) => ({ externalId: "dpl_1", projectId: "p1", terminal: true, ...over });

  it("reads from Vercel with the token in the header only, oldest first, in the team", async () => {
    const { db } = await fakeDb();
    const seen: Array<{ url: string; auth?: string }> = [];
    fakeClients(async (r) => {
      seen.push({ url: r.url, auth: r.headers?.Authorization });
      return res(200, [...events(["one", "two"])].reverse());
    });
    const out = await readBuildLog(db, ring, dep(), -1);
    expect(out.lines.map((l) => [l.seq, l.text])).toEqual([[1, "one"], [2, "two"]]);
    expect(out).toMatchObject({ done: true, source: "vercel" });
    expect(seen[0]!.url).toContain("https://api.vercel.com/v3/deployments/dpl_1/events?");
    expect(seen[0]!.url).toContain("teamId=team_1");
    expect(seen[0]!.url).not.toContain(TOKEN);
    expect(seen[0]!.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("pages by seq and is not done until the deployment is", async () => {
    const { db } = await fakeDb();
    fakeClients(async () => res(200, events(["one", "two", "three"]).reverse()));
    const live = await readBuildLog(db, ring, dep({ terminal: false }), 2);
    expect(live.lines.map((l) => l.seq)).toEqual([3]);
    expect(live.done).toBe(false);
  });

  it("redacts the token, the project's secrets and anything that names itself", async () => {
    const { db } = await fakeDb({ env: [{ key: "API_SECRET", value: "super-secret-value", secret: true }, { key: "PLAIN", value: "ordinary-value", secret: false }] });
    fakeClients(async () => res(200, events([`token is ${TOKEN}`, "leak super-secret-value here", "keep ordinary-value here", "password=hunter22", "Authorization: Bearer abcdefghijklmnop"]).reverse()));
    const text = (await readBuildLog(db, ring, dep(), -1)).lines.map((l) => l.text).join("\n");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("super-secret-value");
    expect(text).not.toContain("hunter22");
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).toContain("ordinary-value");
  });

  it("says so when Vercel no longer has it", async () => {
    const { db } = await fakeDb();
    fakeClients(async () => res(404));
    expect((await readBuildLog(db, ring, dep(), -1)).lines[0]!.text).toBe(GONE_NOTICE);
  });

  it("has nothing yet for a deploy Vercel has not accepted, and does not call Vercel", async () => {
    const { db } = await fakeDb();
    fakeClients(async () => { throw new Error("should not be called"); });
    expect(await readBuildLog(db, ring, dep({ externalId: null, terminal: false }), -1)).toEqual({ lines: [], done: false, source: "vercel" });
  });

  it("marks a log too large to show whole, after one notice line", async () => {
    const { db } = await fakeDb();
    let calls = 0;
    const { OutboundError } = await import("@dockify/net-guard");
    fakeClients(async (r) => {
      calls++;
      if (r.url.includes("limit=10000")) throw new OutboundError("big", "TOO_LARGE");
      return res(200, Array.from({ length: 2000 }, (_, i) => ({ type: "stdout", created: i, payload: { text: `l${i}` } })));
    });
    const out = await readBuildLog(db, ring, dep(), -1);
    expect(calls).toBe(2);
    expect(out.truncated).toBe(true);
    expect(out.lines[0]!.text).toBe(TRUNCATED_NOTICE);
  });

  it("says a refused token and an outage plainly, never with the token", async () => {
    const { db } = await fakeDb();
    fakeClients(async () => res(403));
    await expect(readBuildLog(db, ring, dep(), -1)).rejects.toMatchObject({ code: "VERCEL_TOKEN" });
    clearVercelLogCache();
    fakeClients(async () => { throw new Error(`boom ${TOKEN}`); });
    const e = await readBuildLog(db, ring, dep(), -1).catch((x: Error) => x);
    expect((e as Error).message).not.toContain(TOKEN);
    expect(e).toMatchObject({ code: "UPSTREAM" });
  });

  it("shares one read between viewers of a running build", async () => {
    const { db } = await fakeDb();
    let calls = 0;
    fakeClients(async () => (calls++, res(200, [])));
    await Promise.all([readBuildLog(db, ring, dep({ terminal: false }), -1), readBuildLog(db, ring, dep({ terminal: false }), -1)]);
    expect(calls).toBe(1);
  });
});

describe("tailRuntime", () => {
  const d = { appId: "a1", externalId: "dpl_1", vercelProjectId: "prj_1", projectId: "p1" };

  it("returns what arrives in a short read, redacted, once each, cut to the tail", async () => {
    const { db } = await fakeDb();
    const rows = ["r1", "r1", "r2", "r3"].map((rowId, i) => JSON.stringify({ rowId, timestampInMs: i, level: "info", message: `${rowId} ${TOKEN}` }));
    const seen: string[] = [];
    fakeClients(async () => res(200), async (r) => (seen.push(r.url), streamOf([...rows, "not json", ""])));
    const lines = await tailRuntime(db, ring, d, 2);
    expect(seen[0]).toBe("https://api.vercel.com/v1/projects/prj_1/deployments/dpl_1/runtime-logs?teamId=team_1");
    expect(lines.map((l) => l.id)).toEqual(["r2", "r3"]);
    expect(lines[0]!.text).not.toContain(TOKEN);
  });

  it("is empty for a deployment Vercel no longer has, and refuses on a refused token", async () => {
    const { db } = await fakeDb();
    fakeClients(async () => res(200), async () => streamOf([], 404));
    expect(await tailRuntime(db, ring, d, 10)).toEqual([]);
    fakeClients(async () => res(200), async () => streamOf([], 403));
    await expect(tailRuntime(db, ring, d, 10)).rejects.toMatchObject({ code: "VERCEL_TOKEN" });
  });

  it("stops the moment the viewer leaves, so its read slot is free for the next view at once", async () => {
    const { db } = await fakeDb();
    // Vercel holds the connection and sends nothing, as it does for a quiet static site.
    fakeClients(async () => res(200), async (r) => {
      await new Promise<void>((ok) => r.signal?.addEventListener("abort", () => ok(), { once: true }));
      throw new Error("aborted");
    });
    const { withLogReadSlot } = await import("../deployments/handlers.ts");
    // A viewer who opens and leaves the Logs tab over and over never meets the two-read limit.
    for (let i = 0; i < 6; i++) {
      const left = new AbortController();
      const read = withLogReadSlot("viewer", () => tailRuntime(db, ring, d, 10, left.signal));
      setTimeout(() => left.abort(), 20);
      await expect(read).rejects.toMatchObject({ code: "UPSTREAM" });
    }
    expect(await withLogReadSlot("viewer", async () => "free")).toBe("free");
  });
});

describe("mapping a Vercel row", () => {
  it("names the provider only for a provider's row", () => {
    expect(externalOf({ provider: "dockify" })).toEqual({ external: null });
    expect(externalOf({})).toEqual({});
    expect(externalOf({ provider: "vercel", externalId: "dpl_1", externalUrl: "https://x.vercel.app", inspectorUrl: "https://vercel.com/a/b/c", externalTarget: "preview", externalSource: "git", externalCreator: "sam" }).external)
      .toEqual({ provider: "vercel", id: "dpl_1", url: "https://x.vercel.app", inspectorUrl: "https://vercel.com/a/b/c", target: "preview", source: "git", creator: "sam" });
  });

  it("draws Vercel's life cycle in three steps", () => {
    const createdAt = new Date("2026-11-06T00:00:00.000Z");
    const startedAt = new Date("2026-11-06T00:00:10.000Z");
    const finishedAt = new Date("2026-11-06T00:01:00.000Z");
    const statuses = (s: Parameters<typeof vercelSteps>[0]) => vercelSteps(s).map((x) => x.status);
    expect(statuses({ status: "queued", createdAt })).toEqual(["running", "pending", "pending"]);
    expect(statuses({ status: "building", createdAt, startedAt })).toEqual(["done", "running", "pending"]);
    expect(statuses({ status: "ready", createdAt, startedAt, finishedAt })).toEqual(["done", "done", "done"]);
    expect(statuses({ status: "failed", createdAt, startedAt, finishedAt })).toEqual(["done", "failed", "skipped"]);
    expect(statuses({ status: "cancelled", createdAt, finishedAt })).toEqual(["cancelled", "skipped", "skipped"]);
  });
});
