import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import type { HttpClient, HttpRequest, HttpResponse } from "@dockify/net-guard";
import { storeSecret } from "@dockify/db";
import { testRing } from "../../test-helpers.ts";
import { POLICIES } from "../../policy.ts";
import { defaultDeps } from "./deps.ts";
import { createIntegrationHandlers } from "./index.ts";
import { TOKEN_DEAD, vercelRetryAfter, vercelView } from "./vercel.ts";
import { clearVercelReadCache, projectLinks, repoOf } from "./vercel-project.ts";

/*
 * The read-only Vercel views of a followed app. The fixtures follow what Vercel's API answers today
 * (GET /v9/projects/:id, /v9/projects/:id/domains, /v10/projects/:id/env), recorded from a real
 * account and then rewritten with fictional names, ids, hosts and values.
 */

const ring = testRing();
const T0 = 1_794_059_215_111;

const meta = (branch: string, sha: string, message: string) => ({
  githubCommitAuthorName: "Rowan Pike",
  githubCommitAuthorEmail: "rowan@example.com",
  githubCommitMessage: message,
  githubCommitOrg: "acme-labs",
  githubCommitRef: branch,
  githubCommitRepo: "inkwell",
  githubCommitSha: sha,
  githubDeployment: "1",
  githubOrg: "acme-labs",
  githubRepo: "inkwell",
  githubRepoOwnerType: "Organization",
  githubCommitAuthorLogin: "rowanpike",
  branchAlias: `inkwell-web-git-${branch}-acme-labs.vercel.app`,
});

const PROD = {
  alias: ["inkwell-web-git-main-acme-labs.vercel.app", "inkwell.example", "inkwell-web.vercel.app"],
  aliasAssigned: T0 + 97_000,
  aliasError: null,
  automaticAliases: ["inkwell-web-git-main-acme-labs.vercel.app", "inkwell-web.vercel.app"],
  builds: [],
  createdAt: T0,
  createdIn: "iad1",
  creator: { uid: "usr_fict0001", email: "rowan@example.com", username: "rowanpike", githubLogin: "rowanpike" },
  deploymentHostname: "inkwell-web-4kq2m8vtx",
  forced: false,
  id: "dpl_7Hq2LmXo9RkTb3WnYc5Ze1Ua8Sdf",
  meta: meta("main", "9c0d4e2a71b5f3c8e6d9a0b1c2d3e4f5a6b7c8d9", "Fix the leaderboard month rollover\n\nLonger body that is not shown."),
  name: "inkwell-web",
  plan: "hobby",
  private: true,
  readyState: "READY",
  readySubstate: "PROMOTED",
  target: "production",
  teamId: "team_fict0001",
  type: "LAMBDAS",
  url: "inkwell-web-4kq2m8vtx-acme-labs.vercel.app",
  userId: "usr_fict0001",
  withCache: false,
  buildingAt: T0 + 1_241,
  readyAt: T0 + 97_596,
};

const PREVIEW = { ...PROD, id: "dpl_2Bc4De6Fg8Hi0Jk2Lm4No6Pq8Rst", target: null, readySubstate: "STAGED", alias: ["inkwell-web-git-feature-x-acme-labs.vercel.app"], meta: meta("feature-x", "1111111", "Try a thing") };

const PROJECT = {
  accountId: "team_fict0001",
  autoExposeSystemEnvs: true,
  buildCommand: "pnpm build",
  createdAt: T0 - 3_000_000,
  devCommand: null,
  directoryListing: false,
  env: [],
  framework: "nextjs",
  id: "prj_ink_web",
  installCommand: "pnpm install",
  name: "inkwell-web",
  nodeVersion: "22.x",
  outputDirectory: null,
  rootDirectory: "apps/web",
  serverlessFunctionRegion: "iad1",
  sourceFilesOutsideRootDirectory: true,
  updatedAt: T0,
  live: false,
  link: { type: "github", repo: "inkwell", repoId: 1001, org: "acme-labs", repoOwnerId: 2002, productionBranch: "main", sourceless: true, createdAt: T0, updatedAt: T0, deployHooks: [] },
  latestDeployments: [PREVIEW, PROD],
  targets: { production: PROD, preview: PREVIEW },
};

const DOMAINS = {
  domains: [
    { name: "inkwell.example", apexName: "inkwell.example", projectId: "prj_ink_web", redirect: null, redirectStatusCode: null, gitBranch: null, customEnvironmentId: null, updatedAt: T0, createdAt: T0, verified: true },
    { name: "www.inkwell.example", apexName: "inkwell.example", projectId: "prj_ink_web", redirect: "inkwell.example", redirectStatusCode: 308, gitBranch: null, customEnvironmentId: null, updatedAt: T0, createdAt: T0, verified: true },
    { name: "beta.inkwell.example", apexName: "inkwell.example", projectId: "prj_ink_web", redirect: null, redirectStatusCode: null, gitBranch: "beta", customEnvironmentId: null, updatedAt: T0, createdAt: T0, verified: false },
  ],
  pagination: { count: 3, next: null, prev: T0 },
};

const ENCRYPTED_BLOB = "eyJ2IjoidjIiLCJlcGsiOnsia3R5IjoiRUMiLCJjcnYiOiJQLTI1NiJ9fQ.fictional-ciphertext";
const ENV = {
  envs: [
    { type: "encrypted", key: "DATABASE_URL", value: ENCRYPTED_BLOB, target: ["production", "preview"], configurationId: null, createdAt: T0, updatedAt: T0 + 5_000, createdBy: "usr_fict0001", updatedBy: null, id: "env_db01", decrypted: false, lastEditedByDisplayName: "rowanpike", securityIssues: [] },
    { type: "plain", key: "NEXT_PUBLIC_SITE_URL", value: "https://inkwell.example", target: ["production"], comment: "Public site address", createdAt: T0, updatedAt: T0, id: "env_url1", decrypted: false },
    { type: "sensitive", key: "STRIPE_SECRET_KEY", value: "", target: ["production"], createdAt: T0, updatedAt: T0, id: "env_str1", decrypted: false },
    { type: "plain", key: "NEXT_PUBLIC_SITE_URL", value: "https://beta.inkwell.example", target: "preview", gitBranch: "beta", createdAt: T0, updatedAt: T0, id: "env_url2", decrypted: false },
  ],
  hiddenProductionEnvCount: 0,
};

const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}): HttpResponse => ({ status, headers, body: Buffer.from(JSON.stringify(body)) });
const ADMIN = { kind: "session", userId: "u1", sessionId: "s1", name: "Sam", role: "admin", elevated: false };
const VIEWER = { ...ADMIN, role: "viewer" };

type Route = (r: HttpRequest) => HttpResponse | undefined;

async function harness(opts: { app?: Record<string, unknown>; route?: Route; config?: Record<string, unknown> } = {}) {
  const calls: HttpRequest[] = [];
  const secrets = new Map<string, Record<string, unknown>>();
  const app = { id: "a1", deployTarget: "vercel", vercelProjectId: "prj_ink_web", environment: { projectId: "p1" }, ...opts.app };
  const integration: Record<string, unknown> = {
    id: "i1", kind: "vercel", name: "default", status: "connected", error: null, createdAt: new Date(T0),
    config: { username: "rowanpike", name: null, team: { id: "team_fict0001", name: "Acme Labs", slug: "acme-labs" }, ...opts.config }, secondSecretId: null,
  };
  const tx = {
    app: { findUnique: async () => app, findMany: async () => [] },
    integration: { findUnique: async () => integration },
    secret: {
      create: async ({ data }: { data: Record<string, unknown> }) => (secrets.set(String(data.id), data), data),
      findUnique: async ({ where }: { where: { id: string } }) => secrets.get(where.id) ?? null,
    },
    deployment: { findFirst: async ({ where }: { where: { externalId: string } }) => (where.externalId === PROD.id ? { id: "d-prod" } : null) },
  };
  const db = { ...tx, $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx) } as unknown as Db;
  integration.secretId = await storeSecret(db as never, ring, { kind: "integration_token", ownerType: "integration", ownerId: "i1" }, "the-token", null);
  const http: HttpClient = async (r) => {
    calls.push(r);
    const custom = opts.route?.(r);
    if (custom) return custom;
    const path = new URL(r.url).pathname;
    if (path === "/v9/projects/prj_ink_web") return res(200, PROJECT);
    if (path === "/v9/projects/prj_ink_web/domains") return res(200, DOMAINS);
    if (path === "/v10/projects/prj_ink_web/env") return res(200, ENV);
    return res(404, { error: { code: "not_found" } });
  };
  const handlers = createIntegrationHandlers(defaultDeps({ http }));
  const read = (id: "apps.vercel.project" | "apps.vercel.env", actor: unknown = ADMIN) => handlers[id]!({ params: { id: "a1" }, query: {}, body: {}, actor, req: { headers: {}, log: { warn() {} } }, reply: {}, ctx: { db, ring } } as never) as Promise<Record<string, unknown>>;
  return { db, calls, read, integration };
}

afterEach(() => clearVercelReadCache());

describe("apps.vercel.project", () => {
  it("shows what production serves, the project settings and its domains", async () => {
    const h = await harness();
    const v = await h.read("apps.vercel.project");
    expect(v).toMatchObject({
      id: "prj_ink_web",
      name: "inkwell-web",
      framework: "nextjs",
      nodeVersion: "22.x",
      rootDirectory: "apps/web",
      buildCommand: "pnpm build",
      installCommand: "pnpm install",
      outputDirectory: null,
      repo: { provider: "github", slug: "acme-labs/inkwell", url: "https://github.com/acme-labs/inkwell", productionBranch: "main" },
      links: {
        project: "https://vercel.com/acme-labs/inkwell-web",
        env: "https://vercel.com/acme-labs/inkwell-web/settings/environment-variables",
        domains: "https://vercel.com/acme-labs/inkwell-web/settings/domains",
      },
      domainsError: null,
    });
    expect(v.production).toEqual({
      id: PROD.id,
      url: "https://inkwell-web-4kq2m8vtx-acme-labs.vercel.app",
      inspectorUrl: "https://vercel.com/acme-labs/inkwell-web/7Hq2LmXo9RkTb3WnYc5Ze1Ua8Sdf",
      status: "ready",
      target: "production",
      branch: "main",
      commit: "9c0d4e2a71b5f3c8e6d9a0b1c2d3e4f5a6b7c8d9",
      message: "Fix the leaderboard month rollover",
      commitUrl: "https://github.com/acme-labs/inkwell/commit/9c0d4e2a71b5f3c8e6d9a0b1c2d3e4f5a6b7c8d9",
      author: "rowanpike",
      createdAt: new Date(T0).toISOString(),
      readyAt: new Date(T0 + 97_596).toISOString(),
      durationMs: 97_596 - 1_241,
      // The custom domain leads; Vercel's own names follow.
      aliases: ["inkwell.example", "inkwell-web-git-main-acme-labs.vercel.app", "inkwell-web.vercel.app"],
      deploymentId: "d-prod",
    });
    expect(v.domains).toEqual([
      { name: "inkwell.example", verified: true, redirect: null, redirectStatusCode: null, gitBranch: null, createdAt: new Date(T0).toISOString() },
      { name: "www.inkwell.example", verified: true, redirect: "inkwell.example", redirectStatusCode: 308, gitBranch: null, createdAt: new Date(T0).toISOString() },
      { name: "beta.inkwell.example", verified: false, redirect: null, redirectStatusCode: null, gitBranch: "beta", createdAt: new Date(T0).toISOString() },
    ]);
  });

  it("only ever reads Vercel, in the linked team, with the stored token", async () => {
    const h = await harness();
    await h.read("apps.vercel.project");
    await h.read("apps.vercel.env");
    expect(h.calls.length).toBeGreaterThan(0);
    for (const c of h.calls) {
      expect(c.method).toBe("GET");
      expect(c.body).toBeUndefined();
      expect(new URL(c.url).searchParams.get("teamId")).toBe("team_fict0001");
      expect(c.url).not.toMatch(/decrypt/);
      expect(c.headers?.Authorization).toBe("Bearer the-token");
    }
  });

  it("serves every tab from one read for a minute", async () => {
    const h = await harness();
    await Promise.all([h.read("apps.vercel.project"), h.read("apps.vercel.project")]);
    await h.read("apps.vercel.project");
    await h.read("apps.vercel.env");
    // project and domains once each, env once; the env view reuses the cached project for its link.
    expect(h.calls.map((c) => new URL(c.url).pathname).sort()).toEqual(["/v10/projects/prj_ink_web/env", "/v9/projects/prj_ink_web", "/v9/projects/prj_ink_web/domains"]);
  });

  it("still shows the project when only its domains fail", async () => {
    const h = await harness({ route: (r) => (r.url.includes("/domains") ? res(500) : undefined) });
    const v = await h.read("apps.vercel.project");
    expect(v.domains).toEqual([]);
    expect(v.domainsError).toBe("Vercel returned 500");
    expect(v.production).not.toBeNull();
  });

  it("says a dead token plainly, with what to do", async () => {
    const h = await harness({ route: () => res(403, { error: { code: "forbidden", invalidToken: true } }) });
    await expect(h.read("apps.vercel.project")).rejects.toMatchObject({ status: 409, code: "VERCEL_TOKEN", message: TOKEN_DEAD });
  });

  it("says a project Vercel no longer has", async () => {
    const h = await harness({ app: { vercelProjectId: "prj_gone" } });
    await expect(h.read("apps.vercel.project")).rejects.toMatchObject({ status: 404, code: "VERCEL_PROJECT_GONE" });
  });

  it("refuses an app that is not linked, before any call", async () => {
    const h = await harness({ app: { deployTarget: "server", vercelProjectId: null } });
    await expect(h.read("apps.vercel.project")).rejects.toMatchObject({ status: 409, code: "NOT_VERCEL_TARGET" });
    expect(h.calls).toEqual([]);
  });

  it("keeps a project-limited token to its projects", async () => {
    const h = await harness();
    const token = { kind: "token", tokenId: "t1", userId: "u1", name: "ci", role: "viewer", scope: "read", allProjects: false, projectIds: ["p2"], grants: [], elevated: false };
    await expect(h.read("apps.vercel.project", token)).rejects.toMatchObject({ status: 403 });
    expect(h.calls).toEqual([]);
  });

  it("builds no vercel.com link from a name that is not one", () => {
    expect(projectLinks("acme-labs", "../x").project).toBe("https://vercel.com/dashboard");
    expect(projectLinks(null, "web").env).toBe("https://vercel.com/dashboard");
    expect(repoOf({ type: "github", org: "acme", repo: "a/b" })).toBeNull();
    expect(repoOf({ type: "gitlab", projectNamespace: "group/sub", projectName: "site" })).toMatchObject({ url: "https://gitlab.com/group/sub/site" });
  });
});

describe("apps.vercel.env", () => {
  it("lists every variable, and shows an admin plain values only", async () => {
    const h = await harness();
    const v = await h.read("apps.vercel.env");
    expect(v).toMatchObject({ values: true, hiddenProductionCount: 0, manageUrl: "https://vercel.com/acme-labs/inkwell-web/settings/environment-variables" });
    expect(v.variables).toEqual([
      { id: "env_db01", key: "DATABASE_URL", targets: ["production", "preview"], type: "encrypted", gitBranch: null, comment: null, updatedAt: new Date(T0 + 5_000).toISOString(), value: null },
      { id: "env_url2", key: "NEXT_PUBLIC_SITE_URL", targets: ["preview"], type: "plain", gitBranch: "beta", comment: null, updatedAt: new Date(T0).toISOString(), value: "https://beta.inkwell.example" },
      { id: "env_url1", key: "NEXT_PUBLIC_SITE_URL", targets: ["production"], type: "plain", gitBranch: null, comment: "Public site address", updatedAt: new Date(T0).toISOString(), value: "https://inkwell.example" },
      { id: "env_str1", key: "STRIPE_SECRET_KEY", targets: ["production"], type: "sensitive", gitBranch: null, comment: null, updatedAt: new Date(T0).toISOString(), value: null },
    ]);
    // The encrypted blob Vercel sends in the list never leaves the API.
    expect(JSON.stringify(v)).not.toContain(ENCRYPTED_BLOB);
  });

  it("gives a viewer the keys and nothing else", async () => {
    const h = await harness();
    const v = await h.read("apps.vercel.env", VIEWER);
    expect(v.values).toBe(false);
    for (const e of v.variables as Array<{ value: unknown; comment: unknown }>) expect([e.value, e.comment]).toEqual([null, null]);
  });

  it("gives an admin's API token no values either", async () => {
    const h = await harness();
    const token = { kind: "token", tokenId: "t1", userId: "u1", name: "ci", role: "admin", scope: "admin", allProjects: true, projectIds: [], grants: [], elevated: false };
    const v = await h.read("apps.vercel.env", token);
    expect(v.values).toBe(false);
    expect(JSON.stringify(v)).not.toContain("https://inkwell.example");
  });

  it("is a read any viewer may make", () => {
    expect(POLICIES["apps.vercel.env"]).toMatchObject({ access: "session", role: "viewer" });
    expect(POLICIES["apps.vercel.project"]).toMatchObject({ access: "session", role: "viewer" });
  });
});

describe("Vercel's 429", () => {
  it("waits out a short limit once and answers", async () => {
    let first = true;
    const h = await harness({ route: (r) => (r.url.includes("/env") && first ? ((first = false), res(429, { error: { code: "rate_limited" } }, { "retry-after": "0" })) : undefined) });
    const v = await h.read("apps.vercel.env");
    expect((v.variables as unknown[]).length).toBe(4);
  });

  it("answers a long one with when to try again, and holds it without calling Vercel", async () => {
    const reset = String(Math.ceil(Date.now() / 1000) + 40);
    const h = await harness({ route: (r) => (r.url.includes("/env") ? res(429, { error: { code: "rate_limited" } }, { "x-ratelimit-reset": reset }) : undefined) });
    const e = await h.read("apps.vercel.env").catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 429, code: "VERCEL_RATE_LIMITED" });
    expect((e as { message: string }).message).toMatch(/^Vercel is limiting requests from this token\. Try again in (39|40|41) seconds\.$/);
    const envCalls = () => h.calls.filter((c) => c.url.includes("/env")).length;
    const before = envCalls();
    await expect(h.read("apps.vercel.env")).rejects.toMatchObject({ code: "VERCEL_RATE_LIMITED" });
    expect(envCalls()).toBe(before);
  });

  it("reads the wait from Retry-After, a date, or the reset header", () => {
    const now = 1_000_000_000_000;
    expect(vercelRetryAfter({ "retry-after": "12" }, now)).toBe(12);
    expect(vercelRetryAfter({ "retry-after": new Date(now + 30_000).toUTCString() }, now)).toBe(30);
    expect(vercelRetryAfter({ "x-ratelimit-reset": String(now / 1000 + 90) }, now)).toBe(90);
    expect(vercelRetryAfter({}, now)).toBe(60);
  });
});

describe("the Vercel card", () => {
  it("asks for a new token once the mirror finds the stored one refused", async () => {
    const h = await harness({ config: { mirror: { syncedAt: null, error: "Vercel refused the stored token; reconnect Vercel" } } });
    const db = { ...h.db, app: { findMany: async () => [] }, secret: { findUnique: async () => ({ hint: "abcd" }) } } as unknown as Db;
    const v = await vercelView(db);
    expect(v?.error).toBe(TOKEN_DEAD);
  });

  it("stops asking once a new token for the same scope is in, and keeps the rest", async () => {
    const h = await harness({ config: { webhook: { id: "hook_1", state: "active" }, mirror: { syncedAt: "2026-11-07T12:00:00.000Z", error: "Vercel refused the stored token; reconnect Vercel" } } });
    const updates: Array<Record<string, unknown>> = [];
    const integration = h.integration;
    const tx = {
      $executeRaw: async () => 0,
      integration: {
        findUnique: async () => integration,
        update: async ({ data }: { data: Record<string, unknown> }) => (updates.push(data), Object.assign(integration, data)),
      },
      secret: { create: async ({ data }: { data: Record<string, unknown> }) => data, findUnique: async () => ({ hint: "wxyz" }), delete: async () => ({}) },
      activityLog: { create: async () => ({}) },
      app: { findMany: async () => [] },
    };
    const db = { ...tx, $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx) } as unknown as Db;
    const http: HttpClient = async (r) =>
      r.url.includes("/v2/user") ? res(200, { user: { username: "rowanpike", name: null } }) : res(200, { teams: [{ id: "team_fict0001", name: "Acme Labs", slug: "acme-labs" }] });
    const handlers = createIntegrationHandlers(defaultDeps({ http }));
    const out = (await handlers["integrations.vercel.connect"]!({ body: { token: "a-new-token", teamId: "team_fict0001" }, actor: { ...ADMIN, elevated: true }, req: { clientIp: "1.1.1.1", headers: {} }, ctx: { db, ring } } as never)) as { error: string | null };
    expect(out.error).toBeNull();
    const config = integration.config as { webhook: unknown; mirror: { syncedAt: string; error: unknown } };
    expect(config.webhook).toEqual({ id: "hook_1", state: "active" });
    expect(config.mirror).toEqual({ syncedAt: "2026-11-07T12:00:00.000Z", error: null });
  });
});
