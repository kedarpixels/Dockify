import { createDb, defaultServerId, type Db } from "@dockify/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetLink } from "./admin.ts";

const url = process.env.DATABASE_URL_TEST;

describe.skipIf(!url)("dockify admin reset-link (postgres)", () => {
  let db: Db;
  let id: string;
  beforeAll(async () => {
    db = createDb(url);
    id = await defaultServerId(db);
  });
  afterAll(async () => {
    await db.server.update({ where: { id }, data: { certPin: null } });
    await db.$disconnect();
  });

  it("forgets the agent's key and writes an activity row, so the join token can work again", async () => {
    await db.server.update({ where: { id }, data: { certPin: "PIN:OLD", joinTokenHash: "the old token's hash" } });
    expect(await resetLink(db)).toContain("dockify restart worker agent");
    const row = await db.server.findUniqueOrThrow({ where: { id } });
    expect(row.certPin).toBeNull();
    // Nothing joins on the old token: only what the worker offers from the new file, after its restart.
    expect(row.joinTokenHash).toBeNull();
    expect(await db.activityLog.count({ where: { action: "admin.reset-link" } })).toBeGreaterThan(0);
  });
});
