/**
 * A single address could keep a known user from signing in,
 * because every attempt from anywhere spent the per-email bucket before the password was checked.
 */
import { hash as argonHash } from "@node-rs/argon2";
import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import type { Ctx } from "./app.ts";
import { HttpError } from "./errors.ts";
import { RateLimits } from "./ratelimit.ts";
import { authHandlers } from "./routes/auth.ts";
import { testConfig, testRing } from "./test-helpers.ts";

const web = { origin: "https://dockify.test", secure: true };
const reply = () => ({ header() { return this; }, getHeader: () => undefined });
const req = (ip: string) => ({ clientIp: ip, headers: { "user-agent": "vitest" } });
const login = authHandlers["auth.login"] as (i: unknown) => Promise<unknown>;

async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    const r = (await p) as { next?: string };
    return `ok:${r.next}`;
  } catch (e) {
    return e instanceof HttpError ? e.code : String(e);
  }
}

describe("sign in under a password sprayer", () => {
  it("keeps the owner able to sign in from their own network while one address sprays their email", async () => {
    const password = "correct horse battery staple";
    // The owner has two-factor on, so a right password answers { next: "verify" } without a session.
    const owner = {
      id: "u1", email: "owner@example.com", name: "Owner", passwordHash: await argonHash(password),
      disabledAt: null, member: { role: "admin" }, totpConfirmedAt: new Date(), totpSecretId: "t1",
    };
    const db = {
      user: { findUnique: async ({ where }: { where: { email: string } }) => (where.email === owner.email ? owner : null) },
      activityLog: { create: async () => ({}) },
      loginChallenge: { findMany: async () => [], updateMany: async () => ({ count: 0 }), create: async () => ({}) },
    } as unknown as Db;
    const ctx = { db, ring: testRing(), config: testConfig(), web, limits: new RateLimits() } as unknown as Ctx;

    const sprayed: string[] = [];
    for (let i = 0; i < 12; i++) {
      sprayed.push(await outcome(login({ body: { email: owner.email, password: `guess-${i}` }, req: req("198.51.100.66"), reply: reply(), ctx })));
    }
    // Ten wrong guesses are judged; after that this network is refused for this account.
    expect(sprayed.slice(0, 10).every((c) => c === "INVALID_CREDENTIALS")).toBe(true);
    expect(sprayed.slice(10)).toEqual(["RATE_LIMITED", "RATE_LIMITED"]);

    // The owner, from their own network, is not locked out by any of that.
    expect(await outcome(login({ body: { email: "Owner@Example.com", password }, req: req("203.0.113.9"), reply: reply(), ctx }))).toBe("ok:verify");
    // And signing in repeatedly with the right password never runs them out.
    for (let i = 0; i < 15; i++) {
      expect(await outcome(login({ body: { email: owner.email, password }, req: req("203.0.113.9"), reply: reply(), ctx }))).toBe("ok:verify");
    }
  }, 60_000);
});
