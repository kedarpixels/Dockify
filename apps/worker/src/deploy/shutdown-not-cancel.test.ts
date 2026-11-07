/**
 * A worker shutdown is not a person pressing cancel. The swap and the release command throw
 * DeployCancelled on either signal; the deploy must come back after the restart.
 */
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { DeployCancelled } from "@dockify/engine";
import { handleDeploy, type DeployDeps } from "./pipeline.ts";

const DEP = "0f0e0d0c-0000-4000-8000-0000000000d1";

/** `step`: the first thing the deploy does that reaches an unmodelled table throws what it throws. */
function world(step: () => Promise<never>, reads: string[] = []) {
  const writes: Array<Record<string, unknown>> = [];
  const logged: string[] = [];
  const row = { id: DEP, appId: "a1", previewId: null, status: "queued", steps: [], startedAt: null, envSecretId: null, app: { id: "a1", kind: "backend", deployTarget: "server", environmentId: "e1", environment: { projectId: "p1", project: {} } } };
  const known = {
    deployment: {
      findUnique: async () => ({ ...row, status: reads.shift() ?? "queued" }),
      findFirst: async () => null,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => (writes.push(data), { count: 1 }),
    },
    app: { findUnique: async () => null, update: async () => ({}) },
    previewDeployment: { findUnique: async () => null },
    deploymentLogChunk: { create: async ({ data }: { data: { gzip: Uint8Array } }) => (logged.push(gunzipSync(data.gzip).toString("utf8")), {}) },
    $queryRaw: async () => [{ logSeq: 1 }],
  };
  const db = new Proxy(known, {
    get: (t, k: string) => (k in t ? t[k as keyof typeof t] : new Proxy({}, { get: () => step })),
  });
  const deps = { db: db as unknown as Db, vault: {}, docker: {}, config: {}, cancelPollMs: 1 } as unknown as DeployDeps;
  return { writes, logged, deps };
}

const job = (attempts: number) => ({ id: "j1", kind: "deploy", payload: { deploymentId: DEP }, attempts, maxAttempts: 3 }) as never;
const statuses = (w: Array<Record<string, unknown>>) => w.map((x) => x.status).filter(Boolean);

describe("a worker shutdown during a deploy", () => {
  it("does not settle it as cancelled: it goes back to the queue, and the error reaches the lane to give the claim back", async () => {
    const stop = new AbortController();
    stop.abort();
    const w = world(async () => { throw new DeployCancelled(); });
    await expect(handleDeploy(w.deps, job(1), stop.signal)).rejects.toBeInstanceOf(DeployCancelled);
    expect(statuses(w.writes)).toEqual(["building", "queued"]);
    expect(w.logged.join("\n")).toMatch(/will resume/);
    expect(w.logged.join("\n")).not.toMatch(/deploy cancelled/);
  });

  it("does not fail it either on its last attempt, since the attempt is given back", async () => {
    const stop = new AbortController();
    stop.abort();
    const w = world(async () => { throw new Error("socket hang up"); });
    await expect(handleDeploy(w.deps, job(3), stop.signal)).rejects.toThrow("socket hang up");
    expect(statuses(w.writes)).toEqual(["building", "queued"]);
  });

  it("a real cancel still settles cancelled", async () => {
    const w = world(async () => {
      await new Promise((r) => setTimeout(r, 20));
      throw new DeployCancelled();
    }, ["queued", "queued", "cancelling", "cancelling", "cancelling"]);
    await handleDeploy(w.deps, job(1), new AbortController().signal).catch(() => undefined);
    expect(statuses(w.writes)).toContain("cancelled");
    expect(statuses(w.writes)).not.toContain("queued");
  });
});
