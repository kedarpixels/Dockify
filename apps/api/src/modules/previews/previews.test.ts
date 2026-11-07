import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { parsePullRequestEvent } from "../integrations/github/events.ts";
import { DEFAULT_PREVIEW_BASE, diskBlocks, diskPct, includedInPreviews, pickBaseEnvironment, planAdmission, previewHostname, type LivePreview } from "./logic.ts";
import { onPullRequest } from "./webhook.ts";

const NOW = new Date("2026-10-30T12:00:00Z");
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);

describe("preview rules", () => {
  it("includes frontend and backend by default, a bot only when marked, never a database", () => {
    const a = (kind: string, previewEnabled: boolean | null = null, git = true) => ({ kind, previewEnabled, gitRepository: git ? "https://github.com/a/b" : null, deployTarget: "server" });
    expect(includedInPreviews(a("frontend"))).toBe(true);
    expect(includedInPreviews(a("backend"))).toBe(true);
    expect(includedInPreviews(a("bot"))).toBe(false);
    expect(includedInPreviews(a("bot", true))).toBe(true);
    expect(includedInPreviews(a("postgres", true))).toBe(false);
    expect(includedInPreviews(a("frontend", false))).toBe(false);
    expect(includedInPreviews(a("frontend", null, false))).toBe(false);
  });
  it("names hosts pr-<n>-<app>.<domain> in one label", () => {
    expect(previewHostname(42, "web", "Preview.Example.com")).toBe("pr-42-web.preview.example.com");
  });
  it("guards disk above 85% from a fresh sample only", () => {
    expect(diskPct({ diskBytes: 90n, diskTotalBytes: 100n, at: min(1) }, NOW.getTime())).toBe(90);
    expect(diskBlocks(diskPct({ diskBytes: 90n, diskTotalBytes: 100n, at: min(1) }, NOW.getTime()))).toBe(true);
    expect(diskBlocks(diskPct({ diskBytes: 85n, diskTotalBytes: 100n, at: min(1) }, NOW.getTime()))).toBe(false);
    expect(diskPct({ diskBytes: 99n, diskTotalBytes: 100n, at: min(30) }, NOW.getTime())).toBeNull();
  });
});

describe("caps and eviction", () => {
  const live = (id: string, projectId: string, status: LivePreview["status"], idleMin: number): LivePreview => ({ id, projectId, prNumber: 1, status, lastActivity: min(idleMin) });
  it("admits under both caps", () => {
    expect(planAdmission([live("a", "p", "ready", 5)], "p", 2, 4)).toEqual({ kind: "admit", evict: [] });
  });
  it("evicts the oldest idle preview of the project at the project cap, asleep first", () => {
    const rows = [live("a", "p", "ready", 50), live("b", "p", "ready", 10)];
    expect(planAdmission(rows, "p", 2, 4)).toMatchObject({ kind: "admit", evict: [{ id: "a" }] });
    expect(planAdmission([...rows.slice(1), live("s", "p", "asleep", 1)], "p", 2, 4)).toMatchObject({ kind: "admit", evict: [{ id: "s" }] });
  });
  it("evicts across projects at the server cap", () => {
    const rows = [live("x", "q", "ready", 90), live("y", "q", "ready", 5), live("z", "r", "ready", 30), live("a", "p", "ready", 1)];
    expect(planAdmission(rows, "p", 2, 4)).toMatchObject({ kind: "admit", evict: [{ id: "x" }] });
  });
  it("never evicts a building preview; blocks when nothing else can go", () => {
    expect(planAdmission([live("a", "p", "building", 99), live("b", "p", "building", 99)], "p", 2, 4)).toEqual({ kind: "blocked", scope: "project" });
  });
});

// ------------------------------------------------------------------ webhook paths

const SHA = "a".repeat(40);
const repo = { id: 99, clone_url: "https://github.com/acme/shop.git", full_name: "acme/shop" };
const event = (action: string, o: { number?: number; fork?: boolean; merged?: boolean; sha?: string } = {}) => parsePullRequestEvent({
  action, number: o.number ?? 7, repository: repo,
  pull_request: {
    title: "Add cart", merged: o.merged ?? false, user: { login: "dev" },
    head: { ref: "feat/cart", sha: o.sha ?? SHA, repo: o.fork ? { id: 5, clone_url: "https://github.com/mallory/shop.git", full_name: "mallory/shop" } : repo },
    base: { repo },
  },
})!;

interface World {
  db: Db;
  envs: Map<string, Record<string, unknown>>;
  members: Array<Record<string, unknown>>;
  deployments: Array<Record<string, unknown>>;
  jobs: Array<Record<string, unknown>>;
}

function world(o: { disk?: number; dns?: string; fromForks?: boolean; cap?: number; serverCap?: number; others?: Array<Record<string, unknown>>; onlyProduction?: boolean; appOver?: Record<string, Record<string, unknown>> } = {}): World {
  const envs = new Map<string, Record<string, unknown>>();
  for (const e of o.others ?? []) envs.set(String(e.id), e);
  const members: Array<Record<string, unknown>> = [];
  const deployments: Array<Record<string, unknown>> = [];
  const domains: Array<{ hostname: string }> = [];
  const jobs: Array<Record<string, unknown>> = [];
  let n = 0;
  const id = () => `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`;
  const project = {
    id: "proj", gitRepoId: "99", previewMaxConcurrent: o.cap ?? 2, previewDomain: null, previewBaseEnv: "development", previewFromForks: o.fromForks ?? false, previewIsolatedDb: false,
    environments: [
      { id: "env-prod", name: "production", apps: [{ id: "prod-web", name: "web", kind: "frontend", previewEnabled: null, gitRepository: "https://github.com/acme/shop", deployTarget: "server" }] },
      {
        id: "env-dev", name: "development", apps: [
          { id: "dev-web", name: "web", kind: "frontend", previewEnabled: null, gitRepository: "https://github.com/acme/shop", deployTarget: "server" },
          { id: "dev-api", name: "api", kind: "backend", previewEnabled: null, gitRepository: "https://github.com/acme/shop", deployTarget: "server" },
          { id: "dev-db", name: "db", kind: "postgres", previewEnabled: null, gitRepository: null, deployTarget: "server" },
        ],
      },
    ]
      .filter((e) => !o.onlyProduction || e.name === "production")
      .map((e) => ({ ...e, apps: e.apps.map((a) => ({ ...a, ...o.appOver?.[a.id] })) })),
  };
  const match = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (v && typeof v === "object" && "in" in v ? (v.in as unknown[]).includes(row[k]) : row[k] === v));
  const tx = {
    $executeRaw: async () => 0,
    previewEnv: {
      findUnique: async ({ where }: { where: { id?: string; projectId_prNumber?: { projectId: string; prNumber: number } } }) => {
        if (where.id) return envs.get(where.id) ?? null;
        return [...envs.values()].find((e) => e.projectId === where.projectId_prNumber!.projectId && e.prNumber === where.projectId_prNumber!.prNumber) ?? null;
      },
      findMany: async ({ where }: { where: { status: { in: string[] } } }) => [...envs.values()].filter((e) => where.status.in.includes(String(e.status))),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: id(), lastRequestAt: null, ...data };
        envs.set(row.id, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(envs.get(where.id)!, data),
    },
    domain: {
      findUnique: async ({ where }: { where: { hostname?: string } }) => domains.find((d) => d.hostname === where.hostname) ?? null,
    },
    previewDeployment: {
      findUnique: async ({ where }: { where: { hostname?: string; envId_appId?: { envId: string; appId: string } } }) =>
        members.find((m) => (where.hostname ? m.hostname === where.hostname : m.envId === where.envId_appId!.envId && m.appId === where.envId_appId!.appId)) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: id(), ...data };
        members.push(row);
        return row;
      },
    },
    deployment: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => deployments.find((d) => match(d, { appId: where.appId, previewId: where.previewId }) && ["queued", "building"].includes(String(d.status))) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: id(), ...data };
        deployments.push(row);
        return row;
      },
    },
    job: {
      findFirst: async ({ where }: { where: { dedupeKey: string; lockedBy?: null } }) => jobs.find((j) => j.dedupeKey === where.dedupeKey && !j.done) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: id(), ...data };
        jobs.push(row);
        return row;
      },
    },
    app: { findUnique: async () => ({ serverId: "s1" }), update: async () => ({}), updateMany: async () => ({ count: 0 }) },
    server: { findFirst: async () => ({ id: "s1" }) },
  };
  const db = {
    ...tx,
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    project: { findMany: async () => [project] },
    instance: { findUnique: async () => ({ previewServerMax: o.serverCap ?? 4, previewDomain: null, publicUrl: "https://dash.example.com" }) },
    metricSample: { findFirst: async () => (o.disk === undefined ? null : { diskBytes: BigInt(o.disk), diskTotalBytes: 100n, at: min(1) }) },
    previewDomain: { findUnique: async () => ({ dnsStatus: o.dns ?? "ok", dnsDetail: o.dns === "missing" ? "No A record yet." : null }) },
  };
  return { db: db as unknown as Db, envs, members, deployments, jobs };
}

const kinds = (w: World) => w.jobs.map((j) => `${j.kind}:${String(j.dedupeKey).split(":")[0]}`);
const only = (w: World, pr = 7) => [...w.envs.values()].find((e) => e.prNumber === pr)!;

describe("which project a pull request belongs to", () => {
  it("goes by an app's own repository id, which the dashboard stores, over the project's", async () => {
    const w = world({ appOver: { "dev-web": { gitRepoId: "5" }, "dev-api": { gitRepoId: "5" } } });
    const pr = { ...event("opened"), repoId: "5", identity: "github.com/acme/renamed" };
    expect((await onPullRequest(w.db, pr, NOW)).projectId).toBe("proj");
  });
});

describe("a pull request and apps hosted on Vercel", () => {
  // The row holds both modes: the rule reads deployTarget, so a followed app and a deploy target are alike.
  const followed = { deployTarget: "vercel", vercelFollowOnly: true };
  const deployTarget = { deployTarget: "vercel", vercelFollowOnly: false };

  for (const [name, vercel] of [["followed", followed], ["deploy target", deployTarget]] as const) {
    it(`${name}: every app on Vercel makes no preview, no job and no build`, async () => {
      const w = world({ appOver: { "dev-web": vercel, "dev-api": vercel } });
      const out = await onPullRequest(w.db, event("opened"), NOW);
      expect(out.summary).toContain("no app in development is included");
      expect(w.envs.size).toBe(0);
      expect(w.members).toHaveLength(0);
      expect(w.deployments).toHaveLength(0);
      expect(w.jobs).toHaveLength(0);
    });

    it(`${name}: in a mix the server apps still preview, and the Vercel app stays out`, async () => {
      const w = world({ appOver: { "dev-web": vercel } });
      await onPullRequest(w.db, event("opened"), NOW);
      expect(only(w)).toMatchObject({ status: "building" });
      expect(w.members.map((m) => m.appId)).toEqual(["dev-api"]);
      expect(w.deployments.map((d) => d.appId)).toEqual(["dev-api"]);
      expect(w.jobs.filter((j) => j.kind === "deploy").map((j) => (j.payload as { appId: string }).appId)).toEqual(["dev-api"]);
    });

    it(`${name}: a mark left from its time on the server does not bring it back, on open or on a push`, async () => {
      const w = world({ appOver: { "dev-web": { ...vercel, previewEnabled: true } } });
      await onPullRequest(w.db, event("opened"), NOW);
      await onPullRequest(w.db, event("synchronize", { sha: "b".repeat(40) }), NOW);
      expect(new Set(w.members.map((m) => m.appId))).toEqual(new Set(["dev-api"]));
      expect(w.deployments.every((d) => d.appId === "dev-api")).toBe(true);
    });
  }

  it("the rule itself: on Vercel is never included, whatever the mark says", () => {
    for (const previewEnabled of [null, true, false]) {
      expect(includedInPreviews({ kind: "frontend", previewEnabled, gitRepository: "https://github.com/a/b", deployTarget: "vercel" })).toBe(false);
    }
  });
});

describe("pull_request webhook", () => {
  it("one environment: the preview uses it, always on its own database, never the real one", async () => {
    const w = world({ onlyProduction: true });
    await onPullRequest(w.db, event("opened"), NOW);
    expect(only(w)).toMatchObject({ status: "building", baseEnvironmentId: "env-prod", isolatedDb: true, fromFork: false });
  });

  it("a fork stays isolated on a project with one environment, and off unless opted in", async () => {
    const off = world({ onlyProduction: true });
    await onPullRequest(off.db, event("opened", { fork: true }), NOW);
    expect(off.deployments).toHaveLength(0);
    const on = world({ onlyProduction: true, fromForks: true });
    await onPullRequest(on.db, event("opened", { fork: true }), NOW);
    expect(only(on)).toMatchObject({ fromFork: true, isolatedDb: true });
  });

  it("two environments: the stored choices stand", async () => {
    const w = world();
    await onPullRequest(w.db, event("opened"), NOW);
    expect(only(w)).toMatchObject({ baseEnvironmentId: "env-dev", isolatedDb: false });
  });

  it("opened: builds pr-<n> from development with frontend and backend only, on the derived domain", async () => {
    const w = world();
    const out = await onPullRequest(w.db, event("opened"), NOW);
    expect(out.projectId).toBe("proj");
    const env = only(w);
    expect(env).toMatchObject({ status: "building", baseEnvironmentId: "env-dev", domain: "preview.example.com", repo: "acme/shop", commitSha: SHA, fromFork: false });
    expect(w.members.map((m) => [m.appId, m.hostname])).toEqual([["dev-web", "pr-7-web.preview.example.com"], ["dev-api", "pr-7-api.preview.example.com"]]);
    expect(w.deployments.map((d) => [d.appId, d.trigger, d.commitSha])).toEqual([["dev-web", "preview", SHA], ["dev-api", "preview", SHA]]);
    expect(kinds(w)).toContain("preview_feedback:preview_feedback");
  });

  it("two projects with the same app name and PR number: the second gets a name of its own, never an empty preview", async () => {
    const w = world();
    w.members.push({ id: "other", envId: "other-env", appId: "other-web", hostname: "pr-7-web.preview.example.com" });
    const out = await onPullRequest(w.db, event("opened"), NOW);
    expect(out.summary).not.toContain("hostname taken");
    expect(w.members.find((m) => m.appId === "dev-web")?.hostname).toBe("pr-7-web-proj.preview.example.com");
    expect(w.deployments.map((d) => d.appId)).toEqual(["dev-web", "dev-api"]);
  });

  it("synchronize: updates the same preview and builds the new commit", async () => {
    const w = world();
    await onPullRequest(w.db, event("opened"), NOW);
    for (const d of w.deployments) d.status = "ready";
    for (const j of w.jobs) j.done = true;
    const next = "b".repeat(40);
    await onPullRequest(w.db, event("synchronize", { sha: next }), NOW);
    expect(w.envs.size).toBe(1);
    expect(only(w)).toMatchObject({ status: "building", commitSha: next });
    expect(w.members).toHaveLength(2);
    expect(w.deployments.filter((d) => d.commitSha === next)).toHaveLength(2);
  });

  it("closed or merged: deletes it (teardown and a comment update queued)", async () => {
    for (const merged of [false, true]) {
      const w = world();
      await onPullRequest(w.db, event("opened"), NOW);
      const out = await onPullRequest(w.db, event("closed", { merged }), NOW);
      expect(only(w)).toMatchObject({ status: "closing", reason: merged ? "merged" : "closed" });
      expect(kinds(w)).toContain("preview_cleanup:preview_cleanup");
      expect(out.summary).toContain(merged ? "merged" : "closed");
    }
  });

  it("forks: skipped by default; with the opt-in they build, flagged so the worker gives them no secret", async () => {
    const off = world();
    const r = await onPullRequest(off.db, event("opened", { fork: true }), NOW);
    expect(off.envs.size).toBe(0);
    expect(r.summary).toContain("fork");
    const on = world({ fromForks: true });
    await onPullRequest(on.db, event("opened", { fork: true }), NOW);
    expect(only(on)).toMatchObject({ fromFork: true, status: "building" });
  });

  it("disk guard: above 85% no new preview starts, and the PR comment says why", async () => {
    const w = world({ disk: 91 });
    await onPullRequest(w.db, event("opened"), NOW);
    expect(only(w)).toMatchObject({ status: "blocked", reason: "disk" });
    expect(String(only(w).error)).toContain("91% full");
    expect(w.deployments).toHaveLength(0);
    expect(kinds(w)).toEqual(["preview_feedback:preview_feedback"]);
  });

  it("DNS gate: refuses until the preview domain resolves here, and queues a check", async () => {
    const w = world({ dns: "missing" });
    await onPullRequest(w.db, event("opened"), NOW);
    expect(only(w)).toMatchObject({ status: "blocked", reason: "dns" });
    expect(String(only(w).error)).toContain("does not resolve to this server");
    expect(kinds(w)).toEqual(expect.arrayContaining(["preview_dns:preview_dns", "preview_feedback:preview_feedback"]));
    expect(w.deployments).toHaveLength(0);
  });

  it("caps: at the project cap the oldest idle preview is evicted for the new PR, with a comment", async () => {
    const old = { id: "old", projectId: "proj", prNumber: 1, status: "ready", lastCommitAt: min(600), lastRequestAt: min(300) };
    const newer = { id: "newer", projectId: "proj", prNumber: 2, status: "ready", lastCommitAt: min(10), lastRequestAt: null };
    const w = world({ others: [old, newer] });
    await onPullRequest(w.db, event("opened", { number: 3 }), NOW);
    expect(w.envs.get("old")).toMatchObject({ status: "closing", reason: "evicted", error: "Evicted to make room for #3" });
    expect(w.envs.get("newer")).toMatchObject({ status: "ready" });
    expect(only(w, 3)).toMatchObject({ status: "building" });
    expect(w.jobs.filter((j) => j.dedupeKey === "preview_feedback:old")).toHaveLength(1);
  });

  it("caps: blocked with a reason when every preview is still building", async () => {
    const busy = (id: string, pr: number) => ({ id, projectId: "proj", prNumber: pr, status: "building", lastCommitAt: min(5), lastRequestAt: null });
    const w = world({ others: [busy("a", 1), busy("b", 2)] });
    await onPullRequest(w.db, event("opened", { number: 3 }), NOW);
    expect(only(w, 3)).toMatchObject({ status: "blocked", reason: "cap" });
  });

  it("caps: the server-wide cap evicts across projects", async () => {
    const other = (id: string, pr: number, idle: number) => ({ id, projectId: "other", prNumber: pr, status: "ready", lastCommitAt: min(idle), lastRequestAt: null });
    const w = world({ serverCap: 2, others: [other("x", 1, 100), other("y", 2, 5)] });
    await onPullRequest(w.db, event("opened"), NOW);
    expect(w.envs.get("x")).toMatchObject({ status: "closing", reason: "evicted" });
    expect(only(w)).toMatchObject({ status: "building" });
  });
});

describe("the default preview base", () => {
  const envs = (...names: string[]) => names.map((name) => ({ name }));
  it("is the one environment besides production when nobody picked one and it is not named development", () => {
    expect(pickBaseEnvironment(envs("production", "dev"), DEFAULT_PREVIEW_BASE)?.name).toBe("dev");
    expect(pickBaseEnvironment(envs("production", "development"), DEFAULT_PREVIEW_BASE)?.name).toBe("development");
  });
  it("never guesses between several, never production, and never past a base the owner named", () => {
    expect(pickBaseEnvironment(envs("production", "dev", "staging"), DEFAULT_PREVIEW_BASE)).toBeNull();
    expect(pickBaseEnvironment(envs("production", "dev"), "staging")).toBeNull();
    expect(pickBaseEnvironment(envs("production", "dev"), "production")?.name).toBe("production");
    expect(pickBaseEnvironment(envs("production"), DEFAULT_PREVIEW_BASE)?.name).toBe("production");
  });
});
