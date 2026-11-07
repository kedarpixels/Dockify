/**
 * The one atomic update on a real Postgres (DATABASE_URL_TEST), with the migration's own rows.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, type Db } from "@dockify/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enroll, offerPrimaryToken, serverByPin } from "./enroll.ts";

const url = process.env.DATABASE_URL_TEST;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe.skipIf(!url)("enrolment (postgres)", () => {
  let db: Db;
  let primaryId: string;
  beforeAll(async () => {
    db = createDb(url);
    primaryId = (await db.server.findFirstOrThrow({ where: { isPrimary: true } })).id;
  });
  afterAll(async () => {
    await db.server.deleteMany({ where: { isPrimary: false } });
    await db.server.update({ where: { id: primaryId }, data: { certPin: null, joinTokenHash: null, state: "active" } });
    await db.$disconnect();
  });
  beforeEach(async () => {
    await db.server.deleteMany({ where: { isPrimary: false } });
    await db.server.update({ where: { id: primaryId }, data: { certPin: null, joinTokenHash: null, joinedIp: null, state: "active" } });
  });

  const node = (over: Record<string, unknown> = {}) =>
    db.server.create({ data: { id: randomUUID(), name: `n-${randomUUID()}`, state: "awaiting_join", joinTokenHash: sha256("tok"), joinExpiresAt: new Date(Date.now() + 60_000), ...over } as never });

  it("takes a token once, and the row waits for Approve", async () => {
    const n = await node();
    expect(await enroll(db, "tok", "PIN:A", "203.0.113.9")).toBe(true);
    expect(await db.server.findUniqueOrThrow({ where: { id: n.id } })).toMatchObject({ certPin: "PIN:A", state: "pending_approval", joinTokenHash: null, joinedIp: "203.0.113.9" });
    expect(await enroll(db, "tok", "PIN:B", null)).toBe(false);
    expect(await serverByPin(db, "PIN:B")).toBeNull();
    expect((await serverByPin(db, "PIN:A"))?.state).toBe("pending_approval");
  });

  it("refuses an expired code, a wrong token and a revoked row", async () => {
    await node({ joinExpiresAt: new Date(Date.now() - 1_000) });
    expect(await enroll(db, "tok", "PIN:A", null)).toBe(false);
    expect(await enroll(db, "other", "PIN:A", null)).toBe(false);
    await db.server.deleteMany({ where: { isPrimary: false } });
    await node({ state: "revoked" });
    expect(await enroll(db, "tok", "PIN:A", null)).toBe(false);
  });

  it("two racing enrolments: exactly one wins", async () => {
    await node();
    const results = await Promise.all([enroll(db, "tok", "PIN:A", null), enroll(db, "tok", "PIN:B", null)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("the first server's token needs no expiry, goes straight to active, and is not offered again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dk-token-"));
    const file = join(dir, "primary_join_token");
    await writeFile(file, "primary-secret\n");
    expect(await offerPrimaryToken(db, file)).toBe(true);
    expect(await enroll(db, "primary-secret", "PIN:P", null)).toBe(true);
    expect(await db.server.findUniqueOrThrow({ where: { id: primaryId } })).toMatchObject({ certPin: "PIN:P", state: "active", joinTokenHash: null });
    expect(await offerPrimaryToken(db, file)).toBe(false);
    expect(await enroll(db, "primary-secret", "PIN:Q", null)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});
