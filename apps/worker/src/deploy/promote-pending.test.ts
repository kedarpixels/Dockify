import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, defaultServerId, type Db } from "@dockify/db";
import { promotePending } from "./pipeline.ts";

/** A push coalesced during a deploy (App.pendingDeployAt) and what may hold it back. Needs DATABASE_URL_TEST. */
const url = process.env.DATABASE_URL_TEST;

describe.skipIf(!url)("promotePending (postgres)", () => {
  let db: Db;
  let serverId: string;
  const SLUG = "promote-pending-test";

  beforeAll(async () => {
    db = createDb(url);
    serverId = await defaultServerId(db);
  });
  afterAll(async () => {
    await db?.project.deleteMany({ where: { slug: SLUG } });
    await db?.$disconnect();
  });
  beforeEach(async () => {
    await db.project.deleteMany({ where: { slug: SLUG } });
  });

  const seed = async () => {
    const p = await db.project.create({ data: { slug: SLUG, name: SLUG } });
    const env = await db.environment.create({ data: { projectId: p.id, name: "production", branch: "main" } });
    const app = await db.app.create({ data: { environmentId: env.id, serverId, name: "web", kind: "frontend", gitRepository: "https://github.com/a/b", port: 3000, desiredState: "running", pendingDeployAt: new Date() } });
    return { p, env, app };
  };

  it("promotes the push while a preview of the same app is in flight", async () => {
    const { p, env, app } = await seed();
    const penv = await db.previewEnv.create({ data: { projectId: p.id, prNumber: 1, baseEnvironmentId: env.id, title: "t", branch: "x", domain: "p.example.com", repo: "a/b", repoKey: "github.com/a/b", status: "building", lastCommitAt: new Date() } });
    const pd = await db.previewDeployment.create({ data: { envId: penv.id, appId: app.id, hostname: "pr-1.p.example.com" } });
    await db.deployment.create({ data: { appId: app.id, serverId, previewId: pd.id, trigger: "preview", status: "queued", actorType: "webhook", steps: [] } });

    const id = await promotePending(db, app.id);
    expect(id).not.toBeNull();
    expect((await db.app.findUniqueOrThrow({ where: { id: app.id } })).pendingDeployAt).toBeNull();
    expect(await db.job.count({ where: { dedupeKey: `deploy:${app.id}` } })).toBe(1);
    await db.job.deleteMany({ where: { dedupeKey: `deploy:${app.id}` } });
  });

  it("still waits for a production deploy in flight", async () => {
    const { app } = await seed();
    await db.deployment.create({ data: { appId: app.id, serverId, trigger: "push", status: "deploying", actorType: "webhook", steps: [] } });
    expect(await promotePending(db, app.id)).toBeNull();
    expect((await db.app.findUniqueOrThrow({ where: { id: app.id } })).pendingDeployAt).not.toBeNull();
  });
});
