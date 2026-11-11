import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { DockerError, type DockerApi } from "@dockify/engine";
import { PermanentJobError } from "./errors.ts";
import { parsePower, runPower } from "./power.ts";

const APP = "0f0e0d0c-0000-4000-8000-0000000000aa";
const NAME = `dk-${APP}`;

function harness(app: Record<string, unknown> | null, opts: { container?: "running" | "stopped" | "missing" | "foreign"; inFlight?: boolean; previewInFlight?: boolean; crashes?: boolean } = {}) {
  const calls: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const jobs: Array<Record<string, unknown>> = [];
  const activity: Array<Record<string, unknown>> = [];
  // The container's live state: a stop or start changes what the next inspect reports.
  let live = opts.container ?? "running";
  const docker = {
    inspectContainer: async (name: string) => {
      calls.push(`inspect ${name}`);
      if (live === "missing") throw new DockerError(404, "no such container");
      const status = live === "stopped" ? "exited" : opts.crashes ? "restarting" : "running";
      return { Id: "c1", Config: { Labels: { "dockify.app": live === "foreign" ? "someone-else" : APP } }, State: { Status: status, Running: status !== "exited" } };
    },
    stopContainer: async (name: string) => {
      calls.push(`stop ${name}`);
      if (live === "stopped") throw new DockerError(304, "not modified");
      live = "stopped";
    },
    startContainer: async (name: string) => {
      calls.push(`start ${name}`);
      if (live === "running") throw new DockerError(304, "not modified");
      live = "running";
    },
  } as unknown as DockerApi;
  const db = {
    app: {
      findUnique: async () => app,
      update: async ({ data }: { data: Record<string, unknown> }) => { updates.push(data); return {}; },
      // The observed status is a compare-and-set over the status that was read.
      updateMany: async ({ data }: { data: Record<string, unknown> }) => { updates.push(data); return { count: 1 }; },
    },
    deployment: {
      // A preview deployment carries its preview id; a query scoped to previewId: null never sees it.
      findFirst: async ({ where }: { where: { previewId?: unknown } }) =>
        opts.inFlight || (opts.previewInFlight && where.previewId !== null) ? { id: "d" } : null,
    },
    activityLog: { create: async ({ data }: { data: Record<string, unknown> }) => { activity.push(data); return data; } },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({
      $executeRaw: async () => 0,
      job: { findFirst: async () => null, create: async ({ data }: { data: Record<string, unknown> }) => { jobs.push(data); return { id: "j" }; } },
    }),
  } as unknown as Db;
  return { db, docker, calls, updates, jobs, activity };
}

const app = (over: Record<string, unknown> = {}) => ({
  id: APP, serverId: "s1", name: "web", kind: "frontend", desiredState: "running", deployTarget: "server",
  status: "running", currentDeploymentId: "d1", containerStartedAt: null, deployments: [{ status: "ready" }], ...over,
});

describe("app_power", () => {
  it("validates the payload", () => {
    expect(() => parsePower({})).toThrow(PermanentJobError);
    expect(() => parsePower({ appId: APP, op: "kill" })).toThrow(PermanentJobError);
    expect(parsePower({ appId: APP, op: "restart" })).toEqual({ appId: APP, op: "restart" });
  });

  it("stops the canonical container, marks it stopped and resyncs the route", async () => {
    const h = harness(app({ desiredState: "stopped" }));
    expect(await runPower(h, { appId: APP, op: "stop" })).toBe("stopped");
    expect(h.calls).toEqual([`inspect ${NAME}`, `stop ${NAME}`, `inspect ${NAME}`]);
    expect(h.updates).toEqual([{ status: "stopped", containerId: "c1", containerStartedAt: null }]);
    expect(h.jobs[0]).toMatchObject({ kind: "edge_route_sync", lane: "maintenance", serverId: "s1", payload: { appId: APP }, dedupeKey: `edge.route:${APP}` });
  });

  it("restarts by stop then start, and a start of a running container is not an error", async () => {
    const h = harness(app());
    expect(await runPower(h, { appId: APP, op: "restart" })).toBe("restarted");
    expect(h.calls).toEqual([`inspect ${NAME}`, `stop ${NAME}`, `start ${NAME}`, `inspect ${NAME}`]);
    expect(h.updates).toEqual([{ status: "running", containerId: "c1", containerStartedAt: null }]);
  });

  it("a preview build of the app does not swallow a stop of the live container", async () => {
    const h = harness(app({ desiredState: "stopped" }), { previewInFlight: true });
    expect(await runPower(h, { appId: APP, op: "stop" })).toBe("stopped");
    expect(h.calls).toEqual([`inspect ${NAME}`, `stop ${NAME}`, `inspect ${NAME}`]);
  });

  it("converges on the row: a stale op, a deploy in flight or a Vercel app does nothing", async () => {
    const stale = harness(app({ desiredState: "running" }));
    expect(await runPower(stale, { appId: APP, op: "stop" })).toBe("skipped");
    expect(stale.calls).toEqual([]);
    const busy = harness(app(), { inFlight: true });
    expect(await runPower(busy, { appId: APP, op: "restart" })).toBe("skipped");
    expect(busy.calls).toEqual([]);
    expect(await runPower(harness(app({ deployTarget: "vercel" })), { appId: APP, op: "start" })).toBe("skipped");
    expect(await runPower(harness(null), { appId: APP, op: "start" })).toBe("skipped");
  });

  it("fails a start for good when the container is gone, and never touches a container it did not label", async () => {
    const gone = harness(app(), { container: "missing" });
    await expect(runPower(gone, { appId: APP, op: "start" })).rejects.toBeInstanceOf(PermanentJobError);
    // It went live once and has no container now: missing, not unknown.
    expect(gone.updates).toEqual([{ status: "missing", containerId: null }]);
    expect(gone.activity[0]).toMatchObject({ action: "app.start", failed: true, targetId: APP });
    const foreign = harness(app(), { container: "foreign" });
    await expect(runPower(foreign, { appId: APP, op: "restart" })).rejects.toBeInstanceOf(PermanentJobError);
    expect(foreign.calls).toEqual([`inspect ${NAME}`]);
  });

  it("writes what the daemon reports after a start, not an assumed running", async () => {
    const h = harness(app({ status: "stopped", desiredState: "running" }), { container: "stopped", crashes: true });
    expect(await runPower(h, { appId: APP, op: "start" })).toBe("started");
    expect(h.updates).toEqual([{ status: "restarting", containerId: "c1", containerStartedAt: null }]);
  });

  it("does not queue a route sync for an app without a route", async () => {
    const h = harness(app({ kind: "postgres" }), { container: "stopped" });
    expect(await runPower(h, { appId: APP, op: "start" })).toBe("started");
    expect(h.jobs).toHaveLength(0);
  });
});
