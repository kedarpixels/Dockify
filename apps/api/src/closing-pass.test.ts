/** Behaviours that once failed on a running server, on the api's side. */
import { describe, expect, it } from "vitest";
import { auth as A, integrations as I } from "@dockify/contracts";
import type { Db } from "@dockify/db";
import { MailError } from "@dockify/email";
import { mailProblem } from "./modules/integrations/email.ts";
import { importChanges, importableDomains } from "./modules/integrations/vercel.ts";
import { clearStatusCache, publicStatus, statusPageGet } from "./modules/observe/status.ts";
import { pinnedBranch } from "./modules/projects/app-source.ts";
import { toRow } from "./modules/previews/handlers.ts";
import { ASLEEP_PAGE } from "./modules/previews/asleep-route.ts";

describe("a refused send is not a refused login", () => {
  it("only a refused login blames the login", () => {
    expect(mailProblem(new MailError("auth", "bad", { field: "password", smtpCode: 535 }), "x")).toMatchObject({ status: 400, code: "EMAIL_LOGIN", extra: { field: "password" } });
    const r = mailProblem(new MailError("recipient", "The mail server refused this recipient.", { smtpCode: 550, detail: "550 no such user" }), "x");
    expect(r.code).toBe("EMAIL_REFUSED");
    expect(r.message).toContain("550 no such user");
    expect(mailProblem(new Error("boom"), "send it")).toMatchObject({ status: 502, code: "EMAIL_FAILED", message: "Could not send it" });
  });
});

describe("the invite contract", () => {
  it("carries what became of the email", () => {
    const row = { id: "i", email: "a@b.dev", role: "viewer", createdAt: "2026-11-06T00:00:00.000Z", expiresAt: "2026-11-13T00:00:00.000Z" };
    expect(A.TeamInvite.safeParse({ ...row, emailStatus: "failed", emailError: "refused" }).success).toBe(true);
    expect(A.TeamInvite.safeParse({ ...row, emailStatus: null, emailError: null }).success).toBe(true);
    expect(A.TeamInvite.safeParse({ ...row, emailStatus: "maybe", emailError: null }).success).toBe(false);
  });
});

describe("a failed preview's link", () => {
  const row = (over: { status?: string; currentDeploymentId?: string | null }) =>
    ({
      id: "e", prNumber: 3, title: "t", author: null, branch: "b", commitSha: null, status: over.status ?? "failed", reason: null, error: "x", fromFork: false, isolatedDb: false,
      createdAt: new Date(0), updatedAt: new Date(0), lastCommitAt: new Date(0), lastRequestAt: null, sleptAt: null, repo: "a/b", baseEnvironment: { name: "production" }, project: { previewProductionAccess: false, environments: [{ id: "e" }] },
      apps: [{ hostname: "pr-3-web.preview.example.com", cpuPct: null, memoryBytes: null, currentDeploymentId: over.currentDeploymentId ?? null, app: { id: "a", name: "web", kind: "frontend", port: 3000, gitRepository: null }, deployments: [] }],
    }) as unknown as Parameters<typeof toRow>[0];
  it("is offered only while something answers there", () => {
    expect(toRow(row({}), 72).url).toBeNull();
    // The card reads this: a one-environment project's preview, with nothing allowed.
    expect(toRow(row({}), 72).isolation).toBe("own");
    expect(toRow(row({ currentDeploymentId: "d" }), 72).url).toBe("https://pr-3-web.preview.example.com");
  });
});

describe("an app follows its environment's branch unless someone picked another", () => {
  it("stores no pin for the environment's own branch", () => {
    expect(pinnedBranch("main", "main")).toBeNull();
    expect(pinnedBranch("feature/x", "main")).toBe("feature/x");
    expect(pinnedBranch(null, "main")).toBeNull();
  });
});

describe("a status page lists something", () => {
  const APP = "11111111-1111-4111-8111-111111111111";
  const world = (items: unknown[], apps: unknown[]) =>
    ({
      project: {
        findUnique: async () => ({
          id: "p1", slug: "shop", name: "Shop", archivedAt: null,
          statusPage: { id: "sp", enabled: true, title: null, logoUrl: null, items, incidents: [], _count: { items: items.length } },
        }),
      },
      app: { findMany: async () => apps },
      appUptimeDay: { findMany: async () => [] },
      alertEvent: { findMany: async () => [] },
    }) as unknown as Db;
  const app = { id: APP, status: "running", reachable: true, reachableAt: null, domains: [{ hostname: "shop.example.com" }] };

  it("with nothing chosen, lists apps with a public domain under that domain, never the internal name", async () => {
    clearStatusCache();
    const out = await publicStatus(world([], [{ ...app, name: "internal-name" }]), "shop");
    expect(out.components.map((c) => c.name)).toEqual(["shop.example.com"]);
    expect(JSON.stringify(out)).not.toContain("internal-name");
  });
  it("what someone chose wins", async () => {
    clearStatusCache();
    const out = await publicStatus(world([{ label: "Website", appId: APP, app }], [app]), "shop");
    expect(out.components.map((c) => c.name)).toEqual(["Website"]);
  });
  it("the settings card counts the same apps, so it stops saying none exist", async () => {
    expect(await statusPageGet(world([], [app]), null, "shop")).toMatchObject({ enabled: true, publicApps: 1 });
    expect(await statusPageGet(world([], []), null, "shop")).toMatchObject({ publicApps: 0 });
  });
});

describe("a Vercel import", () => {
  const env = { id: "e", name: "production" };
  it("keeps a browser-facing variable plain and on the build, and everything else secret", () => {
    const out = importChanges([{ key: "NEXT_PUBLIC_API_URL", value: "https://x" }, { key: "API_KEY", value: "s" }], new Map(), env);
    expect(out[0]).toMatchObject({ key: "NEXT_PUBLIC_API_URL", secret: false, target: "both" });
    expect(out[1]).toMatchObject({ key: "API_KEY", secret: true });
  });
  it("never offers a vercel.app name, and reports what it left out", () => {
    expect(importableDomains([{ name: "x.vercel.app" }, { name: "Shop.example.com" }])).toEqual(["shop.example.com"]);
    expect(I.VercelImportResult.parse({ variables: 2, domains: 0, domainsSkipped: 2 }).domainsSkipped).toBe(2);
  });
});

describe("the asleep page", () => {
  it("says what happened and names nothing", () => {
    expect(ASLEEP_PAGE).toContain("This preview is asleep");
    expect(ASLEEP_PAGE).toContain('name="robots" content="noindex"');
    expect(ASLEEP_PAGE).not.toMatch(/<script|<link|https?:/);
  });
});
