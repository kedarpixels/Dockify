// Who and what a deployment row shows: never "By Sam" for a commit by someone else, and never
// "No commit message", "No bra..." or "No commit" on services with no commit. Run: npm test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { actorTip, deployFace, deployMessage, deployPeople, deploySource, deployTip, shortImage } from "../lib/deploy-source.ts";

const SAM = { name: "Sam", avatarUrl: null, kind: "user" };
const AVATAR = "https://avatars.githubusercontent.com/u/42?v=4";
const git = (over = {}) => ({ commit: "a".repeat(40), message: "Fix it", app: { kind: "backend" }, actor: SAM, ...over });
const acmeLabs = { name: "acme-labs", login: "acme-labs", avatarUrl: AVATAR, isActor: false };

test("a commit's GitHub author is the face and the tip, however it started", () => {
  const d = git({ author: { ...acmeLabs, isActor: true } });
  assert.deepEqual(deployFace(d), { name: "acme-labs", login: "acme-labs", avatarUrl: AVATAR, kind: "github" });
  assert.equal(deployTip(d), "By acme-labs on GitHub");
});

test("a member who started someone else's commit stays in the tip, on one line", () => {
  assert.equal(deployTip(git({ author: acmeLabs })), "By acme-labs on GitHub, deployed by Sam");
  assert.equal(deployTip(git({ author: acmeLabs, actor: { name: "ci", avatarUrl: null, kind: "token" } })), "By acme-labs on GitHub, deployed by API token ci");
  // Dockify queueing a coalesced push is not a person to name.
  assert.equal(deployTip(git({ author: acmeLabs, actor: { name: "Dockify", avatarUrl: null, kind: "system" } })), "By acme-labs on GitHub");
});

test("an author with no GitHub account reads their git name with the default person", () => {
  const d = git({ author: { name: "Jane Doe", login: null, avatarUrl: null, isActor: false } });
  assert.deepEqual(deployFace(d), { name: "Jane Doe", avatarUrl: null, kind: "user" });
  assert.equal(deployTip(d), "By Jane Doe, deployed by Sam");
});

test("an old row with no author keeps showing who started it", () => {
  const d = git({ author: null });
  assert.equal(deployFace(d), SAM);
  assert.equal(deployTip(d), "By Sam");
  assert.deepEqual(deployPeople(d), { main: { label: "Deployed by", person: SAM, text: "Sam" }, deployedBy: null });
  assert.equal(deployFace({ commit: "a", message: null, app: {} }), undefined);
});

test("Details names author and trigger apart only when they differ", () => {
  const both = deployPeople(git({ author: acmeLabs }));
  assert.equal(both.main.label, "Commit by");
  assert.equal(both.main.text, "acme-labs");
  assert.equal(both.deployedBy?.label, "Deployed by");
  assert.equal(both.deployedBy?.text, "Sam");
  assert.equal(deployPeople(git({ author: { ...acmeLabs, isActor: true } })).deployedBy, null);
});

test("a Vercel row reads its creator the same way, unless a commit author is known", () => {
  const d = git({ actor: null, external: { creator: "lenahart" } });
  assert.equal(deployTip(d), "By lenahart on Vercel");
  assert.deepEqual(deployFace(d), { name: "lenahart", avatarUrl: null, kind: "user" });
  assert.equal(deployPeople(d).main.text, "lenahart on Vercel");
  assert.equal(deployTip({ ...d, author: { ...acmeLabs, isActor: true } }), "By acme-labs on GitHub");
  // A deploy a member started from Dockify stays theirs.
  assert.equal(deployTip(git({ external: { creator: "lenahart" } })), "By Sam");
});

test("a managed service reads its name and version, never a missing commit", () => {
  const svc = (kind, image) => ({ commit: null, message: "Rollback to 1234abcd", app: { kind }, actor: SAM, image });
  assert.equal(deploySource(svc("postgres", `postgres:17-alpine@sha256:${"b".repeat(64)}`)), "Postgres 17");
  assert.equal(deploySource(svc("redis", "redis:8.2-alpine")), "Redis 8.2");
  assert.equal(deploySource(svc("redis", "redis:latest")), "Redis");
  assert.equal(deploySource(svc("postgres", null)), "Postgres");
  assert.equal(deployMessage(svc("postgres", "postgres:17-alpine")), "Postgres 17");
  // The member who started it keeps the face.
  assert.equal(deployFace(svc("redis", "redis:8.2-alpine")), SAM);
  assert.equal(deployTip(svc("redis", "redis:8.2-alpine")), "By Sam");
});

test("an image deploy reads the reference, shortened", () => {
  assert.equal(shortImage(`ghcr.io/acme/api:1.2@sha256:${"c".repeat(64)}`), "ghcr.io/acme/api:1.2");
  assert.equal(shortImage(`ghcr.io/acme/api@sha256:${"c".repeat(64)}`), "ghcr.io/acme/api@ccccccc");
  assert.equal(shortImage("docker.io/library/nginx:1.27"), "nginx:1.27");
  assert.equal(shortImage("localhost:5000/api"), "localhost:5000/api");
  assert.equal(deployMessage({ commit: null, message: null, app: { kind: "backend" }, image: "traefik/whoami:v1.10.3" }), "traefik/whoami:v1.10.3");
});

test("a Git deployment keeps its message, and one still to find its commit is not a service", () => {
  assert.equal(deployMessage(git()), "Fix it");
  assert.equal(deployMessage(git({ message: null })), "No commit message");
  assert.equal(deployMessage(git({ commit: null, message: null, status: "queued" })), "Waiting for the commit");
  assert.equal(deploySource({ commit: null, message: null, app: { kind: "backend" }, image: null }), null);
  assert.equal(deploySource(git({ image: "x:1" })), null);
});

test("actorTip keeps its four forms", () => {
  assert.equal(actorTip(null), "By Dockify");
  assert.equal(actorTip({ name: "lena", login: "lena", avatarUrl: null, kind: "github" }), "By lena on GitHub");
  assert.equal(actorTip({ name: "ci", avatarUrl: null, kind: "token" }), "By API token ci");
  assert.equal(actorTip(SAM), "By Sam");
});

test("no surface prints the long placeholders a narrow column cut to No bra...", () => {
  for (const f of ["components/ui/git-ref.tsx", "components/ui/hash-chip.tsx", "components/overview/panels.tsx", "components/project-detail/app-view.tsx", "components/overview/deploy-row.tsx", "components/projects/project-card.tsx", "components/projects/project-list.tsx", "components/deployments/deployment-view.tsx"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    for (const word of ['"No branch"', '"No commit message"', ">No commit<", ">No branch<"]) assert.equal(src.includes(word), false, `${f} ${word}`);
  }
});
