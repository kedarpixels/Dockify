import { describe, expect, it } from "vitest";
import type { Db, SecretVault } from "@dockify/db";
import type { HttpClient, HttpRequest, HttpResponse } from "@dockify/net-guard";
import { runVercelMirror } from "./vercel-mirror.ts";
import { FOLLOW_ONLY, runVercelSync, VercelJobError } from "./vercel-target.ts";

/** A followed app: whatever job reaches the worker, nothing but a read ever goes to Vercel. */

const res = (status: number, body: unknown = {}): HttpResponse => ({ status, headers: {}, body: Buffer.from(JSON.stringify(body)) });
const vault = { open: async (_t: unknown, ids: string[]) => new Map(ids.map((i) => [i, "the-token"])) } as unknown as SecretVault;

function harness(appOver: Record<string, unknown>, flip?: { afterCalls: number }, ends?: string) {
  const calls: HttpRequest[] = [];
  const app: Record<string, unknown> = {
    id: "a1", deployTarget: "vercel", vercelProjectId: "prj_1", vercelFollowOnly: false, gitBranch: null,
    environment: { name: "production", branch: "main", project: { gitRepoId: "42" } }, ...appOver,
  };
  const rows: Array<Record<string, unknown>> = [{ id: "d1", status: "queued" }];
  const integration = { id: "i1", kind: "vercel", name: "default", status: "connected", secretId: "s1", config: {} };
  const tx = {
    $executeRaw: async () => 0,
    integration: { findUnique: async () => integration, update: async () => integration },
    deployment: {
      findMany: async () => [],
      updateMany: async ({ data }: { data: Record<string, unknown> }) => (Object.assign(rows[0]!, data), { count: 1 }),
      create: async () => ({}),
      update: async () => ({}),
      deleteMany: async () => ({ count: 0 }),
    },
  };
  const db = {
    ...tx,
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
    app: {
      findUnique: async () => app,
      findMany: async () => (app.deployTarget === "vercel" ? [app] : []),
      updateMany: async () => ({ count: 1 }),
    },
    job: { findFirst: async () => null },
  };
  const http: HttpClient = async (r) => {
    calls.push(r);
    if (flip && calls.length >= flip.afterCalls) app.vercelFollowOnly = true;
    if (r.url.includes("/v7/deployments")) return res(200, { deployments: [{ uid: "dpl_1", readyState: "READY", created: 1, url: "x.vercel.app" }] });
    if (r.method === "POST") return res(200, { id: "dpl_new", url: "x.vercel.app", readyState: ends ?? "READY" });
    return res(200, { name: "web" });
  };
  return { db: db as unknown as Db, http, calls, rows };
}

const sync = (h: ReturnType<typeof harness>, payload: unknown) => runVercelSync({ db: h.db, vault, http: h.http, resolveEnv: async () => ({ SECRET: "value" }) }, payload, new AbortController().signal);

describe("a followed app in the worker", () => {
  for (const payload of [{ appId: "a1", action: "sync_env" }, { appId: "a1", action: "deploy", deploymentId: "d1" }, { appId: "a1", action: "status", vercelDeploymentId: "dpl_1" }]) {
    it(`makes no call at all for a ${payload.action} job, and the job does not retry`, async () => {
      const h = harness({ vercelFollowOnly: true });
      const e = await sync(h, payload).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(VercelJobError);
      expect((e as VercelJobError).permanent).toBe(true);
      expect(h.calls).toEqual([]);
    });
  }

  it("settles a deployment row a queued job held, saying nothing was sent", async () => {
    const h = harness({ vercelFollowOnly: true });
    await sync(h, { appId: "a1", action: "deploy", deploymentId: "d1" }).catch(() => undefined);
    expect(h.rows[0]).toMatchObject({ status: "cancelled", error: FOLLOW_ONLY });
  });

  it("stops before the next write when the app is switched to follow while the job runs", async () => {
    // The env push is the first call; the switch lands right after it, so the project read comes
    // back and the deploy request must not go.
    const h = harness({}, { afterCalls: 1 });
    await sync(h, { appId: "a1", action: "deploy", deploymentId: "d1" }).catch(() => undefined);
    expect(h.calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([expect.stringContaining("/env?upsert=true")]);
    expect(h.calls.some((c) => c.url.includes("/v13/deployments"))).toBe(false);
  });

  it("still sends for a deploy target: the guard is only for followed apps", async () => {
    const h = harness({});
    await sync(h, { appId: "a1", action: "deploy" });
    expect(h.calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("a deploy target's build cancelled on Vercel reads cancelled, so no failure alert follows; an error reads failed", async () => {
    const cancelled = harness({}, undefined, "CANCELED");
    await sync(cancelled, { appId: "a1", action: "deploy", deploymentId: "d1" });
    expect(cancelled.rows[0]).toMatchObject({ status: "cancelled" });
    const failed = harness({}, undefined, "ERROR");
    await expect(sync(failed, { appId: "a1", action: "deploy", deploymentId: "d1" })).rejects.toBeInstanceOf(VercelJobError);
    expect(failed.rows[0]).toMatchObject({ status: "failed" });
  });

  it("deploys from the repository id on the app, which is the one the dashboard stores", async () => {
    const h = harness({ gitRepoId: "77", environment: { name: "production", branch: "main", project: { gitRepoId: null } } });
    await sync(h, { appId: "a1", action: "deploy", deploymentId: "d1" });
    const deploy = h.calls.find((c) => c.url.includes("/v13/deployments") && c.method === "POST");
    expect(String(deploy?.body)).toContain('"repoId":"77"');
  });

  it("the app's repository id wins over the project's", async () => {
    const h = harness({ gitRepoId: "77" });
    await sync(h, { appId: "a1", action: "deploy", deploymentId: "d1" });
    expect(String(h.calls.find((c) => c.url.includes("/v13/deployments") && c.method === "POST")?.body)).toContain('"repoId":"77"');
  });

  it("with no repository id anywhere a deploy fails for good and sends nothing, secrets included", async () => {
    const h = harness({ gitRepoId: null, environment: { name: "production", branch: "main", project: { gitRepoId: null } } });
    const e = await sync(h, { appId: "a1", action: "deploy", deploymentId: "d1" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(VercelJobError);
    expect((e as VercelJobError).permanent).toBe(true);
    expect(h.calls).toEqual([]);
    expect(h.rows[0]).toMatchObject({ status: "failed" });
  });

  it("an env push alone needs no repository id", async () => {
    const h = harness({ gitRepoId: null, environment: { name: "production", branch: "main", project: { gitRepoId: null } } });
    await sync(h, { appId: "a1", action: "sync_env" });
    expect(h.calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([expect.stringContaining("/env?upsert=true")]);
  });

  it("gets the mirror, with reads only", async () => {
    const h = harness({ vercelFollowOnly: true });
    await runVercelMirror({ db: h.db, vault, http: h.http, retentionDays: 90, now: () => new Date("2026-11-06T00:00:00.000Z") }, {});
    expect(h.calls.length).toBeGreaterThan(0);
    expect(h.calls.every((c) => c.method === "GET")).toBe(true);
    expect(h.calls.every((c) => c.body === undefined)).toBe(true);
  });
});
