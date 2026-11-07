import { loadKeyring } from "@dockify/crypto";
import { describe, expect, it } from "vitest";
import { hintOf, readSecretValue, storeSecret, type SecretKind } from "./index.ts";

/** A fixed test key. Never a real secret. */
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 13 + 7) % 251)).toString("base64");
const ring = loadKeyring({ DOCKIFY_MASTER_KEY: KEY } as NodeJS.ProcessEnv);

function fakeTx() {
  const rows = new Map<string, Record<string, unknown>>();
  const tx = {
    secret: {
      create: async ({ data }: { data: Record<string, unknown> }) => (rows.set(String(data.id), data), data),
      findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => rows.get(id)).filter(Boolean),
    },
  };
  return { tx: tx as never, rows };
}

const VALUE = "sk_live_supersecretvalue_WXYZ";

describe("storeSecret hint", () => {
  const tenantKinds: SecretKind[] = ["env_var", "env_version", "database_password", "env_snapshot", "totp"];

  it.each(tenantKinds)("stores no plaintext suffix for %s when the caller omits the hint", async (kind) => {
    const { tx, rows } = fakeTx();
    const id = await storeSecret(tx, ring, { kind, ownerType: "environment", ownerId: "e1" }, VALUE);
    const row = rows.get(id)!;
    expect(row.hint).toBeNull();
    for (const v of Object.values(row)) {
      if (typeof v === "string") expect(v.includes("WXYZ")).toBe(false);
    }
    expect(await readSecretValue(tx, ring, id)).toBe(VALUE);
  });

  it("stores null when the hint is passed as null", async () => {
    const { tx, rows } = fakeTx();
    const id = await storeSecret(tx, ring, { kind: "env_var", ownerType: "environment", ownerId: "e1" }, VALUE, null);
    expect(rows.get(id)!.hint).toBeNull();
  });

  it("keeps an explicit hint for integration tokens shown in the UI", async () => {
    const { tx, rows } = fakeTx();
    const id = await storeSecret(tx, ring, { kind: "integration_token", ownerType: "integration", ownerId: "i1" }, VALUE, hintOf(VALUE));
    expect(rows.get(id)!.hint).toBe("WXYZ");
  });
});
