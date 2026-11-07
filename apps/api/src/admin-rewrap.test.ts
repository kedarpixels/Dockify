import { randomUUID } from "node:crypto";
import { loadKeyring, open, type Keyring, type Sealed } from "@dockify/crypto";
import { createDb, LIVE_ALERT_METRIC, storeSecret, type Db } from "@dockify/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apiStaleProblem, rewrapSecrets } from "./admin.ts";
import { alertsPayload, deleteRule, patchRule } from "./modules/observe/alerts.ts";

const url = process.env.DATABASE_URL_TEST;

const key = (seed: number) => Buffer.from(Array.from({ length: 32 }, (_, i) => (i * seed + 11) % 251)).toString("base64");
const OLD = key(17);
const NEW = key(29);
const before = loadKeyring({ DOCKIFY_MASTER_KEY: OLD } as NodeJS.ProcessEnv);
const rotating = loadKeyring({ DOCKIFY_MASTER_KEY: NEW, DOCKIFY_MASTER_KEY_PREVIOUS: OLD } as NodeJS.ProcessEnv);
const after = loadKeyring({ DOCKIFY_MASTER_KEY: NEW } as NodeJS.ProcessEnv);

describe("apiStaleProblem", () => {
  it("refuses only a key written after the running api started", () => {
    expect(apiStaleProblem(2_000, 1_000)).toMatch(/dockify restart api/);
    expect(apiStaleProblem(1_000, 2_000)).toBeNull();
  });
});

describe.skipIf(!url)("dockify admin rewrap-secrets (postgres)", () => {
  let db: Db;
  let ids: string[] = [];
  let others: Array<{ id: string; kekId: string }> = [];
  let instance: { id: number; masterKeyFingerprint: string } | null = null;

  const VALUES = ["postgres://u:one@db/x", "a token with spaces", "", "ünïcode value"];
  const read = (ring: Keyring, row: { id: string; kind: string; ownerType: string; ownerId: string; kekId: string; wrappedDek: Uint8Array; dekNonce: Uint8Array; ciphertext: Uint8Array; ctNonce: Uint8Array }) => {
    const sealed: Sealed = { kekId: row.kekId, wrappedDek: Buffer.from(row.wrappedDek), dekNonce: Buffer.from(row.dekNonce), ciphertext: Buffer.from(row.ciphertext), ctNonce: Buffer.from(row.ctNonce) };
    return open(ring, { id: row.id, kind: row.kind, scope: `${row.ownerType}:${row.ownerId}` }, sealed);
  };
  const rows = () => db.secret.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } });
  const snapshot = async () => JSON.stringify(await rows(), (_, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v));
  const expectStillOld = async (was: string) => {
    expect(await snapshot()).toBe(was);
    const inst = await db.instance.findUniqueOrThrow({ where: { id: 1 } });
    expect(inst.masterKeyFingerprint).toBe(before.active);
    for (const r of await rows()) {
      expect(VALUES).toContain(read(before, r));
      expect(VALUES).toContain(read(rotating, r));
    }
  };

  beforeAll(async () => {
    db = createDb(url);
    instance = await db.instance.findUnique({ where: { id: 1 }, select: { id: true, masterKeyFingerprint: true } });
    if (!instance) await db.instance.create({ data: { id: 1, name: "Rewrap test", publicUrl: "https://dockify.test", masterKeyFingerprint: before.active, ingressMode: "cloudflare_tunnel" } });
    // Rows other test files left, under keys this test does not hold, step aside for the run.
    others = await db.secret.findMany({ select: { id: true, kekId: true } });
    await db.secret.updateMany({ data: { kekId: after.active } });
  });
  afterAll(async () => {
    for (const r of others) await db.secret.update({ where: { id: r.id }, data: { kekId: r.kekId } });
    if (instance) await db.instance.update({ where: { id: 1 }, data: { masterKeyFingerprint: instance.masterKeyFingerprint } });
    else await db.instance.delete({ where: { id: 1 } });
    await db.$disconnect();
  });
  beforeEach(async () => {
    await db.instance.update({ where: { id: 1 }, data: { masterKeyFingerprint: before.active } });
    ids = [];
    for (const value of VALUES) ids.push(await storeSecret(db, before, { kind: "env_var", ownerType: "app", ownerId: randomUUID() }, value));
  });
  afterEach(async () => {
    await db.secret.deleteMany({ where: { id: { in: ids } } });
  });

  it("moves every row to the new key and the instance with it, so the old key can go", async () => {
    const was = await rows();
    expect(await rewrapSecrets(db, rotating)).toMatch(/^4 secrets were re-sealed/);
    const now = await rows();
    expect(now.map((r) => r.kekId)).toEqual(ids.map(() => after.active));
    // Opens with the new key alone, each value what it was, under a data key of its own.
    expect(now.map((r) => read(after, r)).sort()).toEqual([...VALUES].sort());
    for (const [i, r] of now.entries()) {
      expect(Buffer.from(r.wrappedDek).equals(Buffer.from(was[i]!.wrappedDek))).toBe(false);
      expect(r.updatedAt).toEqual(was[i]!.updatedAt);
      expect(() => read(before, r)).toThrow();
    }
    expect((await db.instance.findUniqueOrThrow({ where: { id: 1 } })).masterKeyFingerprint).toBe(after.active);
    expect(await db.activityLog.count({ where: { action: "admin.rewrap-secrets" } })).toBeGreaterThan(0);
    // A second run has nothing to do.
    expect(await rewrapSecrets(db, rotating)).toMatch(/Nothing changed/);
  });

  it("changes nothing when one row will not open, and works once that row is whole again", async () => {
    const whole = await rows();
    const victim = whole[2]!;
    const flipped = Buffer.from(victim.ciphertext);
    flipped[0] = flipped[0]! ^ 0xff;
    await db.secret.update({ where: { id: victim.id }, data: { ciphertext: flipped } });
    const was = await snapshot();
    await expect(rewrapSecrets(db, rotating)).rejects.toThrow(victim.id);
    expect(await snapshot()).toBe(was);
    expect((await db.instance.findUniqueOrThrow({ where: { id: 1 } })).masterKeyFingerprint).toBe(before.active);
    await db.secret.update({ where: { id: victim.id }, data: { ciphertext: Buffer.from(victim.ciphertext) } });
    await expect(rewrapSecrets(db, rotating)).resolves.toMatch(/^4 secrets/);
  });

  it("changes nothing when the old key is not loaded", async () => {
    const was = await snapshot();
    await expect(rewrapSecrets(db, after)).rejects.toThrow(/not loaded/);
    await expectStillOld(was);
  });

  it("rolls every write back when the database fails part way through", async () => {
    const was = await snapshot();
    const last = (await rows()).at(-1)!.id;
    const audited = await db.activityLog.count({ where: { action: "admin.rewrap-secrets" } });
    await db.$executeRawUnsafe(`CREATE FUNCTION rewrap_test_fail() RETURNS trigger AS $$ BEGIN IF NEW.id = '${last}' THEN RAISE EXCEPTION 'disk full'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`CREATE TRIGGER rewrap_test_fail BEFORE UPDATE ON secrets FOR EACH ROW EXECUTE FUNCTION rewrap_test_fail()`);
    try {
      await expect(rewrapSecrets(db, rotating)).rejects.toThrow(/disk full/);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER rewrap_test_fail ON secrets`);
      await db.$executeRawUnsafe(`DROP FUNCTION rewrap_test_fail()`);
    }
    await expectStillOld(was);
    expect(await db.activityLog.count({ where: { action: "admin.rewrap-secrets" } })).toBe(audited);
  });
});

describe.skipIf(!url)("an http_5xx rule an earlier version stored (postgres)", () => {
  let db: Db;
  let id: string;
  const caller = { actor: null, ip: "127.0.0.1", ua: undefined };
  beforeAll(async () => {
    db = createDb(url);
    id = (await db.alertRule.create({ data: { metric: "http_5xx", threshold: 5, durationMin: 5, channels: ["bell"] } })).id;
    await db.alertEvent.create({ data: { ruleId: id, metric: "http_5xx", detail: "old", href: "/" } });
  });
  afterAll(async () => {
    await db.alertEvent.deleteMany({ where: { ruleId: id } });
    await db.alertRule.deleteMany({ where: { id } });
    await db.$disconnect();
  });

  it("is not listed, and the list still reads", async () => {
    const p = await alertsPayload(db);
    expect(p.rules.map((r) => r.id)).not.toContain(id);
    expect(p.events.map((e) => e.ruleId)).not.toContain(id);
    expect(await db.alertRule.count({ where: { id, metric: LIVE_ALERT_METRIC } })).toBe(0);
  });

  it("cannot be changed or deleted through the API, and stays stored", async () => {
    await expect(patchRule(db, id, { enabled: false }, caller)).rejects.toMatchObject({ status: 404 });
    await expect(deleteRule(db, id, caller)).rejects.toMatchObject({ status: 404 });
    expect(await db.alertRule.findUnique({ where: { id } })).toMatchObject({ metric: "http_5xx", enabled: true });
  });
});
