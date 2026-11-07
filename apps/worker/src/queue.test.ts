import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@dockify/db";
import { backoffMs, claim, complete, defaultServerId, defer, enqueue, extendLease, fail, holdLease, release } from "./queue.ts";

describe("holdLease", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const quiet = (seen: string[]) => (msg: string) => void seen.push(msg);

  it("survives a renewal that throws and renews again on the next beat", async () => {
    let calls = 0;
    const fake = { $executeRaw: async () => { if (++calls === 1) throw new Error("Can't reach database server"); return 1; } } as unknown as Db;
    const seen: string[] = [];
    const lease = holdLease(fake, "j", "w", 30, quiet(seen));
    await wait(60);
    lease.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(lease.signal.aborted).toBe(false);
    expect(seen[0]).toMatch(/could not renew/);
  });

  it("aborts only when the row says the lease is gone, and stops renewing", async () => {
    let calls = 0;
    const fake = { $executeRaw: async () => (++calls, 0) } as unknown as Db;
    const lease = holdLease(fake, "j", "w", 30, () => {});
    await wait(60);
    expect(lease.signal.aborted).toBe(true);
    expect(calls).toBe(1);
    lease.stop();
  });

  it("the worker's lanes renew through it, so no renewal can reject unhandled", () => {
    const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    expect(main).toContain("holdLease(db, job.id, workerId, LEASE_MS, log)");
    expect(main).not.toContain("extendLease");
  });
});

describe("backoff", () => {
  it("grows exponentially and caps at 15 minutes", () => {
    const mid = () => 0.5;
    expect(backoffMs(1, mid)).toBe(5_000);
    expect(backoffMs(2, mid)).toBe(10_000);
    expect(backoffMs(30, mid)).toBe(15 * 60_000);
  });
  it("jitters within 20 percent either way", () => {
    expect(backoffMs(1, () => 0)).toBe(4_000);
    expect(backoffMs(1, () => 1)).toBe(6_000);
  });
});

const url = process.env.DATABASE_URL_TEST;

describe.skipIf(!url)("queue (postgres)", () => {
  let db: Db;
  /** The primary every migrated database has, and a second server for the tests that need two. */
  let A: string;
  let B: string;
  const OTHER = "queue-test-other";
  beforeAll(async () => {
    db = createDb(url);
    A = await defaultServerId(db);
    await db.server.deleteMany({ where: { name: OTHER } });
    B = (await db.server.create({ data: { name: OTHER, state: "active" }, select: { id: true } })).id;
  });
  afterAll(async () => {
    await db?.server.deleteMany({ where: { name: OTHER } });
    await db?.$disconnect();
  });
  beforeEach(async () => {
    await db.job.deleteMany();
  });

  it("a deferred job spends no attempt, however many times, and runs when its time comes", async () => {
    await enqueue(db, { kind: "alert_notify", lane: "maintenance", payload: {}, maxAttempts: 2 });
    for (let i = 0; i < 5; i++) {
      const job = await claim(db, "maintenance", 60_000, "w1", null);
      expect(job?.attempts).toBe(1);
      expect(job?.createdAt).toBeInstanceOf(Date);
      await defer(db, job!.id, "the api did not answer", 0);
    }
    const row = await db.job.findFirstOrThrow({ where: { kind: "alert_notify" } });
    expect(row).toMatchObject({ attempts: 0, failedAt: null, lockedUntil: null, lastError: "the api did not answer" });
    const job = await claim(db, "maintenance", 60_000, "w1", null);
    await defer(db, job!.id, "later", 60_000);
    expect(await claim(db, "maintenance", 60_000, "w1", null)).toBeNull();
  });

  it("claims once, skips a leased row, and counts the attempt at claim", async () => {
    await enqueue(db, { kind: "deploy", serverId: A, payload: { appId: "a" } });
    const a = await claim(db, "deploy", 60_000, "w1", A);
    const b = await claim(db, "deploy", 60_000, "w2", A);
    expect(a?.attempts).toBe(1);
    expect(b).toBeNull();
    await complete(db, a!.id);
    expect(await claim(db, "deploy", 60_000, "w2", A)).toBeNull();
  });

  it("keeps lanes apart", async () => {
    await enqueue(db, { kind: "backup", lane: "data", serverId: A, payload: {} });
    expect(await claim(db, "deploy", 60_000, "w1", A)).toBeNull();
    expect(await claim(db, "data", 60_000, "w1", A)).not.toBeNull();
  });

  it("collapses duplicate enqueues while one is open", async () => {
    const one = await enqueue(db, { kind: "deploy", serverId: A, payload: {}, dedupeKey: "deploy:app-1" });
    const two = await enqueue(db, { kind: "deploy", serverId: A, payload: {}, dedupeKey: "deploy:app-1" });
    expect(two).toBe(one);
  });

  it("only the lease holder can extend, and release gives the attempt back", async () => {
    await enqueue(db, { kind: "deploy", serverId: A, payload: {} });
    const job = (await claim(db, "deploy", 60_000, "w1", A))!;
    expect(await extendLease(db, job.id, "w2", 60_000)).toBe(false);
    expect(await extendLease(db, job.id, "w1", 60_000)).toBe(true);
    await release(db, job.id);
    const again = (await claim(db, "deploy", 60_000, "w2", A))!;
    expect(again.attempts).toBe(1);
  });

  it("a lease that lapsed during an outage can still be renewed while no one else claimed it", async () => {
    await enqueue(db, { kind: "deploy", serverId: A, payload: {} });
    const job = (await claim(db, "deploy", 60_000, "w1", A))!;
    await db.$executeRaw`UPDATE jobs SET "lockedUntil" = now() - interval '5 seconds' WHERE id = ${job.id}::uuid`;
    expect(await extendLease(db, job.id, "w1", 60_000)).toBe(true);
    await db.$executeRaw`UPDATE jobs SET "lockedUntil" = now() - interval '5 seconds' WHERE id = ${job.id}::uuid`;
    expect((await claim(db, "deploy", 60_000, "w2", A))?.id).toBe(job.id);
    expect(await extendLease(db, job.id, "w1", 60_000)).toBe(false);
  });

  it("a permanent failure is never retried", async () => {
    await enqueue(db, { kind: "deploy", serverId: A, payload: {}, maxAttempts: 5 });
    const job = (await claim(db, "deploy", 60_000, "w1", A))!;
    expect(await fail(db, job, "health check failed", true)).toBe("failed");
    expect(await claim(db, "deploy", 60_000, "w1", A)).toBeNull();
  });

  it("a job whose every attempt died with its worker is failed, not left open forever", async () => {
    const id = await enqueue(db, { kind: "deploy", serverId: A, payload: {}, maxAttempts: 1 });
    await claim(db, "deploy", 60_000, "w1", A);
    // The worker is killed: no fail(), no release(); the lease simply expires.
    await db.$executeRaw`UPDATE jobs SET "lockedUntil" = now() - interval '1 second' WHERE id = ${id}::uuid`;
    expect(await claim(db, "deploy", 60_000, "w2", A)).toBeNull();
    const row = await db.job.findUnique({ where: { id } });
    expect(row?.failedAt).toBeInstanceOf(Date);
    expect(row?.lastError).toMatch(/worker stopped/);
  });

  it("gives a server's job to that server's loop and to no other", async () => {
    const forA = await enqueue(db, { kind: "deploy", serverId: A, payload: {} });
    expect(await claim(db, "deploy", 60_000, "w1", B)).toBeNull();
    expect(await claim(db, "deploy", 60_000, "w1", null)).toBeNull();
    const job = await claim(db, "deploy", 60_000, "w1", A);
    expect(job).toMatchObject({ id: forA, serverId: A });
  });

  it("gives a job with no server to the global loop alone", async () => {
    const global = await enqueue(db, { kind: "alert_notify", lane: "maintenance", payload: {} });
    expect(await claim(db, "maintenance", 60_000, "w1", A)).toBeNull();
    expect(await claim(db, "maintenance", 60_000, "w1", B)).toBeNull();
    const job = await claim(db, "maintenance", 60_000, "w1", null);
    expect(job).toMatchObject({ id: global, serverId: null });
  });

  it("keeps a server's maintenance job from the global loop, on the one lane both claim", async () => {
    const janitor = await enqueue(db, { kind: "janitor", lane: "maintenance", serverId: A, payload: {} });
    expect(await claim(db, "maintenance", 60_000, "w1", null)).toBeNull();
    expect((await claim(db, "maintenance", 60_000, "w1", A))?.id).toBe(janitor);
  });

  it("settles another server's exhausted job at any claim: its own loops may be gone", async () => {
    const id = await enqueue(db, { kind: "deploy", serverId: B, payload: {}, maxAttempts: 1 });
    await claim(db, "deploy", 60_000, "w1", B);
    await db.$executeRaw`UPDATE jobs SET "lockedUntil" = now() - interval '1 second' WHERE id = ${id}::uuid`;
    expect(await claim(db, "deploy", 60_000, "w2", A)).toBeNull();
    expect((await db.job.findUnique({ where: { id } }))?.failedAt).toBeInstanceOf(Date);
  });

  it("refuses a job the CHECK says must name a server", async () => {
    await expect(db.job.create({ data: { kind: "deploy", lane: "deploy", payload: {} } })).rejects.toThrow(/jobs_server_bound/);
    await expect(db.job.create({ data: { kind: "dns_check", lane: "deploy", payload: {} } })).rejects.toThrow(/jobs_server_bound/);
    await expect(db.job.create({ data: { kind: "dns_check", lane: "maintenance", payload: {} } })).resolves.toBeTruthy();
  });
});
