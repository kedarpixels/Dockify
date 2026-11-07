import { previewHostname } from "../../previews/logic.ts";
import { describe, expect, it } from "vitest";
import {
  manageUrl, matchPushTargets, parseInstallationEvent, parsePullRequestEvent, parsePushEvent,
  repoIdentity,
} from "./events.ts";

const SHA = "a".repeat(40);
const repo = { id: 99, clone_url: "https://github.com/Acme/Shop.git", full_name: "Acme/Shop" };

describe("repoIdentity", () => {
  it("normalises https and scp forms to one identity", () => {
    expect(repoIdentity("https://github.com/Acme/Shop.git")).toBe("github.com/acme/shop");
    expect(repoIdentity("https://github.com/acme/shop/")).toBe("github.com/acme/shop");
    expect(repoIdentity("git@github.com:acme/shop.git")).toBe("github.com/acme/shop");
  });
  it("refuses shapes that are not owner/repo", () => {
    expect(repoIdentity("https://github.com/acme")).toBeNull();
    expect(repoIdentity("https://github.com/a/b/c")).toBeNull();
    expect(repoIdentity("ftp://github.com/a/b")).toBeNull();
  });
});

describe("push", () => {
  const push = parsePushEvent({ ref: "refs/heads/main", after: SHA, head_commit: { id: SHA, message: "fix: thing\n\nbody" }, repository: repo, installation: { id: 7 } });
  it("parses a branch push", () => {
    expect(push).toEqual({ identity: "github.com/acme/shop", repoId: "99", branch: "main", deleted: false, commitSha: SHA, message: "fix: thing", author: null, authorAvatarUrl: null, authorName: null, installationId: "7" });
  });
  it("carries the git name only when no account is behind the head commit", () => {
    const base = { ref: "refs/heads/main", after: SHA, repository: repo };
    expect(parsePushEvent({ ...base, head_commit: { id: SHA, author: { name: " Jane\u0007 Doe\n" } }, sender: { login: "lena" } })).toMatchObject({ author: "lena", authorName: "Jane  Doe" });
    expect(parsePushEvent({ ...base, head_commit: { id: SHA, author: { username: "sam", name: "Sam P" } } })?.authorName).toBeNull();
  });
  it("names the head commit's author login, else the pusher, lowercased and only when valid", () => {
    const base = { ref: "refs/heads/main", after: SHA, repository: repo };
    expect(parsePushEvent({ ...base, head_commit: { id: SHA, author: { username: "Sam" } }, sender: { login: "bot" } })?.author).toBe("sam");
    expect(parsePushEvent({ ...base, head_commit: { id: SHA, author: { name: "No Account" } }, sender: { login: "Lena-K" } })?.author).toBe("lena-k");
    expect(parsePushEvent({ ...base, head_commit: { id: SHA, author: { username: "-bad-" } }, sender: { login: "a--b" } })?.author).toBeNull();
  });
  it("keeps the pusher's avatar only when the pusher is the author, and only from GitHub's avatar host", () => {
    const base = { ref: "refs/heads/main", after: SHA, repository: repo };
    const url = "https://avatars.githubusercontent.com/u/42?v=4";
    const by = (username: string, avatar_url: unknown) => parsePushEvent({ ...base, head_commit: { id: SHA, author: { username } }, sender: { login: "Sam", avatar_url } })?.authorAvatarUrl;
    expect(by("sam", url)).toBe(url);
    expect(by("lena", url)).toBeNull();
    expect(by("sam", "https://evil.example/u/42")).toBeNull();
    expect(by("sam", "http://avatars.githubusercontent.com/u/42")).toBeNull();
    expect(by("sam", "https://avatars.githubusercontent.com.evil.example/u/42")).toBeNull();
    expect(by("sam", 42)).toBeNull();
  });
  it("ignores tags and junk", () => {
    expect(parsePushEvent({ ref: "refs/tags/v1", repository: repo })).toBeNull();
    expect(parsePushEvent(null)).toBeNull();
    expect(parsePushEvent({ ref: "refs/heads/main" })).toBeNull();
  });
  it("matches by repo id when known, else identity, and by branch with the env fallback", () => {
    const apps = [
      { id: "a", gitRepository: "https://github.com/acme/shop", gitBranch: "main" },
      { id: "b", gitRepository: "https://github.com/acme/shop", gitBranch: "dev" },
      { id: "c", gitRepository: "https://github.com/acme/renamed", gitBranch: null, repoId: "99", envBranch: "main" },
      { id: "d", gitRepository: "https://github.com/acme/shop", gitBranch: null, repoId: "100" },
      { id: "e", gitRepository: null, gitBranch: "main" },
      { id: "f", gitRepository: "https://github.com/evil/shop", gitBranch: "main" },
    ];
    expect(matchPushTargets(push!, apps).map((a) => a.id)).toEqual(["a", "c"]);
  });
});

describe("pull_request", () => {
  const base = (action: string, headRepo = repo, merged = false) => ({
    action, number: 42, repository: repo,
    pull_request: { title: "Add cart", merged, user: { login: "octo" }, head: { ref: "feat/cart", sha: SHA, repo: headRepo }, base: { repo } },
  });
  it("maps actions to steps", () => {
    expect(parsePullRequestEvent(base("opened"))?.step).toBe("open");
    expect(parsePullRequestEvent(base("reopened"))?.step).toBe("open");
    expect(parsePullRequestEvent(base("synchronize"))?.step).toBe("update");
    expect(parsePullRequestEvent(base("closed", repo, true))).toMatchObject({ step: "close", merged: true });
    expect(parsePullRequestEvent(base("labeled"))).toBeNull();
  });
  it("flags a head from a fork", () => {
    expect(parsePullRequestEvent(base("opened"))?.fromFork).toBe(false);
    expect(parsePullRequestEvent(base("opened", { id: 5, clone_url: "https://github.com/mallory/shop.git", full_name: "mallory/shop" }))?.fromFork).toBe(true);
  });
});

describe("preview hostnames", () => {
  it("builds a single-label hostname under the preview domain", () => {
    expect(previewHostname(42, "web", "Preview.Example.com")).toBe("pr-42-web.preview.example.com");
    expect(previewHostname(1, "x".repeat(80), "d.io").split(".")[0]!.length).toBeLessThanOrEqual(63);
  });
});

describe("installation events", () => {
  const p = (action: string) => ({ action, installation: { id: 7, account: { login: "acme", type: "Organization", avatar_url: "https://a" }, repository_selection: "selected" } });
  it("parses the actions that change rows", () => {
    expect(parseInstallationEvent("installation", p("created"))).toMatchObject({ action: "created", id: "7", accountType: "Organization", repositorySelection: "selected" });
    expect(parseInstallationEvent("installation_repositories", p("added"))?.action).toBe("repositories");
    expect(parseInstallationEvent("installation", p("weird"))).toBeNull();
  });
  it("links to the right settings page", () => {
    expect(manageUrl("Organization", "acme", "7")).toBe("https://github.com/organizations/acme/settings/installations/7");
    expect(manageUrl("User", "me", "8")).toBe("https://github.com/settings/installations/8");
  });
});
