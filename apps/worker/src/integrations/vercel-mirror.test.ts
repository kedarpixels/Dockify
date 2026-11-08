import { describe, expect, it } from "vitest";
import type { Db, SecretVault } from "@dockify/db";
import type { HttpClient, HttpResponse } from "@dockify/net-guard";
import { httpsOfHost, safeInspectorUrl } from "./vercel-host.ts";
import { mapDeploymentState, NOT_FOLLOWED, pickApp, queueVercelMirrorIfDue, REMOVED_ACTION, rowFieldsOf, runVercelMirror, statusFor, VercelMirrorError, type LinkedApp, type VercelDeployment } from "./vercel-mirror.ts";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const res = (status: number, body: unknown = {}): HttpResponse => ({ status, headers: {}, body: Buffer.from(JSON.stringify(body)) });
const ms = (s: string) => Date.parse(s);

const dpl = (over: Partial<VercelDeployment> = {}): VercelDeployment => ({
  uid: "dpl_1", url: "web-abc.vercel.app", inspectorUrl: "https://vercel.com/acme/web/abc", created: ms("2026-11-06T11:00:00.000Z"), buildingAt: ms("2026-11-06T11:00:05.000Z"),
  ready: ms("2026-11-06T11:01:00.000Z"), readyState: "READY", target: "production", source: "git", creator: { username: "sam", githubLogin: "Sam" },
  meta: { githubCommitSha: "a".repeat(40), githubCommitRef: "main", githubCommitMessage: "ship it\n\nlong body" },
  ...over,
});

describe("mapping Vercel's record", () => {
  it("maps every state Vercel documents", () => {
    const want: Record<string, string> = { READY: "ready", ERROR: "failed", CANCELED: "cancelled", DELETED: "cancelled", BUILDING: "building", INITIALIZING: "building", QUEUED: "queued", BLOCKED: "queued" };
    for (const [s, status] of Object.entries(want)) expect(mapDeploymentState(s), s).toBe(status);
    expect(mapDeploymentState(undefined)).toBe("queued");
  });

  it("reads the fields a row shows, with the first line of the message", () => {
    expect(rowFieldsOf(dpl(), null, NOW)).toMatchObject({
      status: "ready", commitSha: "a".repeat(40), branch: "main", message: "ship it", externalUrl: "https://web-abc.vercel.app", inspectorUrl: "https://vercel.com/acme/web/abc",
      externalTarget: "production", externalSource: "git", externalCreator: "sam", trigger: "push", actorType: "webhook", gitAuthor: "sam",
      createdAt: new Date("2026-11-06T11:00:00.000Z"), finishedAt: new Date("2026-11-06T11:01:00.000Z"), error: null,
    });
  });

  it("reads anything but production as a preview, and a CLI deploy as started by its account", () => {
    const f = rowFieldsOf(dpl({ target: null, source: "cli", creator: { username: "ci" }, meta: {} }), null, NOW);
    expect(f).toMatchObject({ externalTarget: "preview", trigger: "api", actorType: "system", actorName: "ci", gitAuthor: null, commitSha: null, branch: null });
    expect(rowFieldsOf(dpl({ target: "staging" }), null, NOW).externalTarget).toBe("preview");
  });

  it("says why it failed, with no control characters from the outside", () => {
    expect(rowFieldsOf(dpl({ readyState: "ERROR", errorMessage: `Build${String.fromCharCode(0)}failed${String.fromCharCode(0x202e)}` }), null, NOW)).toMatchObject({ status: "failed", error: "Build failed" });
    expect(rowFieldsOf(dpl({ readyState: "ERROR" }), null, NOW).error).toBe("Vercel reports this deployment failed");
  });

  it("has no finish time while in flight, and keeps one it already has", () => {
    expect(rowFieldsOf(dpl({ readyState: "BUILDING", ready: null }), null, NOW).finishedAt).toBeNull();
    const at = new Date("2026-11-06T11:30:00.000Z");
    expect(rowFieldsOf(dpl({ readyState: "ERROR", ready: null }), { finishedAt: at }, NOW).finishedAt).toEqual(at);
    expect(rowFieldsOf(dpl({ readyState: "ERROR", ready: null }), { finishedAt: null }, NOW).finishedAt).toEqual(NOW);
  });

  it("makes links only of what it can vouch for", () => {
    expect(httpsOfHost("web-abc.vercel.app")).toBe("https://web-abc.vercel.app");
    for (const bad of ["javascript:alert(1)", "evil.com/path", "http://x.vercel.app", "", null]) expect(httpsOfHost(bad), String(bad)).toBeNull();
    expect(safeInspectorUrl("https://vercel.com/acme/web/abc")).toBe("https://vercel.com/acme/web/abc");
    for (const bad of ["http://vercel.com/a", "https://vercel.com.evil.io/a", "https://user:pw@vercel.com/a", "javascript:alert(1)", null]) expect(safeInspectorUrl(bad), String(bad)).toBeNull();
  });
});

describe("pickApp", () => {
  const prod: LinkedApp = { id: "p", environment: "production", branch: "main", serverId: "s1" };
  const dev: LinkedApp = { id: "d", environment: "dev", branch: "dev", serverId: "s1" };
  const stage: LinkedApp = { id: "s", environment: "staging", branch: "stage", serverId: "s1" };

  it("shows production and previews on an app linked alone", () => {
    expect(pickApp([prod], { target: "production", branch: "main" })?.id).toBe("p");
    expect(pickApp([prod], { target: "preview", branch: "feature" })?.id).toBe("p");
    expect(pickApp([dev], { target: "production", branch: "main" })?.id).toBe("d");
  });

  it("splits a shared project by environment, then by branch", () => {
    const all = [prod, dev, stage];
    expect(pickApp(all, { target: "production", branch: "main" })?.id).toBe("p");
    expect(pickApp(all, { target: "preview", branch: "stage" })?.id).toBe("s");
    expect(pickApp(all, { target: "preview", branch: "feature" })?.id).toBe("d");
  });

  it("has nowhere to put a deployment with no link", () => expect(pickApp([], { target: "production", branch: null })).toBeNull());
});

describe("statusFor", () => {
  const r = (status: "ready" | "failed" | "building" | "cancelled", externalTarget: "production" | "preview" | null = "production") => ({ status, externalTarget });
  it("reads deploying, running and failed, and leaves the app alone with nothing to say", () => {
    expect(statusFor([r("building"), r("ready")], true, true)).toBe("deploying");
    expect(statusFor([r("ready")], true, true)).toBe("running");
    expect(statusFor([r("failed")], true, false)).toBe("failed");
    expect(statusFor([r("failed"), r("ready")], true, true)).toBe("running");
    expect(statusFor([], true, false)).toBeNull();
  });
  it("does not let a preview build move a production app", () => {
    expect(statusFor([r("building", "preview"), r("ready")], true, true)).toBe("running");
    expect(statusFor([r("building", "preview"), r("ready", "preview")], false, true)).toBe("deploying");
  });
});

type Row = Record<string, unknown> & { id: string; externalId: string | null };

type QueuedJob = Record<string, unknown> & { dedupeKey: string };

function harness(opts: { deployments?: Row[]; apps?: Array<Record<string, unknown>>; config?: Record<string, unknown>; jobs?: QueuedJob[] } = {}) {
  const rows: Row[] = opts.deployments ?? [];
  const jobs: QueuedJob[] = opts.jobs ?? [];
  const updates: Array<Record<string, unknown>> = [];
  const appUpdates: Array<Record<string, unknown>> = [];
  const activity: Array<Record<string, unknown>> = [];
  const integration = { id: "i1", kind: "vercel", name: "default", status: "connected", secretId: "s1", config: { team: { id: "team_1" }, ...opts.config } };
  const matches = (r: Row, where: Record<string, unknown>) => {
    if (typeof where.id === "string" && r.id !== where.id) return false;
    const inList = (v: unknown) => (v as { in?: unknown[] })?.in;
    if (inList(where.externalId) && !inList(where.externalId)!.includes(r.externalId)) return false;
    if (where.externalId === null && r.externalId !== null) return false;
    const notIn = (where.status as { notIn?: unknown[] } | undefined)?.notIn;
    if (notIn && notIn.includes(r.status)) return false;
    if (inList(where.appId) && !inList(where.appId)!.includes(r.appId)) return false;
    if (typeof where.appId === "string" && r.appId !== where.appId) return false;
    if (typeof where.status === "string" && r.status !== where.status) return false;
    const after = (where.finishedAt as { gt?: Date } | undefined)?.gt;
    if (after && !(r.finishedAt instanceof Date && r.finishedAt > after)) return false;
    if (inList(where.id) && !inList(where.id)!.includes(r.id)) return false;
    if (typeof where.externalId === "string" && r.externalId !== where.externalId) return false;
    if (where.previewId === null && (r.previewId ?? null) !== null) return false;
    if (typeof where.provider === "string" && (r.provider ?? "vercel") !== where.provider) return false;
    const actorNotIn = (where.actorType as { notIn?: unknown[] } | undefined)?.notIn;
    if (actorNotIn && actorNotIn.includes(r.actorType)) return false;
    const created = where.createdAt as { gt?: Date; gte?: Date } | undefined;
    if (created?.gt && !(Number(r.createdAt) > Number(created.gt))) return false;
    if (created?.gte && !(Number(r.createdAt) >= Number(created.gte))) return false;
    return true;
  };
  const tx = {
    $executeRaw: async () => 0,
    integration: {
      findUnique: async () => integration,
      update: async ({ data }: { data: { config: Record<string, unknown> } }) => (integration.config = data.config as typeof integration.config),
    },
    // A job row of any age stays, as in the real table, and a job in `jobs` outlives this harness's pass.
    job: {
      findFirst: async ({ where }: { where: { dedupeKey: string } }) => jobs.find((j) => j.dedupeKey === where.dedupeKey) ?? null,
      create: async ({ data }: { data: Record<string, unknown> & { dedupeKey: string } }) => (jobs.push(data), { id: `j${jobs.length}` }),
    },
  };
  // One transaction at a time, standing in for the advisory lock the real ones take.
  let locked: Promise<unknown> = Promise.resolve();
  const db = {
    ...tx,
    $transaction: <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => {
      const run = locked.then(() => fn(tx));
      locked = run.catch(() => undefined);
      return run;
    },
    app: {
      findMany: async () => opts.apps ?? [{ id: "a1", vercelProjectId: "prj_1", gitBranch: null, environment: { name: "production", branch: "main" } }],
      updateMany: async ({ data }: { data: Record<string, unknown> }) => (appUpdates.push(data), { count: 1 }),
      count: async () => (opts.apps ?? [1]).length,
    },
    deployment: {
      findMany: async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: unknown }) => {
        const out = rows.filter((r) => matches(r, where));
        return orderBy ? [...out].sort((a, b) => Number(b.createdAt) - Number(a.createdAt)) : out;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(data);
        return Object.assign(rows.find((r) => r.id === where.id) ?? {}, data);
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if ((where.app as object | undefined) !== undefined) return { count: 0 };
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (rows.some((r) => r.externalId === data.externalId)) throw Object.assign(new Error("dup"), { code: "P2002" });
        const row = { id: `new-${rows.length}`, ...data } as Row;
        rows.push(row);
        return row;
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) rows.splice(rows.indexOf(r), 1);
        return { count: hit.length };
      },
      count: async () => rows.filter((r) => matches(r, { status: { notIn: ["ready", "failed", "cancelled"] } })).length,
    },
    activityLog: { create: async ({ data }: { data: Record<string, unknown> }) => (activity.push(data), data) },
  };
  return { db: db as unknown as Db, rows, updates, appUpdates, integration, jobs, activity };
}

const vault: SecretVault = { open: async (_tx: unknown, ids: string[]) => new Map(ids.map((i) => [i, "the-token"])) } as unknown as SecretVault;

function vercel(list: VercelDeployment[], over: { project?: unknown; one?: (id: string) => HttpResponse; status?: number } = {}) {
  const calls: Array<{ method: string; url: string; auth?: string | undefined }> = [];
  const http: HttpClient = async (r) => {
    calls.push({ method: r.method, url: r.url, auth: r.headers?.Authorization });
    if (over.status) return res(over.status);
    if (r.url.includes("/v7/deployments")) return res(200, { deployments: list, pagination: {} });
    if (r.url.includes("/v13/deployments/")) return over.one ? over.one(r.url) : res(404);
    if (r.url.includes("/v9/projects/")) return res(200, over.project ?? {});
    return res(404);
  };
  return { http, calls };
}

const deps = (db: Db, http: HttpClient) => ({ db, vault, http, retentionDays: 90, now: () => NOW });

describe("runVercelMirror", () => {
  it("only reads Vercel, in the team, and adds a row per deployment with both targets", async () => {
    const h = harness();
    const v = vercel([dpl(), dpl({ uid: "dpl_2", target: null, meta: { githubCommitRef: "feature" }, ready: null, readyState: "BUILDING" })]);
    await runVercelMirror(deps(h.db, v.http), {});
    expect(v.calls.every((c) => c.method === "GET")).toBe(true);
    expect(v.calls[0]!.url).toContain("/v7/deployments?projectId=prj_1&limit=50&since=");
    expect(v.calls[0]!.url).toContain("teamId=team_1");
    expect(v.calls[0]!.auth).toBe("Bearer the-token");
    expect(h.rows.map((r) => [r.externalId, r.provider, r.appId, r.externalTarget])).toEqual([["dpl_1", "vercel", "a1", "production"], ["dpl_2", "vercel", "a1", "preview"]]);
    expect(h.integration.config).toMatchObject({ mirror: { syncedAt: NOW.toISOString(), error: null } });
  });

  it("updates a row it already has instead of adding one, and keeps who started a deploy from here", async () => {
    const h = harness({ deployments: [{ id: "d1", appId: "a1", provider: "vercel", externalId: "dpl_1", status: "building", actorType: "user", actorName: "Sam", finishedAt: null, createdAt: 1 }] });
    await runVercelMirror(deps(h.db, vercel([dpl()]).http), {});
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ status: "ready", actorType: "user", actorName: "Sam", commitSha: "a".repeat(40) });
  });

  it("copies nothing that is not the linked project's, and scopes a webhook's pass to one project", async () => {
    const h = harness();
    const v = vercel([]);
    await runVercelMirror(deps(h.db, v.http), { projectId: "prj_1" });
    expect(v.calls.filter((c) => c.url.includes("/v7/deployments")).map((c) => c.url)).toHaveLength(1);
  });

  it("marks what Vercel is serving as the app's current deployment, following a rollback made there", async () => {
    const h = harness({ deployments: [
      { id: "old", appId: "a1", provider: "vercel", externalId: "dpl_old", status: "ready", externalTarget: "production", actorType: "system", finishedAt: new Date(1), createdAt: 1 },
      { id: "new", appId: "a1", provider: "vercel", externalId: "dpl_new", status: "ready", externalTarget: "production", actorType: "system", finishedAt: new Date(2), createdAt: 2 },
    ] });
    await runVercelMirror(deps(h.db, vercel([], { project: { targets: { production: { id: "dpl_old" } } } }).http), {});
    expect(h.appUpdates.at(-1)).toMatchObject({ currentDeploymentId: "old", status: "running" });
  });

  it("asks about a row in flight that fell out of the list, and settles a deploy started here that Vercel no longer has", async () => {
    const h = harness({ deployments: [
      { id: "a", appId: "a1", provider: "vercel", externalId: "dpl_a", status: "building", actorType: "system", finishedAt: null, createdAt: 1 },
      { id: "b", appId: "a1", provider: "vercel", externalId: "dpl_b", status: "building", actorType: "user", finishedAt: null, createdAt: 2 },
    ] });
    const v = vercel([], { one: (url) => (url.includes("dpl_a") ? res(200, dpl({ uid: undefined as never, id: "dpl_a" })) : res(404)) });
    await runVercelMirror(deps(h.db, v.http), {});
    expect(h.rows.find((r) => r.id === "a")).toMatchObject({ status: "ready" });
    expect(h.rows.find((r) => r.id === "b")).toMatchObject({ status: "cancelled", error: "Vercel no longer has this deployment" });
    expect(h.activity).toHaveLength(0);
  });

  it("says a refused token on the card without burning retries, and retries an outage", async () => {
    const refused = harness();
    await runVercelMirror(deps(refused.db, vercel([], { status: 403 }).http), {});
    expect(refused.integration.config).toMatchObject({ mirror: { error: "Vercel refused the stored token; reconnect Vercel", triedAt: NOW.toISOString() } });
    const down = harness();
    await expect(runVercelMirror(deps(down.db, vercel([], { status: 503 }).http), {})).rejects.toBeInstanceOf(VercelMirrorError);
    await expect(runVercelMirror(deps(down.db, vercel([], { status: 429 }).http), {})).rejects.toMatchObject({ permanent: false });
    expect(down.integration.config).toMatchObject({ mirror: { error: "Vercel answered 429" } });
  });

  it("never puts the token in anything it stores", async () => {
    const h = harness();
    await runVercelMirror(deps(h.db, vercel([dpl()]).http), {});
    expect(JSON.stringify(h.rows)).not.toContain("the-token");
    expect(JSON.stringify(h.integration.config)).not.toContain("the-token");
  });

  it("does nothing with no token", async () => {
    const h = harness();
    (h.integration as { secretId: string | null }).secretId = null;
    const v = vercel([dpl()]);
    await runVercelMirror(deps(h.db, v.http), {});
    expect(v.calls).toHaveLength(0);
  });

  it("names the error a stray row gets when its app left Vercel", () => expect(NOT_FOLLOWED).toContain("no longer deploys to Vercel"));
});

describe("deployments deleted on Vercel", () => {
  const hoursAgo = (h: number) => NOW.getTime() - h * 3600_000;
  const apps = [{ id: "a1", name: "site", vercelProjectId: "prj_1", gitBranch: null, environment: { name: "production", branch: "main" } }];
  const row = (id: string, uid: string, over: Partial<Row> = {}): Row => ({ id, appId: "a1", provider: "vercel", externalId: uid, status: "failed", actorType: "system", previewId: null, externalTarget: "preview", finishedAt: new Date(hoursAgo(2)), createdAt: hoursAgo(2), ...over });
  const asks = (v: ReturnType<typeof vercel>) => v.calls.filter((c) => c.url.includes("/v13/deployments/")).map((c) => decodeURIComponent(c.url.split("/v13/deployments/")[1]!.split("?")[0]!));

  it("removes a mirrored row the list no longer shows once Vercel answers 404 for it, and says so in Activity", async () => {
    const h = harness({ apps, deployments: [row("x", "dpl_gone"), row("y", "dpl_gone2", { status: "cancelled" })] });
    const v = vercel([dpl({ uid: "dpl_live", created: hoursAgo(1) })]);
    await runVercelMirror(deps(h.db, v.http), {});
    expect(asks(v).sort()).toEqual(["dpl_gone", "dpl_gone2"]);
    expect(h.rows.map((r) => r.externalId)).toEqual(["dpl_live"]);
    expect(h.activity).toEqual([expect.objectContaining({
      category: "deploys", action: REMOVED_ACTION, actorType: "system", targetType: "app", targetId: "a1", targetLabel: "site",
      verb: "removed 2 deployments deleted on Vercel from",
    })]);
    expect((h.activity[0]!.changes as Array<{ key: string }>).map((c) => c.key).sort()).toEqual(["dpl_gone", "dpl_gone2"]);
    expect(v.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("keeps and refreshes a row Vercel still has, even when the list left it out", async () => {
    const h = harness({ apps, deployments: [row("x", "dpl_x")] });
    const v = vercel([], { one: () => res(200, dpl({ uid: undefined as never, id: "dpl_x", readyState: "READY" })) });
    await runVercelMirror(deps(h.db, v.http), {});
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ id: "x", status: "ready" });
    expect(h.activity).toHaveLength(0);
  });

  it("removes one Vercel lists or answers as DELETED", async () => {
    const h = harness({ apps, deployments: [row("x", "dpl_listed"), row("y", "dpl_asked")] });
    const v = vercel([dpl({ uid: "dpl_listed", readyState: "DELETED" })], { one: () => res(200, dpl({ uid: undefined as never, id: "dpl_asked", readyState: "DELETED" })) });
    await runVercelMirror(deps(h.db, v.http), {});
    expect(h.rows).toHaveLength(0);
    expect(asks(v)).toEqual(["dpl_asked"]);
  });

  it("never removes a deploy Dockify started, a preview of this server, or a row of another app", async () => {
    const h = harness({ apps, deployments: [
      row("mine", "dpl_user", { actorType: "user" }),
      row("tok", "dpl_token", { actorType: "token" }),
      row("prev", "dpl_prev", { previewId: "p1" }),
      row("other", "dpl_other", { appId: "a2" }),
    ] });
    await runVercelMirror(deps(h.db, vercel([]).http), {});
    expect(h.rows.map((r) => r.id).sort()).toEqual(["mine", "other", "prev", "tok"]);
    expect(h.activity).toHaveLength(0);
  });

  it("does not ask about a row older than a full page reaches, since the list simply stops before it", async () => {
    const page = Array.from({ length: 50 }, (_, i) => dpl({ uid: `dpl_${i}`, created: hoursAgo(1) - i * 1000 }));
    const h = harness({ apps, deployments: [row("old", "dpl_old", { createdAt: hoursAgo(5) })] });
    const v = vercel(page);
    await runVercelMirror(deps(h.db, v.http), {});
    expect(asks(v)).toEqual([]);
    expect(h.rows.some((r) => r.id === "old")).toBe(true);
  });

  it("asks about a deployment a deletion webhook named, wherever it sits, and believes only Vercel", async () => {
    const page = Array.from({ length: 50 }, (_, i) => dpl({ uid: `dpl_${i}`, created: hoursAgo(1) - i * 1000 }));
    const h = harness({ apps, deployments: [row("old", "dpl_old", { createdAt: hoursAgo(5) }), row("kept", "dpl_kept", { createdAt: hoursAgo(5) })] });
    await runVercelMirror(deps(h.db, vercel(page).http), { projectId: "prj_1", deploymentId: "dpl_old" });
    expect(h.rows.some((r) => r.id === "old")).toBe(false);
    const v = vercel(page, { one: () => res(200, dpl({ uid: undefined as never, id: "dpl_kept" })) });
    await runVercelMirror(deps(h.db, v.http), { projectId: "prj_1", deploymentId: "dpl_kept" });
    expect(h.rows.some((r) => r.id === "kept")).toBe(true);
    const bad = vercel(page);
    await runVercelMirror(deps(h.db, bad.http), { projectId: "prj_1", deploymentId: "../x" });
    expect(asks(bad)).toEqual([]);
  });

  it("asks about at most 20 a pass, and the rest on the next", async () => {
    const h = harness({ apps, deployments: Array.from({ length: 30 }, (_, i) => row(`r${i}`, `dpl_r${i}`, { createdAt: hoursAgo(2) - i })) });
    const v = vercel([]);
    await runVercelMirror(deps(h.db, v.http), {});
    expect(asks(v)).toHaveLength(20);
    expect(h.rows).toHaveLength(10);
    await runVercelMirror(deps(h.db, v.http), {});
    expect(h.rows).toHaveLength(0);
  });
});

describe("telling a failed Vercel deployment once", () => {
  const minsAgo = (m: number) => NOW.getTime() - m * 60_000;
  const failed = (uid: string, ago: number, over: Partial<VercelDeployment> = {}) => dpl({ uid, readyState: "ERROR", created: minsAgo(ago + 1), ready: minsAgo(ago), errorMessage: "Build failed", ...over });
  const notices = (h: ReturnType<typeof harness>) => h.jobs.filter((j) => j.kind === "deploy_notify");
  const inFlight = (id: string, uid: string): Row => ({ id, appId: "a1", provider: "vercel", externalId: uid, status: "building", actorType: "system", finishedAt: null, createdAt: minsAgo(200) });

  it("tells a deployment it saw in flight, once, through the job a server deploy uses", async () => {
    const h = harness({ deployments: [inFlight("d1", "dpl_1")] });
    await runVercelMirror(deps(h.db, vercel([failed("dpl_1", 1)]).http), {});
    expect(notices(h)).toEqual([expect.objectContaining({ kind: "deploy_notify", lane: "maintenance", payload: { deploymentId: "d1" }, dedupeKey: "deploy_notify:d1" })]);
  });

  it("says nothing more on later passes, a webhook's pass, or a restart that starts from the rows and jobs", async () => {
    const h = harness({ deployments: [inFlight("d1", "dpl_1")] });
    const v = vercel([failed("dpl_1", 1)]);
    await runVercelMirror(deps(h.db, v.http), {});
    await runVercelMirror(deps(h.db, v.http), {});
    await runVercelMirror(deps(h.db, v.http), { projectId: "prj_1" });
    const restarted = harness({ deployments: h.rows, jobs: h.jobs });
    await runVercelMirror(deps(restarted.db, v.http), {});
    expect(notices(restarted)).toHaveLength(1);
  });

  it("two passes at once queue one", async () => {
    const h = harness({ deployments: [inFlight("d1", "dpl_1")] });
    const v = vercel([failed("dpl_1", 1)]);
    await Promise.all([runVercelMirror(deps(h.db, v.http), {}), runVercelMirror(deps(h.db, v.http), { projectId: "prj_1" })]);
    expect(notices(h)).toHaveLength(1);
  });

  it("a backfill on a new link sends no flood: 50 old failures are silent", async () => {
    const h = harness();
    await runVercelMirror(deps(h.db, vercel(Array.from({ length: 50 }, (_, i) => failed(`dpl_${i}`, 60 + i))).http), {});
    expect(h.rows).toHaveLength(50);
    expect(notices(h)).toHaveLength(0);
  });

  it("a failure with no finish time reads as its creation, so an old one stays silent too", async () => {
    const h = harness();
    await runVercelMirror(deps(h.db, vercel([failed("dpl_1", 60, { ready: null })]).http), {});
    expect(notices(h)).toHaveLength(0);
  });

  it("first seen failing inside the window is told, and just outside it is not", async () => {
    const h = harness();
    await runVercelMirror(deps(h.db, vercel([failed("dpl_new", 14), failed("dpl_old", 16)]).http), {});
    const idOf = (uid: string) => h.rows.find((r) => r.externalId === uid)!.id;
    expect(notices(h).map((j) => j.payload)).toEqual([{ deploymentId: idOf("dpl_new") }]);
  });

  it("a deployment seen in flight is told even when it ended long ago, as when the worker was down", async () => {
    const h = harness({ deployments: [inFlight("d1", "dpl_1")] });
    await runVercelMirror(deps(h.db, vercel([failed("dpl_1", 180)]).http), {});
    expect(notices(h)).toHaveLength(1);
  });

  it("tells production and preview alike, and nothing for ready, cancelled or building", async () => {
    const h = harness({ deployments: [inFlight("d1", "dpl_prod"), inFlight("d2", "dpl_prev"), inFlight("d3", "dpl_ok"), inFlight("d4", "dpl_cx"), inFlight("d5", "dpl_on")] });
    await runVercelMirror(deps(h.db, vercel([
      failed("dpl_prod", 1), failed("dpl_prev", 1, { target: null }), dpl({ uid: "dpl_ok" }), dpl({ uid: "dpl_cx", readyState: "CANCELED" }), dpl({ uid: "dpl_on", readyState: "BUILDING", ready: null }),
    ]).http), {});
    expect(notices(h).map((j) => (j.payload as { deploymentId: string }).deploymentId).sort()).toEqual(["d1", "d2"]);
  });

  it("picks up a failure another writer stored, such as the deploy target's job", async () => {
    const h = harness({ deployments: [{ id: "d1", appId: "a1", provider: "vercel", externalId: null, status: "failed", actorType: "user", finishedAt: new Date(minsAgo(2)), createdAt: minsAgo(5) }] });
    await runVercelMirror(deps(h.db, vercel([]).http), {});
    expect(notices(h).map((j) => j.payload)).toEqual([{ deploymentId: "d1" }]);
  });

  it("a burst drains a few per pass, and the rest wait for the next one", async () => {
    const h = harness();
    const v = vercel(Array.from({ length: 25 }, (_, i) => failed(`dpl_${i}`, 2)));
    await runVercelMirror(deps(h.db, v.http), {});
    expect(notices(h)).toHaveLength(10);
    await runVercelMirror(deps(h.db, v.http), {});
    await runVercelMirror(deps(h.db, v.http), {});
    expect(notices(h)).toHaveLength(25);
  });

  it("tells a failure even while Vercel cannot be read, and carries on retrying", async () => {
    const h = harness({ deployments: [{ id: "d1", appId: "a1", provider: "vercel", externalId: "dpl_1", status: "failed", actorType: "system", finishedAt: new Date(minsAgo(1)), createdAt: minsAgo(5) }] });
    await expect(runVercelMirror(deps(h.db, vercel([], { status: 503 }).http), {})).rejects.toBeInstanceOf(VercelMirrorError);
    expect(notices(h)).toHaveLength(1);
  });
});

describe("queueVercelMirrorIfDue", () => {
  const queued = (h: ReturnType<typeof harness>) => {
    const added: Array<Record<string, unknown>> = [];
    const tx = { $executeRaw: async () => 0, job: { findFirst: async () => null, create: async ({ data }: { data: Record<string, unknown> }) => (added.push(data), { id: "j" }) } };
    // Replaces the harness's own transaction: this suite only looks at what the timer queues.
    Object.assign(h.db as object, { $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx) });
    return added;
  };
  const at = NOW.getTime();
  const mirror = (ago: number) => ({ mirror: { triedAt: new Date(at - ago).toISOString() } });

  it("polls every 2 minutes with no webhook, and every 10 with one", async () => {
    let h = harness({ config: mirror(60_000) });
    expect(await queueVercelMirrorIfDue(h.db, at)).toBe(false);
    h = harness({ config: mirror(130_000) });
    const added = queued(h);
    expect(await queueVercelMirrorIfDue(h.db, at)).toBe(true);
    expect(added[0]).toMatchObject({ kind: "vercel_mirror", lane: "maintenance", dedupeKey: "vercel_mirror:all" });
    h = harness({ config: { ...mirror(130_000), webhook: { state: "active" } } });
    expect(await queueVercelMirrorIfDue(h.db, at)).toBe(false);
    h = harness({ config: { ...mirror(610_000), webhook: { state: "active" } } });
    queued(h);
    expect(await queueVercelMirrorIfDue(h.db, at)).toBe(true);
  });

  it("reads every 30 seconds while a deployment is in flight", async () => {
    const h = harness({ config: { ...mirror(40_000), webhook: { state: "active" } }, deployments: [{ id: "d", externalId: "x", status: "building" }] });
    queued(h);
    expect(await queueVercelMirrorIfDue(h.db, at)).toBe(true);
  });

  it("stays quiet with nothing linked or nothing connected", async () => {
    expect(await queueVercelMirrorIfDue(harness({ apps: [] }).db, at)).toBe(false);
    const h = harness();
    (h.integration as { secretId: string | null }).secretId = null;
    expect(await queueVercelMirrorIfDue(h.db, at)).toBe(false);
  });
});
