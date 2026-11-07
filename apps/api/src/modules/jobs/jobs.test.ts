/**
 * The job routes and New app's repository read: who may call what, what is refused for which app,
 * that an audit row never holds a command, and that a read is private to who asked.
 */
import { describe, expect, it } from "vitest";
import { endpoints, jobs as J, projects as P } from "@dockify/contracts";
import type { Actor } from "../../actor.ts";
import type { Ctx, Handler } from "../../app.ts";
import { describePolicy, POLICIES } from "../../policy.ts";
import { testRing } from "../../test-helpers.ts";
import { jobsHandlers } from "./index.ts";

const APP = "0f0e0d0c-0000-4000-8000-0000000000aa";
const JOB = "1f0e0d0c-0000-4000-8000-0000000000bb";
const RUN = "2f0e0d0c-0000-4000-8000-0000000000cc";
const owner = { kind: "session", userId: "u", name: "Owner", role: "admin", sessionId: "s", elevated: true } as Actor;
const other = { ...owner, userId: "u2" } as Actor;
const limited = { kind: "token", userId: "u", name: "ci", role: "admin", tokenId: "t", scope: "deploy", allProjects: false, projectIds: ["other"], grants: [], elevated: false } as Actor;

const appRow = (over: Record<string, unknown> = {}) => ({
  id: APP, name: "web", kind: "backend", deployTarget: "server", desiredState: "running", currentDeploymentId: "d1",
  environment: { name: "production", projectId: "p1", project: { slug: "shop" } }, ...over,
});
const jobRow = (over: Record<string, unknown> = {}) => ({
  id: JOB, appId: APP, name: "report", schedule: "0 3 * * *", timezone: "UTC", command: "node report.js", timeoutSeconds: 60, overlap: "skip", enabled: true, nextRunAt: new Date("2026-11-07T03:00:00Z"), ...over,
});

function fake(o: { app?: Record<string, unknown> | null; job?: Record<string, unknown> | null; count?: number; active?: boolean; waiting?: number; installation?: boolean } = {}) {
  const audits: Array<Record<string, unknown>> = [];
  const runs: Array<Record<string, unknown>> = [];
  const queued: Array<Record<string, unknown>> = [];
  const jobs: Array<Record<string, unknown>> = [];
  const detections = new Map<string, Record<string, unknown>>();
  const tx = {
    $executeRaw: async () => 0,
    activityLog: { create: async (a: { data: Record<string, unknown> }) => void audits.push(a.data) },
    scheduledJob: {
      count: async () => o.count ?? 0,
      create: async (a: { data: Record<string, unknown> }) => {
        jobs.push(a.data);
        return { ...jobRow(), ...a.data };
      },
      update: async (a: { data: Record<string, unknown> }) => {
        jobs.push(a.data);
        return { ...jobRow(), ...a.data };
      },
      delete: async () => {},
    },
    scheduledJobRun: {
      findFirst: async () => (o.active ? { id: "active" } : null),
      count: async () => o.waiting ?? 0,
      create: async (a: { data: Record<string, unknown> }) => {
        runs.push(a.data);
        return { id: RUN };
      },
      updateMany: async () => ({ count: 0 }),
    },
    job: { create: async (a: { data: Record<string, unknown> }) => void queued.push(a.data) },
    buildDetection: {
      create: async (a: { data: Record<string, unknown> }) => {
        const row = { id: `d${detections.size}`, status: "pending", createdAt: new Date(), ...a.data };
        detections.set(a.data.requestKey as string, row);
        return row;
      },
    },
  };
  const db = {
    ...tx,
    app: { findUnique: async () => (o.app === undefined ? appRow() : o.app) },
    scheduledJob: { ...tx.scheduledJob, findFirst: async () => (o.job === undefined ? jobRow() : o.job), findMany: async () => [{ ...jobRow(), runs: [] }] },
    scheduledJobRun: { ...tx.scheduledJobRun, findMany: async () => [] },
    gitHubInstallation: { findUnique: async () => (o.installation ? { id: "i" } : null) },
    buildDetection: {
      ...tx.buildDetection,
      findUnique: async (a: { where: { requestKey: string } }) => detections.get(a.where.requestKey) ?? null,
      count: async () => 0,
      deleteMany: async () => ({ count: 1 }),
    },
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  };
  return { db, audits, runs, queued, jobs, detections };
}

function call(id: keyof typeof jobsHandlers, db: unknown, input: { body?: unknown; actor?: Actor } = {}): Promise<unknown> {
  const h = jobsHandlers[id] as Handler<never>;
  return h({
    params: { id: APP, jobId: JOB, runId: RUN } as never, body: input.body as never, query: undefined as never, actor: input.actor ?? owner,
    req: { clientIp: "203.0.113.1", headers: { "user-agent": "vitest" } } as never, reply: {} as never, ctx: { db, ring: testRing() } as unknown as Ctx,
  });
}

const body = { name: "report", schedule: "0 3 * * *", timezone: "UTC", command: "node report.js --token=abc123", timeoutSeconds: 60, overlap: "skip", enabled: true };

describe("who may call what", () => {
  it("lets a viewer read, and an elevated admin change a job", () => {
    for (const id of ["apps.jobs.list", "apps.jobs.runs", "apps.jobs.run.get"] as const) expect(describePolicy(POLICIES[id]), id).toBe("session:viewer+token:read");
    for (const id of ["apps.jobs.create", "apps.jobs.update", "apps.jobs.delete"] as const) expect(describePolicy(POLICIES[id]), id).toBe("elevated:admin");
    expect(describePolicy(POLICIES["apps.jobs.run"])).toBe("session:admin+token:deploy");
    expect(describePolicy(POLICIES["apps.detect"])).toBe("session:admin");
  });
  it("has a route and a handler for every job endpoint", () => {
    for (const id of ["apps.jobs.list", "apps.jobs.create", "apps.jobs.update", "apps.jobs.delete", "apps.jobs.run", "apps.jobs.runs", "apps.jobs.run.get", "apps.detect"] as const) {
      expect(endpoints[id], id).toBeTruthy();
      expect(jobsHandlers[id], id).toBeTypeOf("function");
    }
  });
  it("holds a limited token to its projects", async () => {
    await expect(call("apps.jobs.list", fake().db, { actor: limited })).rejects.toMatchObject({ status: 403 });
    await expect(call("apps.jobs.run", fake().db, { actor: limited })).rejects.toMatchObject({ status: 403 });
  });
  it("answers 404 for a job of another app, by the row's own app", async () => {
    await expect(call("apps.jobs.runs", fake({ job: null }).db)).rejects.toMatchObject({ status: 404 });
    await expect(call("apps.jobs.delete", fake({ job: null }).db)).rejects.toMatchObject({ status: 404 });
    await expect(call("apps.jobs.list", fake({ app: null }).db)).rejects.toMatchObject({ status: 404 });
  });
});

describe("saving a job", () => {
  it("refuses a managed database and a Vercel app", async () => {
    for (const kind of ["postgres", "redis", "s3"]) await expect(call("apps.jobs.create", fake({ app: appRow({ kind }) }).db, { body }), kind).rejects.toMatchObject({ status: 400, code: "REFUSED" });
    await expect(call("apps.jobs.create", fake({ app: appRow({ deployTarget: "vercel" }) }).db, { body })).rejects.toMatchObject({ code: "REFUSED" });
    await expect(call("apps.jobs.run", fake({ app: appRow({ kind: "postgres" }) }).db)).rejects.toMatchObject({ code: "REFUSED" });
  });
  it("refuses a schedule under the minimum, an unknown zone, and one job too many", async () => {
    await expect(call("apps.jobs.create", fake().db, { body: { ...body, schedule: "* * * * *" } })).rejects.toMatchObject({ code: "INVALID_SCHEDULE", extra: { field: "schedule" } });
    await expect(call("apps.jobs.create", fake().db, { body: { ...body, timezone: "Mars/Base" } })).rejects.toMatchObject({ code: "INVALID_SCHEDULE", extra: { field: "timezone" } });
    await expect(call("apps.jobs.create", fake({ count: J.JOB_MAX_PER_APP }).db, { body })).rejects.toMatchObject({ code: "TOO_MANY_JOBS" });
  });
  it("audits a create without the command, which can hold a pasted token", async () => {
    const f = fake();
    const out = (await call("apps.jobs.create", f.db, { body })) as { nextRunAt: string | null };
    expect(out.nextRunAt).not.toBeNull();
    expect(JSON.stringify(f.audits)).not.toContain("abc123");
    expect(f.audits[0]).toMatchObject({ action: "job.create", category: "config", actorId: "u" });
  });
  it("names a changed command in the audit, not its text", async () => {
    const f = fake();
    await call("apps.jobs.update", f.db, { body: { command: "node other.js --token=zzz" } });
    expect(f.audits[0]!.suffix).toBe("(command)");
    expect(JSON.stringify(f.audits)).not.toContain("zzz");
  });
  it("clears the next time when turned off, and reworks it when turned on or rescheduled", async () => {
    const off = fake();
    await call("apps.jobs.update", off.db, { body: { enabled: false } });
    expect(off.jobs[0]!.nextRunAt).toBeNull();
    const on = fake({ job: jobRow({ enabled: false, nextRunAt: null }) });
    await call("apps.jobs.update", on.db, { body: { enabled: true } });
    expect(on.jobs[0]!.nextRunAt).toBeInstanceOf(Date);
    const kept = fake();
    await call("apps.jobs.update", kept.db, { body: { command: "x" } });
    expect(kept.jobs[0]!.nextRunAt).toEqual(new Date("2026-11-07T03:00:00Z"));
    await expect(call("apps.jobs.update", fake().db, { body: { schedule: "*/1 * * * *" } })).rejects.toMatchObject({ code: "INVALID_SCHEDULE" });
  });
});

describe("Run now", () => {
  it("queues one run on the cron lane, with one attempt, and audits it", async () => {
    const f = fake();
    await expect(call("apps.jobs.run", f.db)).resolves.toEqual({ runId: RUN });
    expect(f.runs[0]).toMatchObject({ trigger: "manual", status: "queued" });
    expect(f.queued[0]).toMatchObject({ kind: "scheduled_run", lane: "cron", maxAttempts: 1 });
    expect(f.audits[0]).toMatchObject({ action: "job.run", category: "deploys" });
  });
  it("refuses a stopped app, an undeployed app, an active run under skip, and a full server", async () => {
    await expect(call("apps.jobs.run", fake({ app: appRow({ desiredState: "stopped" }) }).db)).rejects.toMatchObject({ code: "APP_STOPPED" });
    await expect(call("apps.jobs.run", fake({ app: appRow({ currentDeploymentId: null }) }).db)).rejects.toMatchObject({ code: "NOT_DEPLOYED" });
    await expect(call("apps.jobs.run", fake({ active: true }).db)).rejects.toMatchObject({ code: "JOB_ACTIVE" });
    await expect(call("apps.jobs.run", fake({ waiting: J.JOB_MAX_WAITING_RUNS }).db)).rejects.toMatchObject({ code: "JOBS_BUSY" });
  });
  it("goes ahead under replace", async () => {
    const f = fake({ active: true, job: jobRow({ overlap: "replace" }) });
    await expect(call("apps.jobs.run", f.db)).resolves.toEqual({ runId: RUN });
  });
});

describe("reading a repository for New app", () => {
  const read = { repoUrl: "https://github.com/acme/site", branch: "main", rootDir: "" };
  type Answer = { pending: boolean; detected: boolean };

  it("queues one read on its own lane, and a repeat answers from the row", async () => {
    const f = fake();
    expect(((await call("apps.detect", f.db, { body: read })) as Answer).pending).toBe(true);
    expect(((await call("apps.detect", f.db, { body: read })) as Answer).pending).toBe(true);
    expect(f.queued).toHaveLength(1);
    expect(f.queued[0]).toMatchObject({ kind: "build_detect", lane: "detect" });
  });
  it("keeps a read private to who asked", async () => {
    const f = fake();
    await call("apps.detect", f.db, { body: read });
    await call("apps.detect", f.db, { body: read, actor: other });
    expect(f.queued).toHaveLength(2);
    const keys = [...f.detections.keys()];
    expect(keys[0]).not.toBe(keys[1]);
  });
  it("answers what the worker found", async () => {
    const f = fake();
    await call("apps.detect", f.db, { body: read });
    const row = [...f.detections.values()][0]!;
    Object.assign(row, { status: "done", result: { detected: true, builder: "railpack", framework: "Next.js", port: 3000 } });
    const out = (await call("apps.detect", f.db, { body: read })) as Record<string, unknown>;
    expect(out).toMatchObject({ pending: false, detected: true, framework: "Next.js", port: 3000, rootDir: "" });
    expect(P.DetectResult.safeParse(out).success).toBe(true);
    Object.assign(row, { status: "failed", result: null, error: "Could not read it" });
    expect(await call("apps.detect", f.db, { body: read })).toMatchObject({ pending: false, detected: false, reason: "Could not read it" });
  });
  it("refuses a blocked host and an installation that is not connected", async () => {
    await expect(call("apps.detect", fake().db, { body: { ...read, repoUrl: "https://metadata.google.internal/a/b" } })).rejects.toMatchObject({ status: 400 });
    await expect(call("apps.detect", fake().db, { body: { ...read, git: { installationId: "1", repoId: "2" } } })).rejects.toMatchObject({ code: "GIT_NOT_FOUND" });
  });
  it("keeps hostile requests out at the contract", () => {
    for (const repoUrl of ["http://github.com/a/b", "git@github.com:a/b", "https://github.com/a/b;id", "https://169.254.169.254/a/b"]) expect(P.DetectBody.safeParse({ ...read, repoUrl }).success, repoUrl).toBe(false);
    expect(P.DetectBody.safeParse({ ...read, rootDir: "../../etc" }).success).toBe(false);
    expect(P.DetectBody.safeParse({ ...read, branch: "--upload-pack=x" }).success).toBe(false);
  });
});
