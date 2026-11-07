/**
 * Scheduled jobs: the rules (schedule.ts), the run (run.ts) against a fake daemon, and the clock
 * (tick.ts) after downtime. The container a run makes goes through the real containerSpec().
 */
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { jobs as J } from "@dockify/contracts";
import { assertSafeSpec, containerSpec } from "@dockify/engine";
import type { RunnableApp } from "../deploy/containers.ts";
import { DeferJobError } from "../errors.ts";
import type { ClaimedJob } from "../queue.ts";
import { handleScheduledRun, jobContainerInput, parseRunPayload } from "./run.ts";
import { decideDue, jitterMs, jobsAllowed, scheduleProblem, TailLog } from "./schedule.ts";
import { jobsTick, ORPHAN_REASON, settleOrphanRuns } from "./tick.ts";

const APP = "0f0e0d0c-0000-4000-8000-0000000000aa";
const RUN = "1f0e0d0c-0000-4000-8000-0000000000bb";
const JOB = "2f0e0d0c-0000-4000-8000-0000000000cc";
const IMAGE = `sha256:${"a".repeat(64)}`;
const SECRET = "s3cret-value-of-a-variable";

describe("which schedules can be saved", () => {
  const from = new Date("2026-11-06T12:00:00Z");
  it("takes ordinary schedules at or above the minimum", () => {
    for (const s of ["*/5 * * * *", "0 3 * * *", "0 0 1 * *", "30 8 * * 1-5", "0,30 * * * *"]) expect(scheduleProblem(s, "UTC", from), s).toBeNull();
  });
  it("refuses anything that fires more often, however it is written", () => {
    for (const s of ["* * * * *", "*/4 * * * *", "0-4 * * * *", "0,1 * * * *", "*/2 8 * * *", "1,2,30 9 * * 1"]) {
      expect(scheduleProblem(s, "UTC", from), s).toMatch(/minimum/);
    }
  });
  it("refuses what is not cron, and an unknown zone", () => {
    expect(scheduleProblem("not cron", "UTC", from)).toMatch(/not valid/);
    expect(scheduleProblem("99 * * * *", "UTC", from)).toMatch(/not valid/);
    expect(scheduleProblem("0 0 31 2 *", "UTC", from)).toMatch(/not valid/);
    expect(scheduleProblem("0 3 * * *", "Mars/Olympus", from)).toMatch(/time zone/);
  });
  it("keeps hostile text out at the contract", () => {
    for (const s of ["* * * * *; rm -rf /", "$(id) * * * *", "* * * * * *", "`id` * * * *"]) expect(J.JobSchedule.safeParse(s).success, s).toBe(false);
    expect(J.JobCommand.safeParse("   ").success).toBe(false);
    expect(J.JobCommand.safeParse("a\nb").success).toBe(false);
    expect(J.JobTimezone.safeParse("../../etc/passwd").success).toBe(false);
    expect(J.JobTimeout.safeParse(J.JOB_MAX_TIMEOUT_SECONDS + 1).success).toBe(false);
    expect(J.JobTimeout.safeParse(1).success).toBe(false);
    expect(J.JobName.safeParse("Bad Name").success).toBe(false);
    expect(J.CreateJobBody.safeParse({ name: "a", schedule: "0 3 * * *", timezone: "UTC", command: "x", timeoutSeconds: 60, overlap: "skip", enabled: true, shell: "bash" }).success).toBe(false);
  });
});

describe("what a due time turns into", () => {
  const now = new Date("2026-11-06T12:00:00Z");
  const app = { kind: "backend", deployTarget: "server", desiredState: "running", hasDeployment: true };
  const due = (o: Partial<Parameters<typeof decideDue>[0]> = {}) => decideDue({ scheduledFor: new Date(now.getTime() - 10_000), now, overlap: "skip", active: false, waiting: 0, appRuns: app, ...o });
  it("runs when nothing stands in the way", () => expect(due()).toEqual({ action: "run" }));
  it("records a time long past as missed, never running it late", () => {
    expect(due({ scheduledFor: new Date(now.getTime() - (J.JOB_LATE_MINUTES * 60_000 + 1)) })).toMatchObject({ action: "record", status: "missed" });
    expect(due({ scheduledFor: new Date(now.getTime() - J.JOB_LATE_MINUTES * 60_000) })).toEqual({ action: "run" });
  });
  it("applies the overlap policy", () => {
    expect(due({ active: true })).toMatchObject({ action: "record", status: "skipped" });
    expect(due({ active: true, overlap: "replace" })).toEqual({ action: "replace" });
  });
  it("skips while the server has too many waiting", () => expect(due({ waiting: J.JOB_MAX_WAITING_RUNS })).toMatchObject({ action: "record", status: "skipped" }));
  it("does not run a stopped or undeployed app, a database or a Vercel app", () => {
    expect(due({ appRuns: { ...app, desiredState: "stopped" } })).toMatchObject({ status: "skipped" });
    expect(due({ appRuns: { ...app, hasDeployment: false } })).toMatchObject({ status: "skipped" });
    for (const kind of ["postgres", "redis", "s3"]) expect(jobsAllowed({ kind, deployTarget: "server" }), kind).toBe(false);
    expect(jobsAllowed({ kind: "frontend", deployTarget: "vercel" })).toBe(false);
    expect(jobsAllowed({ kind: "worker", deployTarget: "server" })).toBe(true);
  });
  it("spreads jobs with a fixed offset", () => {
    const offsets = ["a", "b", "c", "d", "e"].map(jitterMs);
    for (const o of offsets) expect(o).toBeLessThan(30_000);
    expect(new Set(offsets).size).toBeGreaterThan(1);
    expect(jitterMs("a")).toBe(jitterMs("a"));
  });
});

describe("a run's log", () => {
  it("keeps the newest bytes and says the top went", () => {
    const t = new TailLog(100);
    for (let i = 0; i < 50; i++) t.add(`line ${i}`);
    expect(t.text).toContain("line 49");
    expect(t.text).not.toContain("line 0\n");
    expect(t.text.startsWith("[earlier output was cut]")).toBe(true);
  });
  it("survives one enormous line, and a NUL Postgres cannot store", () => {
    const t = new TailLog(100);
    t.add("x".repeat(10_000));
    expect(Buffer.byteLength(t.text)).toBeLessThan(200);
    const n = new TailLog();
    n.add("a\0b");
    expect(n.text).toBe("ab");
  });
});

describe("the container a run gets", () => {
  const app: RunnableApp = {
    id: APP, kind: "backend", environmentId: "e1e1e1e1-0000-4000-8000-000000000001", projectId: "p1", port: null, startCommand: null,
    memoryLimitMb: 256, cpuLimit: 0.5, pidsLimit: 128, capAdd: [], sysctls: {}, volumes: [],
  };
  const spec = (command: string) => containerSpec(jobContainerInput(app, { runId: RUN, imageId: IMAGE, env: { A: "1" }, deploymentId: "d1", command }));
  it("has the app's network and limits, under the policy, with nothing published and no restart", () => {
    const s = spec("node job.js");
    assertSafeSpec(s);
    expect(s.Image).toBe(IMAGE);
    expect(s.HostConfig.NetworkMode).toBe(`dockify-env-${app.environmentId}`);
    expect(s.HostConfig.Memory).toBe(256 * 1024 * 1024);
    expect(s.HostConfig.PidsLimit).toBe(128);
    expect(s.HostConfig.RestartPolicy).toEqual({ Name: "no" });
    expect(s.HostConfig.Mounts).toEqual([]);
    expect(s.ExposedPorts).toBeUndefined();
    expect(s.NetworkingConfig.EndpointsConfig[`dockify-env-${app.environmentId}`]).toEqual({ Aliases: [] });
    expect(s.Labels["dockify.role"]).toBe("job");
    expect(s.Labels["dockify.app"]).toBe(APP);
  });
  it("never adds a shell the user did not ask for", () => {
    const plain = spec("node job.js --all");
    expect(plain.Entrypoint).toEqual(["node"]);
    expect(plain.Cmd).toEqual(["job.js", "--all"]);
    const shell = spec("node a.js && node b.js");
    expect(shell.Entrypoint).toEqual(["sh", "-c"]);
    expect(shell.Cmd).toEqual(["node a.js && node b.js"]);
  });
  it("cannot be told apart from the app's own container by name or alias", () => {
    const input = jobContainerInput(app, { runId: RUN, imageId: IMAGE, env: {}, deploymentId: "d1", command: "x" });
    expect(input.name).toBe(`dk-${APP}-job-1f0e0d0c`);
    expect(input.aliases).toEqual([]);
  });
});

// ------------------------------------------------------------------ the run, with a fake daemon

type Row = Record<string, unknown> & { id: string; status: string };

function world(o: { status?: string; command?: string; timeoutSeconds?: number; deployment?: Record<string, unknown> | null; running?: boolean; previous?: string | null } = {}) {
  const run: Row = {
    id: RUN, jobId: JOB, status: o.status ?? "queued", createdAt: new Date("2026-11-06T12:00:00Z"), cancelRequested: false, log: "",
    job: {
      id: JOB, name: "report", command: o.command ?? "node job.js", timeoutSeconds: o.timeoutSeconds ?? 60,
      app: {
        id: APP, name: "web", kind: "backend", environmentId: "e1e1e1e1-0000-4000-8000-000000000001", port: 3000, memoryLimitMb: null, cpuLimit: null, pidsLimit: null, capAdd: [], sysctls: {},
        environment: { projectId: "p1", name: "production", project: { slug: "shop" } },
        currentDeployment: o.deployment === undefined ? { id: "d1", imageId: IMAGE, envSecretId: "sec1" } : o.deployment,
      },
    },
  };
  const notices: unknown[] = [];
  const db = {
    scheduledJobRun: {
      findUnique: vi.fn(async (a: { select?: unknown }) => (a.select ? { cancelRequested: run.cancelRequested } : run)),
      findFirst: vi.fn(async (a: { where: { status?: unknown } }) => {
        if (a.where.status === "running") return o.running ? { id: "older" } : null;
        return o.previous ? { status: o.previous } : null;
      }),
      update: vi.fn(async (a: { where: { id: string }; data: Record<string, unknown> }) => {
        if (a.where.id === RUN) Object.assign(run, a.data);
        return run;
      }),
      updateMany: vi.fn(async (a: { where: { status?: unknown }; data: Record<string, unknown> }) => {
        const allowed = a.where.status === "queued" ? run.status === "queued" : run.status === "queued" || run.status === "running";
        if (!allowed) return { count: 0 };
        Object.assign(run, a.data);
        return { count: 1 };
      }),
    },
    job: {
      findFirst: vi.fn(async () => null),
    },
    $transaction: async (fn: (t: unknown) => unknown) =>
      fn({
        $executeRaw: async () => 0,
        job: {
          findFirst: async () => null,
          create: async (a: { data: unknown }) => {
            notices.push(a.data);
            return { id: "j1" };
          },
        },
      }),
    secret: {},
  };
  return { run, db, notices };
}

function daemon(o: { exit?: number; output?: string; hang?: boolean; noImage?: boolean } = {}) {
  const created: Array<{ name: string; input: Record<string, unknown> }> = [];
  const removed: string[] = [];
  const stopped: string[] = [];
  const frame = (text: string) => {
    const body = Buffer.from(text);
    const head = Buffer.alloc(8);
    head[0] = 1;
    head.writeUInt32BE(body.length, 4);
    return Buffer.concat([head, body]);
  };
  return {
    created, removed, stopped,
    api: {
      inspectImage: async () => {
        if (o.noImage) throw Object.assign(new Error("no such image"), { status: 404, name: "DockerError" });
        return { Id: IMAGE, Size: 1, Config: { Entrypoint: null } };
      },
      createContainer: async (name: string, input: Record<string, unknown>) => {
        created.push({ name, input });
        return "cid";
      },
      startContainer: async () => {},
      logs: async () => {
        const s = new PassThrough();
        s.end(frame(o.output ?? ""));
        return s;
      },
      waitContainer: (_id: string, signal: AbortSignal) =>
        o.hang
          ? new Promise<number>((_r, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
          : Promise.resolve(o.exit ?? 0),
      stopContainer: async (id: string) => void stopped.push(id),
      removeContainer: async (id: string) => void removed.push(id),
      inspectContainer: async () => ({ State: { ExitCode: o.exit ?? 0, Status: "exited" } }),
    },
  };
}

const claimed = { id: "q1", kind: "scheduled_run", lane: "cron", payload: { runId: RUN }, attempts: 1, maxAttempts: 1 } as unknown as ClaimedJob;

vi.mock("../deploy/env.ts", async (orig) => ({
  ...(await orig<typeof import("../deploy/env.ts")>()),
  openSnapshot: async () => [
    { key: "API_KEY", value: SECRET, isSecret: true, target: "both" },
    { key: "BUILD_ONLY", value: "b", isSecret: false, target: "build" },
    { key: "PLAIN", value: "p", isSecret: false, target: "runtime" },
  ],
}));

const go = (w: ReturnType<typeof world>, d: ReturnType<typeof daemon>, signal = new AbortController().signal) =>
  handleScheduledRun({ db: w.db as never, vault: {} as never, docker: d.api as never, pollMs: 5, flushMs: 5 }, claimed, signal);

describe("a run", () => {
  it("passes the app's runtime variables and PORT, and stores the output with secrets hidden", async () => {
    const w = world();
    const d = daemon({ output: `token is ${SECRET}\nall done\n` });
    await go(w, d);
    expect(w.run.status).toBe("succeeded");
    expect(w.run.exitCode).toBe(0);
    expect(w.run.log).toContain("all done");
    expect(w.run.log).not.toContain(SECRET);
    const env = d.created[0]!.input.env as Record<string, string>;
    expect(env.API_KEY).toBe(SECRET);
    expect(env.PLAIN).toBe("p");
    expect(env.PORT).toBe("3000");
    expect(env.BUILD_ONLY).toBeUndefined();
    expect(d.removed).toContain("cid");
  });

  it("records a failure and its exit code, and alerts once", async () => {
    const w = world();
    const d = daemon({ exit: 3, output: "boom\n" });
    await go(w, d);
    expect(w.run).toMatchObject({ status: "failed", exitCode: 3 });
    expect(w.notices).toHaveLength(1);
    expect(JSON.stringify(w.notices[0])).toContain("jobFailed");
    expect(JSON.stringify(w.notices[0])).toContain(`/apps/${APP}?tab=jobs`);
  });

  it("does not alert again while the job keeps failing", async () => {
    const w = world({ previous: "failed" });
    await go(w, daemon({ exit: 1 }));
    expect(w.run.status).toBe("failed");
    expect(w.notices).toHaveLength(0);
  });

  it("alerts again after a success ended the streak", async () => {
    const w = world({ previous: "succeeded" });
    await go(w, daemon({ exit: 1 }));
    expect(w.notices).toHaveLength(1);
  });

  it("stops a command past its timeout", async () => {
    const w = world({ timeoutSeconds: 0.02 as unknown as number });
    const d = daemon({ hang: true });
    await go(w, d);
    expect(w.run.status).toBe("timed_out");
    expect(d.stopped).toEqual(["cid"]);
    expect(d.removed).toContain("cid");
    expect(w.notices).toHaveLength(1);
  });

  it("stops when a newer run replaces it, with no alert", async () => {
    const w = world();
    const d = daemon({ hang: true });
    const done = go(w, d);
    setTimeout(() => (w.run.cancelRequested = true), 10);
    await done;
    expect(w.run.status).toBe("cancelled");
    expect(d.stopped).toEqual(["cid"]);
    expect(w.notices).toHaveLength(0);
  });

  it("stops on a worker shutdown and says so, with no retry", async () => {
    const w = world();
    const d = daemon({ hang: true });
    const stop = new AbortController();
    const done = go(w, d, stop.signal);
    setTimeout(() => stop.abort(), 10);
    await done;
    expect(w.run).toMatchObject({ status: "cancelled", reason: "Dockify's worker restarted while it ran." });
  });

  it("does nothing for a run no longer queued", async () => {
    const w = world({ status: "cancelled" });
    const d = daemon();
    await go(w, d);
    expect(d.created).toEqual([]);
  });

  it("waits, without spending an attempt, for the run it replaces", async () => {
    const w = world({ running: true });
    await expect(go(w, daemon())).rejects.toBeInstanceOf(DeferJobError);
    expect(w.db.scheduledJobRun.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "older" }, data: { cancelRequested: true } }));
    expect(w.run.status).toBe("queued");
  });

  it("fails clearly with no deployment, and with an image that is gone", async () => {
    const none = world({ deployment: null });
    await go(none, daemon());
    expect(none.run).toMatchObject({ status: "failed" });
    expect(String(none.run.reason)).toContain("no successful deployment");
    const gone = world();
    const d = daemon({ noImage: true });
    await go(gone, d).catch(() => {});
    expect(d.created).toEqual([]);
  });

  it("takes only a run id", () => {
    expect(() => parseRunPayload({})).toThrow();
    expect(() => parseRunPayload({ runId: "../../x" })).toThrow();
    expect(parseRunPayload({ runId: RUN })).toBe(RUN);
  });
});

// ------------------------------------------------------------------ the clock

function clock(jobs: Array<Record<string, unknown>>, o: { active?: boolean; waiting?: number } = {}) {
  const runs: Array<Record<string, unknown>> = [];
  const queued: Array<Record<string, unknown>> = [];
  const moved: Array<Record<string, unknown>> = [];
  const tx = {
    $executeRaw: async () => 0,
    scheduledJob: {
      updateMany: async (a: { where: { id: string }; data: Record<string, unknown> }) => {
        const j = jobs.find((x) => x.id === a.where.id && x.nextRunAt === (a.where as { nextRunAt?: unknown }).nextRunAt);
        if (!j) return { count: 0 };
        Object.assign(j, a.data);
        moved.push({ id: a.where.id, ...a.data });
        return { count: 1 };
      },
    },
    scheduledJobRun: {
      findFirst: async () => (o.active ? { id: "active" } : null),
      count: async () => o.waiting ?? 0,
      create: async (a: { data: Record<string, unknown> }) => {
        runs.push(a.data);
        return { id: `r${runs.length}` };
      },
      updateMany: async () => ({ count: 0 }),
    },
    job: {
      create: async (a: { data: Record<string, unknown> }) => {
        queued.push(a.data);
        return { id: "q" };
      },
    },
  };
  const db = {
    scheduledJob: {
      findMany: async () => jobs.map((j) => ({ ...j })),
      update: async (a: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(jobs.find((x) => x.id === a.where.id)!, a.data),
    },
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  };
  return { db, runs, queued, moved };
}

const job = (id: string, nextRunAt: Date, over: Record<string, unknown> = {}) => ({
  id, schedule: "*/5 * * * *", timezone: "UTC", overlap: "skip", nextRunAt, enabled: true,
  app: { kind: "backend", deployTarget: "server", desiredState: "running", currentDeploymentId: "d1" }, ...over,
});

describe("the clock after downtime", () => {
  const now = new Date("2026-11-06T12:00:30Z");
  it("runs a job due just now, once, spread by its offset and with one attempt", async () => {
    const c = clock([job("a", new Date("2026-11-06T12:00:00Z"))]);
    await jobsTick(c.db as never, now);
    expect(c.runs).toHaveLength(1);
    expect(c.runs[0]).toMatchObject({ jobId: "a", status: "queued", trigger: "schedule" });
    expect(c.queued[0]).toMatchObject({ kind: "scheduled_run", lane: "cron", maxAttempts: 1 });
    expect((c.queued[0]!.runAfter as Date).getTime()).toBeGreaterThanOrEqual(Date.now() - 1000);
    expect(c.moved[0]!.nextRunAt).toEqual(new Date("2026-11-06T12:05:00Z"));
  });

  it("after a week down records one miss per job and queues nothing", async () => {
    const week = new Date(now.getTime() - 7 * 86_400_000);
    const c = clock(Array.from({ length: 40 }, (_, i) => job(`j${i}`, week)));
    await jobsTick(c.db as never, now);
    expect(c.queued).toEqual([]);
    expect(c.runs).toHaveLength(40);
    expect(new Set(c.runs.map((r) => r.status))).toEqual(new Set(["missed"]));
    for (const m of c.moved) expect((m.nextRunAt as Date).getTime()).toBeGreaterThan(now.getTime());
  });

  it("records a skip while the previous run goes on, and queues under replace", async () => {
    const skip = clock([job("a", new Date("2026-11-06T12:00:00Z"))], { active: true });
    await jobsTick(skip.db as never, now);
    expect(skip.runs[0]).toMatchObject({ status: "skipped" });
    expect(skip.queued).toEqual([]);
    const repl = clock([job("a", new Date("2026-11-06T12:00:00Z"), { overlap: "replace" })], { active: true });
    await jobsTick(repl.db as never, now);
    expect(repl.runs[0]).toMatchObject({ status: "queued" });
    expect(repl.queued).toHaveLength(1);
  });

  it("switches off a hand-edited schedule rather than staying due forever", async () => {
    const c = clock([job("a", new Date("2026-11-06T12:00:00Z"), { schedule: "garbage" })]);
    await jobsTick(c.db as never, now);
    expect(c.runs).toEqual([]);
    expect(c.moved).toEqual([]);
  });
});

describe("runs a dead worker left", () => {
  it("are settled as failed, their container removed, and told once", async () => {
    const row: Record<string, unknown> = {
      id: RUN, jobId: JOB, status: "running", createdAt: new Date("2026-11-06T12:00:00Z"),
      job: { name: "report", appId: APP, app: { id: APP, name: "web", environment: { name: "production", project: { slug: "shop" } } } },
    };
    const queued: unknown[] = [];
    const db = {
      $queryRaw: async () => [{ id: RUN }],
      scheduledJobRun: {
        findUnique: async () => row,
        findFirst: async () => null,
        updateMany: async (a: { data: Record<string, unknown> }) => {
          Object.assign(row, a.data);
          return { count: 1 };
        },
      },
      job: { findFirst: async () => null },
      $transaction: async (fn: (t: unknown) => unknown) => fn({ $executeRaw: async () => 0, job: { findFirst: async () => null, create: async (a: { data: unknown }) => { queued.push(a.data); return { id: "x" }; } } }),
    };
    const removed: string[] = [];
    const n = await settleOrphanRuns(db as never, { removeContainer: async (id: string) => void removed.push(id) } as never, "s1");
    expect(n).toBe(1);
    expect(row).toMatchObject({ status: "failed", reason: ORPHAN_REASON });
    expect(removed).toEqual([`dk-${APP}-job-1f0e0d0c`]);
    expect(queued).toHaveLength(1);
  });
});
