// An image app's Settings hid its Image, Start
// command and Release command, and New app took a repository URL the API refuses. Run: npm test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isManaged, sourceOf } from "../lib/app-source.ts";
import { isSshRepoUrl, parseRepo } from "../components/git/parse.ts";

test("only a service kind is managed: an image does not make an app one", () => {
  for (const kind of ["postgres", "redis", "s3"]) assert.equal(isManaged({ kind }), true, kind);
  for (const kind of ["frontend", "backend", "bot"]) assert.equal(isManaged({ kind }), false, kind);
});

test("an image app reads as an image app, whatever its project's repository", () => {
  assert.equal(sourceOf({ kind: "backend", image: "traefik/whoami:v1.10.3", repo: null }), "image");
  assert.equal(sourceOf({ kind: "backend", image: "traefik/whoami:v1.10.3", repo: "https://github.com/o/r" }), "image");
  assert.equal(sourceOf({ kind: "backend", image: null, repo: "https://github.com/o/r" }), "git");
  assert.equal(sourceOf({ kind: "postgres", image: "postgres:17-alpine", repo: null }), "managed");
  assert.equal(sourceOf({ kind: "redis", image: null, repo: null }), "managed");
});

test("Settings shows Image, Start command and the release card by this rule, for all but a service", () => {
  const tab = readFileSync(new URL("../components/app-detail/settings-tab.tsx", import.meta.url), "utf8");
  assert.match(tab, /isManaged\(app\) \? null : <ReleaseSection/);
  assert.match(tab, /source === "image" \?/);
  assert.match(tab, /managed \? null : \(\s*<Field label="Start command"/);
});

// The API's RepoUrl, as packages/contracts tests it against this copy's text.
const SPEC = readFileSync(new URL("../components/new-app/spec.ts", import.meta.url), "utf8");
const API_RULE = new RegExp(/REPO_URL = \/(.*)\/i;/.exec(SPEC)[1], "i");

test("New app accepts only what the API takes, and sends it clean", () => {
  for (const [typed, url] of [
    ["https://github.com/owner/repo", "https://github.com/owner/repo"],
    ["https://github.com/owner/repo.git", "https://github.com/owner/repo"],
    ["github.com/owner/repo", "https://github.com/owner/repo"],
    ["http://www.gitlab.com/owner/repo/-/tree/main?x=1", "https://gitlab.com/owner/repo"],
  ]) {
    const p = parseRepo(typed);
    assert.equal(p?.url, url, typed);
    assert.equal(API_RULE.test(p.url), true, typed);
  }
});

test("an ssh address is refused here with its own message, not after every step and a step-up", () => {
  for (const typed of ["git@github.com:owner/repo", "git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo"]) {
    assert.equal(parseRepo(typed), null, typed);
    assert.equal(isSshRepoUrl(typed), true, typed);
    assert.equal(API_RULE.test(typed), false, typed);
  }
  assert.equal(isSshRepoUrl("https://github.com/owner/repo"), false);
});
