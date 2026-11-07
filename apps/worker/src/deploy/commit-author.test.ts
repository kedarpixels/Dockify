import type { Db, SecretVault } from "@dockify/db";
import { describe, expect, it } from "vitest";
import { parseCommitAuthor, recordCommitAuthor } from "./commit-author.ts";

const SHA = "c".repeat(40);
const URL = "https://github.com/acme/shop.git";
const AVATAR = "https://avatars.githubusercontent.com/u/42?v=4";
const row = { id: "d1", gitAuthor: null, gitAuthorAvatarUrl: null, gitAuthorName: null };

function world(answer: () => Promise<Response> | Response) {
  const updates: unknown[] = [];
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const db = {
    deployment: { update: async (q: { data: unknown }) => void updates.push(q.data) },
    integration: { findUnique: async () => null },
  } as unknown as Db;
  const fetchFake = (async (input: string, init?: RequestInit) => {
    calls.push({ url: String(input), auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    return answer();
  }) as unknown as typeof fetch;
  return { deps: { db, vault: {} as SecretVault, apiBase: "https://api.github.test", fetch: fetchFake }, updates, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("parseCommitAuthor", () => {
  it("reads the account and its avatar", () => {
    expect(parseCommitAuthor([{ sha: SHA, author: { login: "Acme-Labs", avatar_url: AVATAR } }], SHA)).toEqual({ login: "acme-labs", avatarUrl: AVATAR, name: null });
  });
  it("keeps an avatar only from GitHub's host", () => {
    for (const bad of ["https://evil.example/a.png", "http://avatars.githubusercontent.com/u/1", "https://x@avatars.githubusercontent.com/u/1", 7]) {
      expect(parseCommitAuthor([{ sha: SHA, author: { login: "lena", avatar_url: bad } }], SHA)).toEqual({ login: "lena", avatarUrl: null, name: null });
    }
  });
  it("uses the git name when no account is behind the commit", () => {
    expect(parseCommitAuthor([{ sha: SHA, author: null, commit: { author: { name: " Jane\u0000 Doe\n" } } }], SHA)).toEqual({ login: null, avatarUrl: null, name: "Jane  Doe" });
    expect(parseCommitAuthor([{ sha: SHA, author: { login: "dependabot[bot]" }, commit: { author: { name: "dependabot[bot]" } } }], SHA)?.name).toBe("dependabot[bot]");
  });
  it("answers null for anything but a clear answer about this commit", () => {
    for (const body of [null, {}, [], [{ sha: "d".repeat(40), author: { login: "lena" } }], [{ sha: SHA, author: null }], [{ sha: SHA, author: null, commit: { author: { name: "  " } } }]]) {
      expect(parseCommitAuthor(body, SHA)).toBeNull();
    }
  });
});

describe("recordCommitAuthor", () => {
  it("stores the author of a commit a member deployed, asking for this sha only", async () => {
    const w = world(() => json([{ sha: SHA, author: { login: "acme-labs", avatar_url: AVATAR } }]));
    await recordCommitAuthor(w.deps, row, URL, SHA, null);
    expect(w.calls[0]?.url).toBe(`https://api.github.test/repos/acme/shop/commits?sha=${SHA}&per_page=1`);
    expect(w.calls[0]?.auth).toBeUndefined();
    expect(w.updates).toEqual([{ gitAuthor: "acme-labs", gitAuthorAvatarUrl: AVATAR, gitAuthorName: null }]);
  });

  it("fills in the avatar of a push whose author is not the pusher", async () => {
    const w = world(() => json([{ sha: SHA, author: { login: "lena", avatar_url: AVATAR } }]));
    await recordCommitAuthor(w.deps, { ...row, gitAuthor: "lena" }, URL, SHA, null);
    expect(w.updates).toEqual([{ gitAuthor: "lena", gitAuthorAvatarUrl: AVATAR, gitAuthorName: null }]);
  });

  it("keeps a pusher's login beside a git name, for the failure mail", async () => {
    const w = world(() => json([{ sha: SHA, author: null, commit: { author: { name: "Jane Doe" } } }]));
    await recordCommitAuthor(w.deps, { ...row, gitAuthor: "pusher" }, URL, SHA, null);
    expect(w.updates).toEqual([{ gitAuthorName: "Jane Doe" }]);
  });

  it("does not ask when the row already has the author", async () => {
    const w = world(() => json([]));
    await recordCommitAuthor(w.deps, { ...row, gitAuthor: "lena", gitAuthorAvatarUrl: AVATAR }, URL, SHA, null);
    await recordCommitAuthor(w.deps, { ...row, gitAuthorName: "Jane Doe" }, URL, SHA, null);
    expect(w.calls).toEqual([]);
  });

  it("asks only GitHub, about a full sha", async () => {
    const w = world(() => json([]));
    await recordCommitAuthor(w.deps, row, "https://gitlab.com/acme/shop.git", SHA, null);
    await recordCommitAuthor(w.deps, row, URL, "abc1234", null);
    expect(w.calls).toEqual([]);
  });

  it("never fails a deploy: a refusal, a bad body, a network error or a broken token all pass quietly", async () => {
    for (const answer of [() => json({ message: "Not Found" }, 404), () => new Response("<html>"), () => Promise.reject(new Error("socket hang up"))]) {
      const w = world(answer);
      await expect(recordCommitAuthor(w.deps, row, URL, SHA, null)).resolves.toBeUndefined();
      expect(w.updates).toEqual([]);
    }
    // No App connected: the token cannot be had, so it asks anonymously, as for a public repository.
    const w = world(() => json([{ sha: SHA, author: { login: "lena" } }]));
    await recordCommitAuthor(w.deps, row, URL, SHA, 99n);
    expect(w.calls[0]?.auth).toBeUndefined();
    expect(w.updates).toHaveLength(1);
  });

  it("stops waiting after its timeout, however long GitHub takes", async () => {
    const w = world(() => new Promise<Response>(() => undefined));
    const started = Date.now();
    await recordCommitAuthor({ ...w.deps, timeoutMs: 20 }, row, URL, SHA, null);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(w.updates).toEqual([]);
  });
});
