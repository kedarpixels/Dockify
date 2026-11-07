/**
 * `.git` is in the build context, so one commit must give the same bytes in every clone, or a COPY of
 * the context and all after it rebuilds on every deploy. These run the real git, two real clones of one
 * commit, at different times, and hash every file under `.git` as BuildKit would see it: bytes and
 * names, no times.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dropCloneOnlyGitFiles } from "./git.ts";

const haveGit = spawnSync("git", ["--version"]).status === 0;

const root = mkdtempSync(join(tmpdir(), "dk-gitstable-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, args: string[], date = "2026-11-07T00:00:00Z") =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...ENV, GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@example.com", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }).trim();

function tree(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const name = `${prefix}${e.name}`;
    if (e.isDirectory()) Object.assign(out, tree(p, `${name}/`));
    else out[name] = createHash("sha256").update(readFileSync(p)).digest("hex");
  }
  return out;
}

/** What checkout() does, by hand, from a local remote: init, shallow fetch, detach. */
function clone(name: string, ref: string, date: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, ["init", "--quiet", "."]);
  git(dir, ["-c", "protocol.file.allow=always", "fetch", "--quiet", "--depth", "1", "--no-tags", "--", `file://${join(root, "remote").replaceAll("\\", "/")}`, ref], date);
  git(dir, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", "FETCH_HEAD"], date);
  return dir;
}
const stabilize = async (dir: string) => {
  git(dir, ["read-tree", "HEAD"]);
  await dropCloneOnlyGitFiles(dir);
};

describe.skipIf(!haveGit)("the build context's .git", () => {
  const remote = join(root, "remote");
  mkdirSync(remote);
  git(remote, ["init", "--quiet", "-b", "main", "."]);
  writeFileSync(join(remote, "a.txt"), "one\n");
  mkdirSync(join(remote, "sub"));
  writeFileSync(join(remote, "sub", "b.txt"), "two\n");
  git(remote, ["add", "."]);
  git(remote, ["commit", "--quiet", "-m", "first"]);
  const sha = git(remote, ["rev-parse", "HEAD"]);

  it("differs between two clones of one commit without this: the bug being fixed", () => {
    const a = tree(join(clone("raw-a", "refs/heads/main", "2026-11-07T00:00:00Z"), ".git"));
    const b = tree(join(clone("raw-b", "refs/heads/main", "2026-11-08T11:11:11Z"), ".git"));
    expect(a["logs/HEAD"]).not.toBe(b["logs/HEAD"]);
  });

  it("is byte for byte the same in two clones of one commit, at different times", async () => {
    const a = clone("a", "refs/heads/main", "2026-11-07T00:00:00Z");
    const b = clone("b", "refs/heads/main", "2026-11-08T11:11:11Z");
    await stabilize(a);
    await stabilize(b);
    expect(tree(join(a, ".git"))).toEqual(tree(join(b, ".git")));
  });

  it("is the same whether the deploy named the branch or the commit", async () => {
    const pinned = join(remote, ".git", "config");
    writeFileSync(pinned, `${readFileSync(pinned, "utf8")}\n[uploadpack]\n\tallowAnySHA1InWant = true\n`);
    const a = clone("by-branch", "refs/heads/main", "2026-11-07T00:00:00Z");
    const b = clone("by-sha", sha, "2026-11-08T11:11:11Z");
    await stabilize(a);
    await stabilize(b);
    expect(tree(join(a, ".git"))).toEqual(tree(join(b, ".git")));
  });

  it("still answers what a build asks of it", async () => {
    const d = clone("reads", "refs/heads/main", "2026-11-07T00:00:00Z");
    await stabilize(d);
    expect(git(d, ["rev-parse", "HEAD"])).toBe(sha);
    expect(git(d, ["log", "-1", "--format=%H %s"])).toBe(`${sha} first`);
    expect(readFileSync(join(d, ".git", "HEAD"), "utf8").trim()).toBe(sha);
    expect(git(d, ["status", "--porcelain"])).toBe("");
    expect(git(d, ["describe", "--always", "--dirty"])).toBe(sha.slice(0, 7));
    expect(git(d, ["ls-files"]).split("\n").sort()).toEqual(["a.txt", "sub/b.txt"]);
    expect(git(d, ["show", "HEAD:a.txt"])).toBe("one");
  });

  it("still sees a real change as a change", async () => {
    const d = clone("dirty", "refs/heads/main", "2026-11-07T00:00:00Z");
    await stabilize(d);
    writeFileSync(join(d, "a.txt"), "changed\n");
    expect(git(d, ["status", "--porcelain"])).toBe("M a.txt");
    expect(git(d, ["describe", "--always", "--dirty"])).toBe(`${sha.slice(0, 7)}-dirty`);
  });

  it("differs when the commit does", async () => {
    const a = clone("before", "refs/heads/main", "2026-11-07T00:00:00Z");
    writeFileSync(join(remote, "a.txt"), "three\n");
    git(remote, ["commit", "--quiet", "-am", "second"]);
    const b = clone("after", "refs/heads/main", "2026-11-07T00:00:00Z");
    await stabilize(a);
    await stabilize(b);
    expect(tree(join(a, ".git"))["HEAD"]).not.toBe(tree(join(b, ".git"))["HEAD"]);
  });

  it("leaves the checkout's own files alone", async () => {
    const d = clone("files", "refs/heads/main", "2026-11-07T00:00:00Z");
    const before = Object.fromEntries(Object.entries(tree(d)).filter(([k]) => !k.startsWith(".git/")));
    await stabilize(d);
    expect(Object.fromEntries(Object.entries(tree(d)).filter(([k]) => !k.startsWith(".git/")))).toEqual(before);
  });
});
