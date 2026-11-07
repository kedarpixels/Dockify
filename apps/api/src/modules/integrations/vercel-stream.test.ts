import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { storeSecret, type Db } from "@dockify/db";
import type { HttpResponse, StreamClient, StreamResponse } from "@dockify/net-guard";
import { testRing } from "../../test-helpers.ts";
import { clearVercelLogCache, openVercelStreams, setVercelLogClients, streamBuildLog, streamRuntimeLog } from "./vercel-logs.ts";

/** The two SSE answers over a real socket, with Vercel faked, so frames and teardown are what a browser sees. */

const ring = testRing();
const TOKEN = "vercel-token-value-123456";

async function fakeDb() {
  const secrets = new Map<string, Record<string, unknown>>();
  const row: Record<string, unknown> = { id: "i1", kind: "vercel", name: "default", status: "connected", config: {}, secretId: null, secondSecretId: null };
  const db = {
    secret: {
      create: async ({ data }: { data: Record<string, unknown> }) => (secrets.set(String(data.id), data), data),
      findUnique: async ({ where }: { where: { id: string } }) => secrets.get(where.id) ?? null,
    },
    integration: { findUnique: async () => row },
    app: { findMany: async () => [] },
    environment: { findMany: async () => [] },
    envVar: { findMany: async () => [] },
  };
  row.secretId = await storeSecret(db as never, ring, { kind: "integration_token", ownerType: "integration", ownerId: "i1" }, TOKEN, null);
  return db as unknown as Db;
}

function streamOf(lines: string[], status = 200, ended: StreamResponse["ended"] = "done"): StreamResponse {
  return {
    status, headers: {}, ended,
    async *lines() {
      for (const l of lines) yield l;
    },
    text: async () => "",
    close: () => undefined,
  };
}

const allowed = async () => true;
let app: ReturnType<typeof Fastify> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  setVercelLogClients(null);
  clearVercelLogCache();
});

function vercel(stream: StreamClient) {
  setVercelLogClients({ http: async () => ({ status: 200, headers: {}, body: Buffer.from("[]") }) as HttpResponse, stream });
}

async function serve(handler: (req: never, reply: never) => Promise<void>) {
  const f = Fastify();
  app = f;
  f.get("/s", handler as never);
  return f.listen({ port: 0, host: "127.0.0.1" });
}

const frames = (body: string) =>
  body.split("\n\n").filter((b) => b.includes("event:")).map((b) => ({
    event: /event: (\w+)/.exec(b)?.[1],
    id: /id: (.+)/.exec(b)?.[1],
    data: JSON.parse(/data: (.+)/.exec(b)?.[1] ?? "null") as Record<string, unknown>,
  }));

describe("streamBuildLog", () => {
  const dep = { id: "d1", externalId: "dpl_1", projectId: "p1", status: "building" };
  const event = (text: string) => JSON.stringify({ type: "stdout", created: 1000, payload: { text } });

  it("sends each line once with its seq, redacted, then the final status, and frees its slot", async () => {
    const db = await fakeDb();
    const asked: string[] = [];
    vercel(async (r) => (asked.push(r.url), streamOf([event("one"), JSON.stringify({ type: "metric" }), event(`token ${TOKEN}`), "not json", ""])));
    const base = await serve(async (req, reply) => streamBuildLog(db, ring, req, reply, dep, 0, allowed, async () => "ready", "u1"));
    const body = await (await fetch(`${base}/s`)).text();
    const got = frames(body);
    expect(got.filter((f) => f.event === "line").map((f) => [f.id, f.data.seq])).toEqual([["1", 1], ["2", 2]]);
    expect(body).not.toContain(TOKEN);
    expect(got.at(-1)).toMatchObject({ event: "done", data: { status: "ready" } });
    expect(asked[0]).toContain("/v3/deployments/dpl_1/events?direction=forward&follow=1&limit=-1&builds=1");
    await expect.poll(() => openVercelStreams()).toBe(0);
  });

  it("skips what the viewer already has", async () => {
    const db = await fakeDb();
    vercel(async () => streamOf([event("one"), event("two"), event("three")]));
    const base = await serve(async (req, reply) => streamBuildLog(db, ring, req, reply, dep, 2, allowed, async () => "ready", "u2"));
    const got = frames(await (await fetch(`${base}/s`)).text());
    expect(got.filter((f) => f.event === "line").map((f) => f.data.text)).toEqual(["three"]);
  });

  it("says the mirror has not caught up when Vercel has finished and the row has not", async () => {
    const db = await fakeDb();
    vercel(async () => streamOf([event("one")]));
    const base = await serve(async (req, reply) => streamBuildLog(db, ring, req, reply, dep, 0, allowed, async () => null, "u3"));
    expect(frames(await (await fetch(`${base}/s`)).text()).at(-1)).toMatchObject({ event: "done", data: { status: "syncing" } });
  });

  it("ends with a reason on a refused token, and answers 409 before a deployment has an id", async () => {
    const db = await fakeDb();
    vercel(async () => streamOf([], 403));
    const base = await serve(async (req, reply) => streamBuildLog(db, ring, req, reply, dep, 0, allowed, async () => null, "u4"));
    expect(frames(await (await fetch(`${base}/s`)).text())).toEqual([expect.objectContaining({ event: "end", data: { reason: "token" } })]);
    await app?.close();
    const again = await serve(async (req, reply) => {
      await expect(streamBuildLog(db, ring, req, reply, { ...dep, externalId: null }, 0, allowed, async () => null, "u4")).rejects.toMatchObject({ status: 409 });
      await (reply as unknown as { send(b: string): Promise<void> }).send("checked");
    });
    expect(await (await fetch(`${again}/s`)).text()).toBe("checked");
  });
});

describe("streamRuntimeLog", () => {
  const d = { appId: "a1", externalId: "dpl_1", vercelProjectId: "prj_1", projectId: "p1" };
  const row = (rowId: string, message: string) => JSON.stringify({ rowId, timestampInMs: 5, level: "info", message });

  it("drops a row sent again after a reconnect, redacts, and ends when the connection stays gone", async () => {
    const db = await fakeDb();
    let n = 0;
    vercel(async () => {
      n += 1;
      if (n === 1) return streamOf([row("r1", "first"), row("r2", `secret ${TOKEN}`)], 200, "done");
      if (n === 2) return streamOf([row("r2", "again"), row("r3", "third")], 200, "done");
      return streamOf([], 404);
    });
    const base = await serve(async (req, reply) => streamRuntimeLog(db, ring, req, reply, d, allowed, "u5"));
    const body = await (await fetch(`${base}/s`)).text();
    const got = frames(body);
    expect(got.filter((f) => f.event === "line").map((f) => f.data.id)).toEqual(["r1", "r2", "r3"]);
    expect(body).not.toContain(TOKEN);
    expect(got.at(-1)).toMatchObject({ event: "end", data: { reason: "gone" } });
  }, 20_000);

  it("holds one user to four streams, with a clean 429", async () => {
    const db = await fakeDb();
    // Never ends until the viewer goes.
    vercel(async (r) => {
      await new Promise<void>((res) => r.signal?.addEventListener("abort", () => res(), { once: true }));
      return streamOf([], 200, "aborted");
    });
    const base = await serve(async (req, reply) => streamRuntimeLog(db, ring, req, reply, d, allowed, "u6"));
    const stop = new AbortController();
    await Promise.all([1, 2, 3, 4].map(() => fetch(`${base}/s`, { signal: stop.signal })));
    const fifth = await fetch(`${base}/s`);
    expect(fifth.status).toBe(429);
    stop.abort();
    await expect.poll(() => openVercelStreams(), { timeout: 5_000 }).toBe(0);
  }, 20_000);
});
