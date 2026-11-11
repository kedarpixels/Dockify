import type { ActorKind, ActorRef, GitAuthor } from "@dockify/contracts";
import type { ActorType, Tx } from "@dockify/db";
import type { Actor } from "./actor.ts";

/** Who acted, as a row stored it. `gitAuthor` is the push author's login on webhook rows. */
export interface ActorColumns {
  actorType: ActorType;
  actorId: string | null;
  actorName: string | null;
  gitAuthor?: string | null;
  gitAuthorAvatarUrl?: string | null;
  /** The commit's git name, when its author has no GitHub account. */
  gitAuthorName?: string | null;
}

export interface Person {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/** Pictures of members by user id, and the members behind linked GitHub logins. */
export interface People {
  avatars: ReadonlyMap<string, string | null>;
  logins: ReadonlyMap<string, Person>;
  /** The verified GitHub login of a member, by user id. */
  loginOf: ReadonlyMap<string, string>;
}
export const NO_PEOPLE: People = { avatars: new Map(), logins: new Map(), loginOf: new Map() };

/** Webhooks and schedules both read as Dockify itself acting. */
export const actorKind = (t: ActorType): ActorKind => (t === "user" || t === "token" ? t : "system");

/** Only a verified login names a member: an unverified one is a claim nobody checked, so its pushes stay GitHub's. */
export function peopleOf(members: ReadonlyArray<{ id: string; name: string; avatarUrl: string | null; githubLogin: string | null; githubVerifiedAt: Date | null }>): People {
  return {
    avatars: new Map(members.map((u) => [u.id, u.avatarUrl])),
    logins: new Map(members.flatMap((u) => (u.githubLogin && u.githubVerifiedAt ? [[u.githubLogin, { id: u.id, name: u.name, avatarUrl: u.avatarUrl }] as const] : []))),
    loginOf: new Map(members.flatMap((u) => (u.githubLogin && u.githubVerifiedAt ? [[u.id, u.githubLogin] as const] : []))),
  };
}

/**
 * The members behind `rows`, for signed-in sessions only: a token cannot read the team, so it gets none,
 * and a former member is never resolved.
 */
export async function loadPeople(db: Tx, viewer: Actor | null, rows: Iterable<ActorColumns>): Promise<People> {
  if (viewer?.kind !== "session") return NO_PEOPLE;
  const ids = new Set<string>();
  const logins = new Set<string>();
  for (const r of rows) {
    if (r.actorType === "user" && r.actorId) ids.add(r.actorId);
    if (r.actorType === "webhook" && r.gitAuthor) logins.add(r.gitAuthor);
  }
  if (!ids.size && !logins.size) return NO_PEOPLE;
  const users = await db.user.findMany({
    where: { member: { isNot: null }, OR: [{ id: { in: [...ids] } }, { githubLogin: { in: [...logins] }, githubVerifiedAt: { not: null } }] },
    select: { id: true, name: true, avatarUrl: true, githubLogin: true, githubVerifiedAt: true },
  });
  return peopleOf(users);
}

/** The member a push was by, when its author linked that GitHub login. */
export const pushAuthor = (r: ActorColumns, people: People): Person | null =>
  r.actorType === "webhook" && r.gitAuthor ? (people.logins.get(r.gitAuthor) ?? null) : null;

export function avatarOf(r: ActorColumns, people: People): string | null {
  if (r.actorType === "user" && r.actorId) return people.avatars.get(r.actorId) ?? null;
  return pushAuthor(r, people)?.avatarUrl ?? null;
}

/** A push author's public GitHub picture: the one the push carried, else GitHub's by login. */
export const githubAvatar = (login: string, url?: string | null): string => url ?? `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=64`;

/** Null when nobody is named. A push by anyone but a verified member is named by its GitHub login, never as a member. */
export function actorRef(r: ActorColumns, people: People): ActorRef | null {
  const author = pushAuthor(r, people);
  if (author) return { name: author.name, avatarUrl: author.avatarUrl, kind: "user" };
  if (r.actorType === "webhook") return r.gitAuthor ? { name: r.gitAuthor, login: r.gitAuthor, avatarUrl: githubAvatar(r.gitAuthor, r.gitAuthorAvatarUrl), kind: "github" } : null;
  if (!r.actorName) return null;
  return { name: r.actorName, avatarUrl: avatarOf(r, people), kind: actorKind(r.actorType) };
}

/**
 * Who wrote a deployment's commit, as GitHub knows them, even when a member links that login.
 * A git name wins over a login, since on such a row the login is the pusher's.
 */
export function authorRef(r: ActorColumns, people: People): GitAuthor | null {
  if (r.gitAuthorName) return { name: r.gitAuthorName, login: null, avatarUrl: null, isActor: false };
  if (!r.gitAuthor) return null;
  const isActor = r.actorType === "webhook" || (r.actorType === "user" && !!r.actorId && people.loginOf.get(r.actorId) === r.gitAuthor);
  return { name: r.gitAuthor, login: r.gitAuthor, avatarUrl: githubAvatar(r.gitAuthor, r.gitAuthorAvatarUrl), isActor };
}

/** The kinds Dockify runs itself: a deployment of one never has a commit. */
const SERVICE_KINDS: ReadonlySet<string> = new Set(["postgres", "redis", "s3"]);

const repositoryOf = (ref: string): string => {
  const bare = ref.split("@")[0] ?? "";
  const colon = bare.lastIndexOf(":");
  return colon > bare.lastIndexOf("/") ? bare.slice(0, colon) : bare;
};

/**
 * What a deployment with no commit ran. A pull records repo@sha256:..., which has lost its tag,
 * so the app's own reference stands in while it names the same repository.
 */
export function deployedImage(d: { commitSha: string | null; imageRef?: string | null }, app: { kind?: string | null; image?: string | null }): string | null {
  if (d.commitSha || (!SERVICE_KINDS.has(app.kind ?? "") && !app.image)) return null;
  const ref = d.imageRef ?? null;
  const configured = app.image ?? null;
  if (!ref) return configured;
  const lostTag = ref.includes("@") && !/:[^/@]+@/.test(ref);
  return lostTag && configured && repositoryOf(configured) === repositoryOf(ref) ? configured : ref;
}

/** A row that ran an image shows no branch. */
export function deploymentSource(d: ActorColumns & { branch: string | null; commitSha: string | null; imageRef?: string | null }, app: { kind?: string | null; image?: string | null }, people: People) {
  const image = deployedImage(d, app);
  return { branch: image ? null : d.branch, author: authorRef(d, people), image };
}
