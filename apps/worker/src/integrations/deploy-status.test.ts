import { describe, expect, it, vi } from "vitest";
import type { Db, SecretVault } from "@dockify/db";
import { deployStatusContext, deployStatusFor, runDeployStatus } from "./deploy-status.ts";

vi.mock("../deploy/github.ts", async (real) => ({ ...(await real<object>()), installationCredential: async () => ({ username: "x-access-token", secret: "ghs_token" }) }));

const ID = "0f0e0d0c-0000-4000-8000-0000000000dd";
const SHA = "b".repeat(40);

type Row = { status: string; error: string | null };

/** The first read is the job's load; later reads are the look after a pending post. */
function world(first: Row, opts: { later?: Row; app?: string; environment?: string; environments?: number; answer?: number } = {}) {
  const calls: Array<{ state: string; description: string; context: string; target_url?: string }> = [];
  let reads = 0;
  const row = (r: Row) => ({
    ...r, commitSha: SHA,
    app: {
      name: opts.app ?? "web", gitRepository: "https://github.com/acme/shop", gitInstallation: { installationId: 7n },
      environment: { name: opts.environment ?? "production", project: { gitInstallation: null, _count: { environments: opts.environments ?? 1 } } },
    },
  });
  return {
    calls,
    deps: {
      db: {
        deployment: { findUnique: async () => row(reads++ === 0 ? first : opts.later ?? first) },
      } as unknown as Db,
      vault: {} as SecretVault,
      http: (async (r: { body?: string }) => (calls.push(JSON.parse(r.body!)), { status: opts.answer ?? 201, headers: {}, body: Buffer.from("{}") })) as never,
      apiBase: "https://api.github.com",
      publicUrl: "https://dash.example.com",
    },
  };
}

describe("the commit status of a deployment", () => {
  it("names one context per app, with the environment only when the project has several", () => {
    expect(deployStatusContext("web", "production", 1)).toBe("Dockify / web");
    expect(deployStatusContext("web", "staging", 2)).toBe("Dockify / staging / web");
    expect(deployStatusContext("web", "staging", undefined)).toBe("Dockify / staging / web");
  });

  it("is pending while in flight and settles on every way a deployment ends", () => {
    expect(deployStatusFor({ status: "queued", error: null })).toEqual({ state: "pending", description: "Queued" });
    expect(deployStatusFor({ status: "building", error: null })).toEqual({ state: "pending", description: "Building" });
    expect(deployStatusFor({ status: "deploying", error: null })).toEqual({ state: "pending", description: "Deploying" });
    expect(deployStatusFor({ status: "cancelling", error: null })).toEqual({ state: "pending", description: "Cancelling" });
    expect(deployStatusFor({ status: "ready", error: null })).toEqual({ state: "success", description: "Deployed" });
    expect(deployStatusFor({ status: "cancelled", error: null })).toEqual({ state: "error", description: "Cancelled" });
    expect(deployStatusFor({ status: "failed", error: "the container never answered" })).toEqual({ state: "failure", description: "Failed: the container never answered" });
  });

  it("apps built from one commit post under their own contexts, so none overwrites another", async () => {
    const api = world({ status: "ready", error: null }, { app: "backend" });
    const web = world({ status: "failed", error: "boom" }, { app: "frontend" });
    const queued = world({ status: "queued", error: null }, { app: "dashboard" });
    for (const w of [api, web, queued]) expect(await runDeployStatus(w.deps, { deploymentId: ID })).toBe("sent");
    expect(api.calls).toEqual([{ state: "success", description: "Deployed", context: "Dockify / backend", target_url: `https://dash.example.com/deployments/${ID}` }]);
    expect(web.calls[0]).toMatchObject({ state: "failure", description: "Failed: boom", context: "Dockify / frontend" });
    expect(queued.calls).toEqual([{ state: "pending", description: "Queued", context: "Dockify / dashboard", target_url: `https://dash.example.com/deployments/${ID}` }]);
  });

  it("carries the environment in a project with more than one", async () => {
    const w = world({ status: "building", error: null }, { environment: "staging", environments: 2 });
    await runDeployStatus(w.deps, { deploymentId: ID });
    expect(w.calls).toEqual([expect.objectContaining({ state: "pending", description: "Building", context: "Dockify / staging / web" })]);
  });

  it("a pending post that the deployment outran is followed by what it became", async () => {
    const w = world({ status: "deploying", error: null }, { later: { status: "ready", error: null } });
    expect(await runDeployStatus(w.deps, { deploymentId: ID })).toBe("sent");
    expect(w.calls.map((c) => [c.state, c.description])).toEqual([["pending", "Deploying"], ["success", "Deployed"]]);
    const still = world({ status: "building", error: null }, { later: { status: "deploying", error: null } });
    await runDeployStatus(still.deps, { deploymentId: ID });
    expect(still.calls).toHaveLength(1);
  });

  it("retries a pending post GitHub could not take, and drops one it refused", async () => {
    await expect(runDeployStatus(world({ status: "building", error: null }, { answer: 429 }).deps, { deploymentId: ID })).rejects.toThrow("429");
    const refused = world({ status: "building", error: null }, { later: { status: "ready", error: null }, answer: 422 });
    expect(await runDeployStatus(refused.deps, { deploymentId: ID })).toBe("skipped");
    expect(refused.calls).toHaveLength(1);
  });
});
