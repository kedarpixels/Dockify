/**
 * The last guard against a second copy: a deploy job for an app hosted on Vercel, queued before the
 * app moved there (or promoted from a coalesced push), builds nothing and starts no container.
 */
import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { handleDeploy, type DeployDeps } from "./pipeline.ts";

const DEP = "0f0e0d0c-0000-4000-8000-0000000000d1";
const untouched = (name: string) => new Proxy({}, { get: () => { throw new Error(`${name} touched`); } });

function world(row: Record<string, unknown>) {
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    deployment: {
      findUnique: async () => ({ id: DEP, appId: "a1", previewId: null, status: "queued", steps: [], startedAt: null, app: { id: "a1", deployTarget: "vercel" }, ...row }),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => (writes.push(data), { count: 1 }),
    },
    previewDeployment: { findUnique: async () => null },
    deploymentLogChunk: { create: async () => ({}) },
    $queryRaw: async () => [{ logSeq: 1 }],
  };
  return {
    writes,
    deps: { db: db as unknown as Db, vault: untouched("vault"), docker: untouched("docker"), config: {} } as unknown as DeployDeps,
  };
}

const job = { id: "j1", kind: "deploy", payload: { deploymentId: DEP }, attempts: 1, maxAttempts: 3 } as never;

describe("a deploy job for an app on Vercel", () => {
  it("settles cancelled without touching Docker, so no build and no status from a missing container", async () => {
    const w = world({});
    await handleDeploy(w.deps, job, new AbortController().signal);
    expect(w.writes).toHaveLength(1);
    expect(w.writes[0]).toMatchObject({ status: "cancelled", error: null });
  });
});
