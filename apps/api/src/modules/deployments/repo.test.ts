/** Every deployment row and the preview row carry the app's repository, so the dashboard can link commits and branches. */
import { describe, expect, it } from "vitest";
import { toRow } from "../previews/handlers.ts";
import { recentDeployment } from "../projects/views.ts";
import { toRecent, type DeploymentRow } from "./mapping.ts";

const at = new Date("2026-10-30T12:00:00Z");
const base = { id: "d1", appId: "a1", status: "ready", commitSha: "4f2a9c1", branch: "main", message: "m", trigger: "push", imageId: "sha256:x", createdAt: at, finishedAt: at } as const;
const REPO = "https://github.com/acme/web";

describe("repo on deployment rows", () => {
  it("toRecent names the app's repository, and null for an image app", () => {
    const row = (gitRepository: string | null) =>
      ({ ...base, app: { id: "a1", name: "web", kind: "frontend", gitRepository, environment: { name: "production", project: { slug: "acme", id: "p1" } } } }) as unknown as DeploymentRow;
    expect(toRecent(row(REPO)).repo).toBe(REPO);
    expect(toRecent(row(null)).repo).toBeNull();
  });
  it("recentDeployment passes the repository through", () => {
    expect(recentDeployment({ ...base, status: "ready" } as never, { id: "a1", name: "web", kind: "frontend", repo: REPO }, "acme", "production").repo).toBe(REPO);
    expect(recentDeployment({ ...base, status: "ready" } as never, { id: "a1", name: "db", kind: "postgres", repo: null }, "acme", "production").repo).toBeNull();
  });
  it("a preview row links its base repository, and never a malformed one", () => {
    const row = (repo: string) => ({
      id: "pv", prNumber: 7, title: "t", author: null, branch: "feat", commitSha: "abc1234", status: "ready", reason: null, error: null, fromFork: false, isolatedDb: false,
      createdAt: at, updatedAt: at, lastCommitAt: at, lastRequestAt: null, sleptAt: null, repo, baseEnvironment: { name: "staging" }, project: { previewProductionAccess: false, environments: [{ id: "a" }, { id: "b" }] }, apps: [],
    });
    expect(toRow(row("acme/web") as never, 72).repo).toBe(REPO);
    expect(toRow(row("acme/web") as never, 72).isolation).toBe("base");
    expect(toRow(row("javascript:alert(1)") as never, 72).repo).toBeNull();
  });
});
