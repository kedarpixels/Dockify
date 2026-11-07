import { loadKeyring } from "@dockify/crypto";
import { describe, expect, it } from "vitest";
import {
  generateServiceCredentials, openServiceCredentials, parseServiceCredentials, readSecretValue, sealServiceCredentials, serializeServiceCredentials,
  ServiceCredentialsError, storeSecret, upgradeLegacyServiceCredentials,
} from "./index.ts";

/** A fixed test key. Never a real secret. */
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 251)).toString("base64");
const ring = loadKeyring({ DOCKIFY_MASTER_KEY: KEY } as NodeJS.ProcessEnv);

type Row = Record<string, unknown>;

/** Secrets and apps in memory, enough for the helpers' queries and the upgrade transaction. */
function fakeDb(apps: Row[]) {
  const secrets = new Map<string, Row>();
  const appRows = new Map(apps.map((a) => [String(a.id), { ...a }]));
  const db = {
    secret: {
      create: async ({ data }: { data: Row }) => (secrets.set(String(data.id), data), data),
      findUnique: async ({ where }: { where: { id: string } }) => secrets.get(where.id) ?? null,
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => secrets.get(id)).filter(Boolean),
      delete: async ({ where }: { where: { id: string } }) => secrets.delete(where.id),
      deleteMany: async ({ where }: { where: { id: string } }) => ({ count: secrets.delete(where.id) ? 1 : 0 }),
    },
    app: {
      findMany: async () => [...appRows.values()],
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const a = appRows.get(String(where.id));
        if (!a || a.passwordSecretId !== where.passwordSecretId) return { count: 0 };
        Object.assign(a, data);
        return { count: 1 };
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
  };
  return { db: db as never, secrets, appRows };
}

describe("service credentials", () => {
  it("generates the JSON shape per kind", () => {
    const pg = generateServiceCredentials("postgres", "my-db");
    expect(pg).toMatchObject({ user: "dockify", database: "my_db" });
    expect(pg.password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(generateServiceCredentials("redis", "cache")).toEqual({ user: "default", password: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/) });
    expect(generateServiceCredentials("postgres", "a").password).not.toBe(generateServiceCredentials("postgres", "a").password);
  });

  it("round trips through the sealed JSON", async () => {
    const { db } = fakeDb([]);
    const c = generateServiceCredentials("postgres", "db");
    const id = await sealServiceCredentials(db, ring, "app-1", c);
    const raw = await readSecretValue(db, ring, id);
    expect(raw).toBe(serializeServiceCredentials(c));
    expect(parseServiceCredentials(raw!, { kind: "postgres", name: "db" })).toEqual({ credentials: c, legacy: false });
  });

  it("reads an older install's bare password as the shape it stands for", () => {
    const bare = "Abc_def-0123456789xyzXYZ01234567";
    expect(parseServiceCredentials(bare, { kind: "redis", name: "cache" })).toEqual({ credentials: { user: "default", password: bare }, legacy: true });
    expect(parseServiceCredentials(` ${bare}\n`, { kind: "postgres", name: "main-db" })).toEqual({ credentials: { user: "dockify", password: bare, database: "main_db" }, legacy: true });
  });

  it("turns anything unreadable into one clear permanent error, never a JSON exception or the value", () => {
    for (const raw of ["{not json", '{"user":"u"}', '{"user":"u","password":""}', '{"user":1,"password":"p"}', '{"user":"u","password":"p","database":5}', "has spaces and $ymbols", ""]) {
      let err: unknown;
      try {
        parseServiceCredentials(raw, { kind: "redis", name: "cache" });
      } catch (e) {
        err = e;
      }
      expect(err, raw).toBeInstanceOf(ServiceCredentialsError);
      expect((err as Error).message).toBe("The stored credentials of cache are damaged and cannot be read");
      expect((err as { permanent?: boolean }).permanent).toBe(true);
    }
  });

  it("refuses a missing row and a non-service app clearly", async () => {
    const { db } = fakeDb([]);
    await expect(openServiceCredentials(db, ring, { id: "a", name: "web", kind: "backend", passwordSecretId: "x" })).rejects.toThrow(/web is not a managed service/);
    await expect(openServiceCredentials(db, ring, { id: "a", name: "db", kind: "postgres", passwordSecretId: null })).rejects.toThrow(/db has no stored credentials/);
    await expect(openServiceCredentials(db, ring, { id: "a", name: "db", kind: "postgres", passwordSecretId: "00000000-0000-4000-8000-000000000000" })).rejects.toBeInstanceOf(ServiceCredentialsError);
  });

  it("upgrades every legacy row to JSON once, keeping the password, and leaves JSON rows alone", async () => {
    const bare = "Legacy_password-0123456789abcdef";
    const { db, secrets, appRows } = fakeDb([]);
    const legacyId = await storeSecret(db, ring, { kind: "database_password", ownerType: "app", ownerId: "r1" }, bare);
    const jsonId = await sealServiceCredentials(db, ring, "p1", generateServiceCredentials("postgres", "db"));
    appRows.set("r1", { id: "r1", name: "cache", kind: "redis", passwordSecretId: legacyId });
    appRows.set("p1", { id: "p1", name: "db", kind: "postgres", passwordSecretId: jsonId });

    expect(await upgradeLegacyServiceCredentials(db, ring)).toEqual({ upgraded: 1, unreadable: [] });
    const now = appRows.get("r1")!.passwordSecretId as string;
    expect(now).not.toBe(legacyId);
    expect(secrets.has(legacyId)).toBe(false);
    expect(JSON.parse((await readSecretValue(db, ring, now))!)).toEqual({ user: "default", password: bare });
    expect(appRows.get("p1")!.passwordSecretId).toBe(jsonId);
    // A second start finds nothing left to do.
    expect(await upgradeLegacyServiceCredentials(db, ring)).toEqual({ upgraded: 0, unreadable: [] });
  });

  it("reports a row it cannot read instead of failing the whole upgrade", async () => {
    const { db, appRows } = fakeDb([]);
    const bad = await storeSecret(db, ring, { kind: "database_password", ownerType: "app", ownerId: "r2" }, "not a password at all");
    appRows.set("r2", { id: "r2", name: "broken", kind: "redis", passwordSecretId: bad });
    expect(await upgradeLegacyServiceCredentials(db, ring)).toEqual({ upgraded: 0, unreadable: ["broken"] });
  });
});
