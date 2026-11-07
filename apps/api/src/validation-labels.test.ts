/**
 * A bad query string was reported under fields.body, and names
 * with a NUL (a 500), a direction override or a zero-width character were accepted.
 */
import { describe, expect, it } from "vitest";
import { auth as A, DisplayName, Empty, projects as P, UNSAFE_TEXT_MESSAGE } from "@dockify/contracts";
import type { Db } from "@dockify/db";
import { buildApp } from "./app.ts";
import { cookieName } from "./cookies.ts";
import { zodFields } from "./errors.ts";
import { testConfig, testRing } from "./test-helpers.ts";

const web = { origin: "https://dockify.test", secure: true };
const ch = (code: number) => String.fromCharCode(code);

describe("validation errors name the part of the request that failed", () => {
  it("labels a whole-query issue query, and keeps body for a body", () => {
    const err = Empty.safeParse({ stray: 1 }).error!;
    expect(Object.keys(zodFields(err, "querystring").fields)).toEqual(["query"]);
    expect(Object.keys(zodFields(err, "params").fields)).toEqual(["params"]);
    expect(Object.keys(zodFields(err).fields)).toEqual(["body"]);
  });

  it("answers an unknown query key with fields.query through the real app", async () => {
    const now = Date.now();
    const db = {
      session: {
        findUnique: async () => ({
          id: "s1", userId: "u1", revokedAt: null, elevatedUntil: null,
          expiresAt: new Date(now + 3600_000), absoluteExpiresAt: new Date(now + 7200_000), lastSeenAt: new Date(now),
          user: { name: "Owner", disabledAt: null, member: { role: "admin" } },
        }),
        update: async () => ({}),
        updateMany: async () => ({ count: 1 }),
      },
    } as unknown as Db;
    const { app } = await buildApp({ db, ring: testRing(), config: testConfig(), logger: false, integrations: false, workerWatch: false });
    const res = await app.inject({ method: "GET", url: "/api/v1/server/metrics?bogus=1", headers: { cookie: `${cookieName(web, "session")}=sid` } });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string; fields: Record<string, string> };
    expect(body.code).toBe("INVALID_REQUEST");
    expect(Object.keys(body.fields)).toEqual(["query"]);
    await app.close();
  });
});

describe("names refuse control, direction and invisible characters", () => {
  it("refuses a NUL, a C1 control, a right-to-left override, an isolate and zero-width characters", () => {
    for (const code of [0x00, 0x07, 0x1b, 0x85, 0x202e, 0x2066, 0x200b, 0x200d, 0x2060, 0xfeff, 0x061c, 0x2028]) {
      const r = DisplayName.safeParse(`Acme${ch(code)}Corp`);
      expect(r.success, code.toString(16)).toBe(false);
      expect(r.error?.issues[0]?.message).toBe(UNSAFE_TEXT_MESSAGE);
    }
  });

  it("keeps ordinary names, accents, other scripts and emoji", () => {
    for (const name of ["Acme Corp", "Café Zürich", "東京オフィス", "Ünïcödé & Sons, Ltd.", "Rocket 🚀"]) expect(DisplayName.safeParse(name).success, name).toBe(true);
  });

  it("applies to the names a person types: a project, a user, a status page title and its labels", () => {
    const bad = `Shop${ch(0x202e)}gnp.exe`;
    expect(P.NewProjectBody.shape.name.safeParse(bad).success).toBe(false);
    expect(P.ProjectPatchBody.safeParse({ name: bad }).success).toBe(false);
    expect(A.PatchMeBody.safeParse({ name: bad }).success).toBe(false);
    expect(P.StatusPagePatch.safeParse({ title: bad }).success).toBe(false);
    expect(P.StatusPagePatch.safeParse({ items: [{ appId: "0f0e0d0c-0000-4000-8000-000000000001", label: `API${ch(0x200b)}` }] }).success).toBe(false);
    expect(P.StatusPagePatch.safeParse({ title: "Acme status", items: [{ appId: "0f0e0d0c-0000-4000-8000-000000000001", label: "API" }] }).success).toBe(true);
  });
});
