import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { githubAppJwt } from "@dockify/crypto";
import type { Tx } from "@dockify/db";
import { testRing } from "../../../test-helpers.ts";
import { seedEmailFromEnv } from "../email.ts";
import { buildManifest, manifestAppName, consumeInstallState, installUrl, memoryStateStore, safeAppHtmlUrl, seedGitHubAppFromEnv, signInstallState, verifyGitHubSignature, webhookPayloadText } from "./app.ts";

const sign = (secret: string, body: Buffer) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("the App's default name", () => {
  const valid = /^[a-z0-9](?:[a-z0-9-]{0,32}[a-z0-9])?$/;
  it("is clean, valid and carries a word only when the host offers one", () => {
    expect(manifestAppName("https://dash.acme.dev")).toMatch(/^dockify-acme-[0-9a-f]{6}$/);
    expect(manifestAppName("https://acme.dev")).toMatch(/^dockify-acme-[0-9a-f]{6}$/);
    // The name seen live: the host repeated "dockify" and was cut mid word.
    expect(manifestAppName("https://dockify.203-0-113-10.sslip.io")).toMatch(/^dockify-[0-9a-f]{6}$/);
    expect(manifestAppName("https://1-2-3-4.nip.io")).toMatch(/^dockify-[0-9a-f]{6}$/);
    expect(manifestAppName("https://203.0.113.9")).toMatch(/^dockify-[0-9a-f]{6}$/);
    expect(manifestAppName("https://localhost:3000")).toMatch(/^dockify-[0-9a-f]{6}$/);
    for (const o of ["https://a-very-long-company-name-indeed-yes.example.com", "https://xn--bcher-kva.example", "https://x--.example.com"]) {
      const n = manifestAppName(o);
      expect(n.length, n).toBeLessThanOrEqual(34);
      expect(n, n).toMatch(valid);
    }
  });
  it("differs between hosts and stays the same for one", () => {
    expect(manifestAppName("https://dash.acme.dev")).toBe(manifestAppName("https://dash.acme.dev/"));
    expect(manifestAppName("https://dash.acme.dev")).not.toBe(manifestAppName("https://dash.acme.io"));
    expect(buildManifest("https://dash.acme.dev").name).toBe(manifestAppName("https://dash.acme.dev"));
  });
});

describe("verifyGitHubSignature (ported)", () => {
  const body = Buffer.from('{"zen":"Keep it logically awesome."}');
  it("accepts the MAC over the raw bytes", () => expect(verifyGitHubSignature("s3cret", body, sign("s3cret", body))).toBe(true));
  it("refuses another secret, another body, sha1, junk and absence", () => {
    expect(verifyGitHubSignature("other", body, sign("s3cret", body))).toBe(false);
    expect(verifyGitHubSignature("s3cret", Buffer.from('{"zen": "Keep it logically awesome."}'), sign("s3cret", body))).toBe(false);
    expect(verifyGitHubSignature("s3cret", body, `sha1=${createHmac("sha1", "s3cret").update(body).digest("hex")}`)).toBe(false);
    expect(verifyGitHubSignature("s3cret", body, "sha256=xyz")).toBe(false);
    expect(verifyGitHubSignature("s3cret", body, undefined)).toBe(false);
    expect(verifyGitHubSignature("s3cret", body, [sign("s3cret", body)])).toBe(false);
  });
});

describe("install state", () => {
  const ring = testRing();
  it("round trips once, for the session that minted it", () => {
    const store = memoryStateStore();
    const s = signInstallState(ring, store, "session-a");
    expect(consumeInstallState(ring, store, s)).toBe("session-a");
    expect(consumeInstallState(ring, store, s)).toBeNull();
  });
  it("refuses an expired, tampered or foreign state", () => {
    const store = memoryStateStore();
    const now = Date.now();
    const old = signInstallState(ring, store, "s", now - 11 * 60_000);
    expect(consumeInstallState(ring, store, old, now)).toBeNull();
    const s = signInstallState(ring, store, "s");
    const [body, mac] = s.split(".");
    expect(consumeInstallState(ring, store, `${body}x.${mac}`)).toBeNull();
    expect(consumeInstallState(ring, memoryStateStore(), s)).toBeNull();
    expect(consumeInstallState(ring, store, "garbage")).toBeNull();
  });
  it("puts it in the install URL", () => {
    expect(installUrl("dockify-box", "a.b")).toBe("https://github.com/apps/dockify-box/installations/new?state=a.b");
  });
});

describe("githubAppJwt", () => {
  it("is an RS256 JWT for the App id, backdated and short", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const jwt = githubAppJwt(pem, 42, 1_700_000_000);
    const [h, p, sig] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toEqual({ iat: 1_700_000_000 - 60, exp: 1_700_000_000 + 540, iss: 42 });
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, sig, "base64url")).toBe(true);
  });
});

describe("manifest and helpers", () => {
  it("asks for least privilege and the two events previews and deploys need", () => {
    const m = buildManifest("https://dockify.example.com") as { default_permissions: Record<string, string>; default_events: string[]; hook_attributes: { url: string } };
    expect(m.default_permissions).toEqual({ contents: "read", metadata: "read", pull_requests: "write", statuses: "write" });
    expect(m.default_events).toEqual(["push", "pull_request"]);
    expect(m.hook_attributes.url).toBe("https://dockify.example.com/api/v1/webhooks/github");
  });
  it("only trusts github.com for the App page", () => {
    expect(safeAppHtmlUrl("https://evil.example/apps/x", "x")).toBe("https://github.com/apps/x");
    expect(safeAppHtmlUrl("https://github.com/apps/x", "x")).toBe("https://github.com/apps/x");
  });
  it("reads both hook content types", () => {
    expect(webhookPayloadText("application/json", Buffer.from("{}"))).toBe("{}");
    expect(webhookPayloadText("application/x-www-form-urlencoded", Buffer.from("payload=%7B%22a%22%3A1%7D"))).toBe('{"a":1}');
    expect(webhookPayloadText("application/x-www-form-urlencoded", Buffer.from("other=1"))).toBeNull();
  });
});

describe("seeding from the installer's environment", () => {
  const env = {
    DOCKIFY_GITHUB_APP_ID: "12345", DOCKIFY_GITHUB_APP_SLUG: "dockify-box",
    DOCKIFY_GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----", DOCKIFY_GITHUB_WEBHOOK_SECRET: "hook",
    DOCKIFY_SMTP_HOST: "smtp.resend.com", DOCKIFY_SMTP_PORT: "2465", DOCKIFY_SMTP_USER: "resend", DOCKIFY_SMTP_PASSWORD: "re_live_abcdefghijk", DOCKIFY_EMAIL_FROM: "ops@acme.dev",
  } as NodeJS.ProcessEnv;
  function fakeDb(setupCompletedAt: Date | null) {
    const created: string[] = [];
    const rows: Array<{ kind: string; config?: unknown }> = [];
    const db = {
      instance: { findUnique: async () => ({ setupCompletedAt }) },
      integration: {
        findUnique: async () => null,
        create: async ({ data }: { data: { kind: string; config?: unknown } }) => (created.push(data.kind), rows.push(data), { id: `int-${data.kind}`, ...data }),
        update: async () => ({}),
      },
      secret: { create: async ({ data }: { data: object }) => ({ id: "sec", ...data }) },
    };
    return { db: db as unknown as Tx, created, rows };
  }

  it("creates the rows before setup completes", async () => {
    const { db, created } = fakeDb(null);
    expect(await seedGitHubAppFromEnv(db, testRing(), env)).toBe(true);
    expect(await seedEmailFromEnv(db, testRing(), env)).toBe(true);
    expect(created).toEqual(["github_app", "email"]);
  });

  it("seeds email as SMTP, with the TLS mode its port uses and no password in the config", async () => {
    const { db, rows } = fakeDb(null);
    expect(await seedEmailFromEnv(db, testRing(), env)).toBe(true);
    expect(rows[0]!.config).toEqual({ host: "smtp.resend.com", port: 2465, tlsMode: "implicit", username: "resend", fromName: "Dockify", fromAddress: "ops@acme.dev", replyTo: null });
    const starttls = fakeDb(null);
    expect(await seedEmailFromEnv(starttls.db, testRing(), { ...env, DOCKIFY_SMTP_PORT: "587" })).toBe(true);
    expect(starttls.rows[0]!.config).toMatchObject({ port: 587, tlsMode: "starttls" });
  });

  it.each([
    ["no host", { DOCKIFY_SMTP_HOST: "" }], ["no user", { DOCKIFY_SMTP_USER: "" }], ["no password", { DOCKIFY_SMTP_PASSWORD: "" }], ["no from address", { DOCKIFY_EMAIL_FROM: "" }],
    ["another port", { DOCKIFY_SMTP_PORT: "22" }], ["a private host", { DOCKIFY_SMTP_HOST: "smtp.internal" }], ["an address as host", { DOCKIFY_SMTP_HOST: "10.0.0.1" }], ["this server's name", { DOCKIFY_SMTP_HOST: "dash.acme.dev", DOCKIFY_PUBLIC_URL: "https://dash.acme.dev" }],
  ])("seeds nothing with %s", async (_what, over) => {
    const { db, created } = fakeDb(null);
    expect(await seedEmailFromEnv(db, testRing(), { ...env, ...over } as NodeJS.ProcessEnv)).toBe(false);
    expect(created).toEqual([]);
  });

  it("never brings back an integration the owner disconnected after setup", async () => {
    const { db, created } = fakeDb(new Date());
    expect(await seedGitHubAppFromEnv(db, testRing(), env)).toBe(false);
    expect(await seedEmailFromEnv(db, testRing(), env)).toBe(false);
    expect(created).toEqual([]);
  });
});
