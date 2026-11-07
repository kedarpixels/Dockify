/**
 * The reserved project slug: "new" is the web's New project address (/projects/new), so no project
 * may take it, whatever the name looks like before slugify. No database: the refusal comes first.
 */
import { describe, expect, it } from "vitest";
import { isReservedSlug, projects as P } from "@dockify/contracts";
import type { Actor } from "../../actor.ts";
import { HttpError } from "../../errors.ts";
import { noDb } from "../../test-helpers.ts";
import { projectsHandlers } from "./handlers.ts";

const session: Actor = { kind: "session", userId: "u1", name: "Owner", role: "admin", sessionId: "s1", elevated: false };
const create = (name: string) =>
  (projectsHandlers["projects.create"] as (i: unknown) => Promise<unknown>)({
    body: { repoUrl: "", name, defaultBranch: "main", environments: ["production"] },
    actor: session,
    req: { clientIp: "203.0.113.9", headers: { "user-agent": "vitest" } },
    ctx: { db: noDb() },
  });

async function rejects(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error("expected a rejection");
}

const body = (name: string) => ({ repoUrl: "", name, defaultBranch: "main", environments: ["production"] });

describe("reserved project slugs", () => {
  it("lists new, case and space insensitive", () => {
    expect(isReservedSlug("new")).toBe(true);
    expect(isReservedSlug(" New ")).toBe(true);
    expect(isReservedSlug("news")).toBe(false);
    expect(isReservedSlug("new-app")).toBe(false);
  });

  it("refuses the name in the contract", () => {
    expect(P.NewProjectBody.safeParse(body("new")).success).toBe(false);
    expect(P.NewProjectBody.safeParse(body("NEW")).success).toBe(false);
    expect(P.NewProjectBody.safeParse(body("newsroom")).success).toBe(true);
  });

  it("refuses a name that only slugifies to new, before the database is touched", async () => {
    expect(await rejects(create("New!"))).toMatchObject({ status: 400, code: "RESERVED_SLUG" });
    expect(await rejects(create("  ~new~  "))).toMatchObject({ status: 400, code: "RESERVED_SLUG" });
  });
});

describe("a new project's branch", () => {
  /** A database that records the project row and answers the instance's default branch. */
  const fakeDb = (instanceBranch: string) => {
    const made: Array<{ defaultBranch: string; environments: { create: Array<{ name: string; branch: string }> } }> = [];
    const any = (model: string) =>
      new Proxy({}, {
        get: (_t, method: string) => async (args: { data?: unknown }) => {
          if (model === "project" && method === "findFirst") return null;
          if (model === "instance" && method === "findUnique") return { defaultBranch: instanceBranch };
          if (model === "project" && method === "create") made.push(args.data as (typeof made)[number]);
          return { id: "00000000-0000-4000-8000-000000000001" };
        },
      });
    const db: Record<string, unknown> = new Proxy({}, { get: (_t, model: string) => (model === "$transaction" ? (fn: (tx: unknown) => unknown) => fn(db) : any(model)) });
    return { db, made };
  };
  const run = (db: unknown, extra: Record<string, unknown>) =>
    (projectsHandlers["projects.create"] as (i: unknown) => Promise<unknown>)({
      body: { repoUrl: "", name: "Shop", environments: ["production", "dev"], ...extra },
      actor: session,
      req: { clientIp: "203.0.113.9", headers: { "user-agent": "vitest" } },
      ctx: { db },
    });

  it("is the instance's default branch when the request names none", async () => {
    const { db, made } = fakeDb("trunk");
    expect(P.NewProjectBody.safeParse({ repoUrl: "", name: "Shop", environments: ["production"] }).success).toBe(true);
    await run(db, {});
    expect(made[0]?.defaultBranch).toBe("trunk");
    expect(made[0]?.environments.create.map((e) => e.branch)).toEqual(["trunk", "trunk"]);
  });

  it("is the one the request names, when it names one", async () => {
    const { db, made } = fakeDb("trunk");
    await run(db, { defaultBranch: "release" });
    expect(made[0]?.defaultBranch).toBe("release");
  });
});
