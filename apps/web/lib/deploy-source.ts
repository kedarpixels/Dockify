import type { ActorRef, AppKind, GitAuthor } from "./types";

// Pure, so the tests read it without a browser.

export interface DeployFacts {
  status?: string;
  commit: string | null;
  message: string | null;
  app: { kind?: AppKind };
  actor?: ActorRef | null;
  author?: GitAuthor | null;
  image?: string | null;
  external?: { creator?: string | null } | null;
}

const SERVICE_NAME: Partial<Record<AppKind, string>> = { postgres: "Postgres", redis: "Redis", s3: "Storage" };

/** "ghcr.io/a/b:1.2" and "postgres:17-alpine" from any form of a reference. Docker Hub's own prefix goes. */
export function shortImage(ref: string): string {
  const [bare = "", digest] = ref.trim().split("@");
  const name = bare.replace(/^(?:docker\.io|index\.docker\.io)\//, "").replace(/^library\//, "");
  const tagged = name.lastIndexOf(":") > name.lastIndexOf("/");
  return tagged || !digest ? name : `${name}@${digest.replace(/^sha256:/, "").slice(0, 7)}`;
}

/** "Postgres 17", "Redis 8.2": the version from the tag when it starts with one, else the service alone. */
function serviceLabel(name: string, image: string | null | undefined): string {
  const bare = shortImage(image ?? "");
  const colon = bare.lastIndexOf(":");
  const version = colon > bare.lastIndexOf("/") ? /^\d+(?:\.\d+)*/.exec(bare.slice(colon + 1))?.[0] : undefined;
  return version ? `${name} ${version}` : name;
}

/** What a deployment with no commit ran: "Postgres 17", "traefik/whoami:v1". Null for a Git deployment. */
export function deploySource(d: DeployFacts): string | null {
  if (d.commit) return null;
  const service = d.app.kind ? SERVICE_NAME[d.app.kind] : undefined;
  if (service) return serviceLabel(service, d.image);
  return d.image ? shortImage(d.image) : null;
}

/** The message column's text: what ran, else the commit's message, which a build finds when it clones. */
export const deployMessage = (d: DeployFacts): string =>
  deploySource(d) ?? d.message ?? (d.status && ["queued", "building", "deploying"].includes(d.status) ? "Waiting for the commit" : "No commit message");

/** "By Sam", "By lenahart on GitHub", "By API token ci", or "By Dockify" for nobody. */
export function actorTip(a: ActorRef | null | undefined): string {
  if (!a || a.kind === "system") return "By Dockify";
  if (a.kind === "github") return `By ${a.login ?? a.name} on GitHub`;
  if (a.kind === "token") return `By API token ${a.name}`;
  return `By ${a.name}`;
}

/** The commit's author as a person to draw: their GitHub face, or the default person for a git name or a Vercel account. */
function authorPerson(d: DeployFacts): ActorRef | null {
  if (d.author) return d.author.login ? { name: d.author.login, login: d.author.login, avatarUrl: d.author.avatarUrl, kind: "github" } : { name: d.author.name, avatarUrl: null, kind: "user" };
  return null;
}

/** The account that started a deployment on Vercel, when Dockify knows no commit author and no member or token started it. */
const vercelCreator = (d: DeployFacts): string | null => (d.author || d.actor?.kind === "user" || d.actor?.kind === "token" ? null : (d.external?.creator ?? null));

/** Someone other than the author started it: a member, a token, or the pusher of a commit with no account. */
function startedBySomeoneElse(d: DeployFacts): ActorRef | null {
  if (!d.author || d.author.isActor) return null;
  return d.actor && d.actor.kind !== "system" ? d.actor : null;
}

/** The face on a row: the commit's author wherever a commit has one, else whoever started it. Undefined from an API that sends neither. */
export function deployFace(d: DeployFacts): ActorRef | null | undefined {
  if (deploySource(d)) return d.actor;
  const creator = vercelCreator(d);
  if (creator) return { name: creator, avatarUrl: null, kind: "user" };
  return authorPerson(d) ?? d.actor;
}

/** The face's tip, one line: "By acme-labs on GitHub, deployed by Sam". */
export function deployTip(d: DeployFacts): string {
  if (deploySource(d)) return actorTip(d.actor);
  const creator = vercelCreator(d);
  if (creator) return `By ${creator} on Vercel`;
  const author = authorPerson(d);
  if (!author) return actorTip(d.actor);
  const other = startedBySomeoneElse(d);
  return other ? `${actorTip(author)}, deployed by ${actorTip(other).replace(/^By /, "")}` : actorTip(author);
}

export interface DeployPerson {
  label: "Commit by" | "Deployed by";
  person: ActorRef | null;
  /** The name as printed: "acme-labs", "Sam", "API token ci", "Dockify". */
  text: string;
}

/** `deployedBy` is set only when someone other than the author started it; the Trigger cell gives way to it. */
export function deployPeople(d: DeployFacts): { main: DeployPerson; deployedBy: DeployPerson | null } {
  const started = (person: ActorRef | null | undefined): DeployPerson => ({ label: "Deployed by", person: person ?? null, text: actorTip(person).replace(/^By /, "") });
  if (deploySource(d)) return { main: started(d.actor), deployedBy: null };
  const creator = vercelCreator(d);
  if (creator) return { main: { label: "Deployed by", person: { name: creator, avatarUrl: null, kind: "user" }, text: `${creator} on Vercel` }, deployedBy: null };
  const author = authorPerson(d);
  if (!author) return { main: started(d.actor), deployedBy: null };
  const other = startedBySomeoneElse(d);
  return { main: { label: "Commit by", person: author, text: author.login ?? author.name }, deployedBy: other ? started(other) : null };
}
