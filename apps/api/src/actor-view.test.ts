import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import type { Actor } from "./actor.ts";
import { actorKind, actorRef, authorRef, deployedImage, deploymentSource, loadPeople, NO_PEOPLE, peopleOf } from "./actor-view.ts";

const OWNER = "0f0e0d0c-0000-4000-8000-0000000000a1";
const FORMER = "0f0e0d0c-0000-4000-8000-0000000000a2";
const SQUATTER = "0f0e0d0c-0000-4000-8000-0000000000a3";
const users = [
  { id: OWNER, name: "Sam", avatarUrl: "data:image/png;base64,AAAA", githubLogin: "sam", githubVerifiedAt: new Date(), member: true },
  { id: FORMER, name: "Lena", avatarUrl: "data:image/png;base64,BBBB", githubLogin: "lena", githubVerifiedAt: new Date(), member: false },
  { id: SQUATTER, name: "Tomas", avatarUrl: null, githubLogin: "boss", githubVerifiedAt: null, member: true },
];

type Where = { member: { isNot: null }; OR: [{ id: { in: string[] } }, { githubLogin: { in: string[] }; githubVerifiedAt?: { not: null } }] };

function fakeDb() {
  const calls: Where[] = [];
  const db = {
    user: {
      findMany: async (q: { where: Where }) => {
        calls.push(q.where);
        const [ids, byLogin] = [q.where.OR[0].id.in, q.where.OR[1]];
        const loginMatch = (u: (typeof users)[number]) => byLogin.githubLogin.in.includes(u.githubLogin) && (!byLogin.githubVerifiedAt || !!u.githubVerifiedAt);
        return users.filter((u) => u.member && (ids.includes(u.id) || loginMatch(u))).map(({ member: _m, ...u }) => u);
      },
    },
  };
  return { db: db as unknown as Db, calls };
}

const session: Actor = { kind: "session", userId: OWNER, name: "Sam", role: "admin", sessionId: "s", elevated: false };
const token: Actor = { kind: "token", userId: OWNER, name: "ci", role: "admin", tokenId: "t", scope: "read", allProjects: true, projectIds: [], grants: [], elevated: false };

const byOwner = { actorType: "user" as const, actorId: OWNER, actorName: "Sam" };
const byFormer = { actorType: "user" as const, actorId: FORMER, actorName: "Lena" };
const byToken = { actorType: "token" as const, actorId: "t", actorName: "ci" };
const byGitHub = { actorType: "webhook" as const, actorId: null, actorName: "GitHub" };
const gh = (login: string) => ({ name: login, login, avatarUrl: `https://avatars.githubusercontent.com/${login}?s=64`, kind: "github" });

describe("actor view", () => {
  it("gives a signed-in session the pictures of current members only", async () => {
    const { db } = fakeDb();
    const people = await loadPeople(db, session, [byOwner, byFormer, byToken, byGitHub]);
    expect(actorRef(byOwner, people)).toEqual({ name: "Sam", avatarUrl: "data:image/png;base64,AAAA", kind: "user" });
    expect(actorRef(byFormer, people)).toEqual({ name: "Lena", avatarUrl: null, kind: "user" });
  });
  it("never looks anyone up for a token caller", async () => {
    const { db, calls } = fakeDb();
    const people = await loadPeople(db, token, [byOwner, { ...byGitHub, gitAuthor: "sam" }]);
    expect(calls).toHaveLength(0);
    expect(actorRef(byOwner, people)?.avatarUrl).toBeNull();
    expect(actorRef({ ...byGitHub, gitAuthor: "sam" }, people)).toEqual(gh("sam"));
  });
  it("names tokens and Dockify itself by kind, with no picture", async () => {
    const { db } = fakeDb();
    const people = await loadPeople(db, session, [byToken, byGitHub]);
    expect(actorRef(byToken, people)).toEqual({ name: "ci", avatarUrl: null, kind: "token" });
    // A push that carried no login is Dockify acting.
    expect(actorRef(byGitHub, people)).toBeNull();
    expect(actorKind("system")).toBe("system");
    expect(actorRef({ actorType: "system", actorId: null, actorName: null }, people)).toBeNull();
  });
  it("shows a push as the current member who linked its author's login", async () => {
    const { db, calls } = fakeDb();
    const mine = { ...byGitHub, gitAuthor: "sam" };
    const theirs = { ...byGitHub, gitAuthor: "lena" };
    const stranger = { ...byGitHub, gitAuthor: "octocat" };
    const people = await loadPeople(db, session, [mine, theirs, stranger]);
    expect(calls[0]!.OR[1].githubLogin.in.sort()).toEqual(["lena", "octocat", "sam"]);
    expect(actorRef(mine, people)).toEqual({ name: "Sam", avatarUrl: "data:image/png;base64,AAAA", kind: "user" });
    // A former member's login no longer resolves, and an unlinked one is shown as its GitHub login.
    expect(actorRef(theirs, people)).toEqual(gh("lena"));
    expect(actorRef(stranger, people)).toEqual(gh("octocat"));
    // An unverified claim never names a member, even if one is returned: attribution is display only.
    expect(actorRef({ ...byGitHub, gitAuthor: "boss" }, await loadPeople(db, session, [{ ...byGitHub, gitAuthor: "boss" }]))).toEqual(gh("boss"));
    expect(actorRef({ ...byGitHub, gitAuthor: "boss" }, peopleOf([{ ...users[2]!, githubVerifiedAt: null }]))?.kind).toBe("github");
    // A login on a row that is not a webhook never renames it.
    expect(actorRef({ ...byToken, gitAuthor: "sam" }, people)?.name).toBe("ci");
  });
  it("keeps the avatar a push carried for an author who is not a member", () => {
    const url = "https://avatars.githubusercontent.com/u/583231?v=4";
    expect(actorRef({ ...byGitHub, gitAuthor: "stranger", gitAuthorAvatarUrl: url }, NO_PEOPLE)).toEqual({ ...gh("stranger"), avatarUrl: url });
  });
});

describe("the commit's author", () => {
  const people = peopleOf(users.map(({ member: _m, ...u }) => u));

  it("names the GitHub person even when a member linked that login", () => {
    const push = { ...byGitHub, gitAuthor: "sam", gitAuthorAvatarUrl: "https://avatars.githubusercontent.com/u/9?v=4" };
    expect(authorRef(push, people)).toEqual({ name: "sam", login: "sam", avatarUrl: push.gitAuthorAvatarUrl, isActor: true });
    // The actor stays the member, for whoever reads who started it.
    expect(actorRef(push, people)?.name).toBe("Sam");
  });

  it("tells a member's click on someone else's commit from one on their own", () => {
    expect(authorRef({ ...byOwner, gitAuthor: "acme-labs" }, people)).toEqual({ name: "acme-labs", login: "acme-labs", avatarUrl: gh("acme-labs").avatarUrl, isActor: false });
    expect(authorRef({ ...byOwner, gitAuthor: "sam" }, people)?.isActor).toBe(true);
    // Without the team to read, a token caller cannot say they are the same person.
    expect(authorRef({ ...byOwner, gitAuthor: "sam" }, NO_PEOPLE)?.isActor).toBe(false);
    expect(authorRef({ ...byToken, gitAuthor: "sam" }, people)?.isActor).toBe(false);
  });

  it("uses the git name with no picture when the author has no account, over a pusher's login", () => {
    expect(authorRef({ ...byOwner, gitAuthorName: "Jane Doe" }, people)).toEqual({ name: "Jane Doe", login: null, avatarUrl: null, isActor: false });
    expect(authorRef({ ...byGitHub, gitAuthor: "sam", gitAuthorAvatarUrl: "https://avatars.githubusercontent.com/u/9", gitAuthorName: "Jane Doe" }, people)?.login).toBeNull();
  });

  it("is null on an old row with no author, which keeps its actor", () => {
    expect(authorRef(byOwner, people)).toBeNull();
    expect(actorRef(byOwner, people)?.name).toBe("Sam");
  });
});

describe("what a deployment with no commit ran", () => {
  const SHA = "a".repeat(40);
  const DIGEST = `sha256:${"b".repeat(64)}`;

  it("reads a service's pin, keeping the tag it carries, else the app's reference", () => {
    expect(deployedImage({ commitSha: null, imageRef: `postgres:17-alpine@${DIGEST}` }, { kind: "postgres", image: "postgres:18-alpine" })).toBe(`postgres:17-alpine@${DIGEST}`);
    expect(deployedImage({ commitSha: null }, { kind: "redis", image: "redis:8.2-alpine" })).toBe("redis:8.2-alpine");
    expect(deployedImage({ commitSha: null }, { kind: "redis", image: null })).toBeNull();
  });

  it("gives a pulled image its tag back while it is the same repository", () => {
    expect(deployedImage({ commitSha: null, imageRef: `ghcr.io/a/b@${DIGEST}` }, { kind: "backend", image: "ghcr.io/a/b:1.2" })).toBe("ghcr.io/a/b:1.2");
    expect(deployedImage({ commitSha: null, imageRef: `ghcr.io/a/b@${DIGEST}` }, { kind: "backend", image: "ghcr.io/a/c:9" })).toBe(`ghcr.io/a/b@${DIGEST}`);
  });

  it("is null from Git: a commit, or an app with no image", () => {
    expect(deployedImage({ commitSha: SHA, imageRef: "dockify/app:1" }, { kind: "backend", image: "x:1" })).toBeNull();
    expect(deployedImage({ commitSha: null, imageRef: "dockify/app:1" }, { kind: "backend", image: null })).toBeNull();
  });

  it("drops the branch of a row with no commit, and only that row's", () => {
    const row = { ...byOwner, branch: "main", commitSha: null };
    expect(deploymentSource(row, { kind: "backend", image: "traefik/whoami:v1" }, NO_PEOPLE)).toEqual({ branch: null, author: null, image: "traefik/whoami:v1" });
    expect(deploymentSource(row, { kind: "backend", image: null }, NO_PEOPLE).branch).toBe("main");
  });
});
