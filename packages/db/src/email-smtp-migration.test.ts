import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 0021 on a real Postgres (PGlite, in process): every migration before it, the rows an
 * install from the Resend API days has, then the migration itself.
 */
const DIR = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));
const NAME = "0021_email_smtp";
const SECRET = "0f0e0d0c-0000-4000-8000-0000000000bb";
const script = (name: string) => readFileSync(`${DIR}${name}/migration.sql`, "utf8");

interface Row {
  config: Record<string, unknown>;
  status: string;
  error: string | null;
  secretId: string | null;
}

describe("0021: Resend rows become SMTP", () => {
  let db: PGlite;
  const email = async () => (await db.query<Row>(`SELECT config, status, error, "secretId" FROM integrations WHERE kind = 'email' AND name = 'default'`)).rows[0]!;
  const seed = async (config: unknown, o: { secretId?: string | null; status?: string; error?: string | null } = {}) => {
    await db.exec(`DELETE FROM integrations WHERE kind = 'email'`);
    const quoted = (v: string | null | undefined) => (v ? `'${v.replace(/'/g, "''")}'` : "NULL");
    await db.exec(`INSERT INTO integrations (id, kind, name, config, "secretId", status, error, "updatedAt") VALUES (gen_random_uuid(), 'email', 'default', ${quoted(JSON.stringify(config))}, ${quoted(o.secretId === undefined ? SECRET : o.secretId)}, '${o.status ?? "connected"}', ${quoted(o.error)}, now())`);
  };

  beforeAll(async () => {
    db = new PGlite();
    for (const name of readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
      if (name < NAME) await db.exec(script(name));
    }
    await db.exec(`INSERT INTO secrets (id, kind, "ownerType", "ownerId", "kekId", "wrappedDek", "dekNonce", ciphertext, "ctNonce", "updatedAt") VALUES ('${SECRET}', 'integration_token', 'integration', 'int1', 'k', decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex'), now())`);
  }, 120_000);

  it("converts a row and keeps its sealed key, from address, name and reply-to", async () => {
    await seed({ fromName: "Acme", fromAddress: "ops@acme.dev", replyTo: "help@acme.dev", domain: { name: "acme.dev", status: "verified", checkedAt: null } });
    await db.exec(script(NAME));
    const r = await email();
    expect(r.config).toEqual({ host: "smtp.resend.com", port: 465, tlsMode: "implicit", username: "resend", fromName: "Acme", fromAddress: "ops@acme.dev", replyTo: "help@acme.dev" });
    expect(r.secretId).toBe(SECRET);
    expect(r).toMatchObject({ status: "connected", error: null });
  });

  it("marks a row whose secret is missing, so its card asks for the password", async () => {
    await seed({ fromName: "Acme", fromAddress: "ops@acme.dev", replyTo: null, domain: null }, { secretId: null });
    await db.exec(script(NAME));
    const r = await email();
    expect(r.config).toMatchObject({ host: "smtp.resend.com", port: 465, username: "resend", fromAddress: "ops@acme.dev" });
    expect(r.secretId).toBeNull();
    expect(r.status).toBe("error");
    expect(r.error).toContain("password is missing");
  });

  it("rewords the old refusal, and leaves another error alone", async () => {
    await seed({ fromAddress: "ops@acme.dev" }, { status: "error", error: "Resend refused the stored API key" });
    await db.exec(script(NAME));
    expect(await email()).toMatchObject({ status: "error", error: "The mail server refused the stored username or password" });
    await seed({ fromAddress: "ops@acme.dev" }, { status: "error", error: "Something else" });
    await db.exec(script(NAME));
    expect((await email()).error).toBe("Something else");
  });

  it("leaves a converted or already SMTP row alone, so it is safe to replay", async () => {
    const smtp = { host: "smtp.example.com", port: 587, tlsMode: "starttls", username: "me", fromName: "Acme", fromAddress: "ops@acme.dev", replyTo: null };
    await seed(smtp);
    await db.exec(script(NAME));
    expect((await email()).config).toEqual(smtp);
  });

  it("touches no other integration", async () => {
    await db.exec(`INSERT INTO integrations (id, kind, name, config, "updatedAt") VALUES (gen_random_uuid(), 'vercel', 'default', '{"domain":"x"}', now())`);
    await db.exec(script(NAME));
    expect((await db.query<{ config: unknown }>(`SELECT config FROM integrations WHERE kind = 'vercel'`)).rows[0]!.config).toEqual({ domain: "x" });
  });
});
