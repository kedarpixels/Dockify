/** Row to contract mappers. Pure, so the response shapes are tested without a database. */
import { iso, type RecentDeployment } from "@dockify/contracts";
import type { ActorType, DeploymentStatus as DbDeploymentStatus } from "@dockify/db";
import { actorRef, deploymentSource, NO_PEOPLE, type People } from "../../actor-view.ts";
import { externalOf, type ExternalColumns } from "../deployments/mapping.ts";


/** "cancelling" is internal; the dashboard shows it as cancelled. */
export const deploymentStatus = (s: DbDeploymentStatus): RecentDeployment["status"] => (s === "cancelling" ? "cancelled" : s);

export interface DeploymentRow extends ExternalColumns {
  id: string;
  appId: string;
  status: DbDeploymentStatus;
  commitSha: string | null;
  branch: string | null;
  message: string | null;
  trigger: string;
  createdAt: Date;
  finishedAt: Date | null;
  actorType?: ActorType;
  actorId?: string | null;
  actorName?: string | null;
  gitAuthor?: string | null;
  gitAuthorAvatarUrl?: string | null;
  gitAuthorName?: string | null;
  imageRef?: string | null;
}

export function recentDeployment(
  d: DeploymentRow,
  app: { id: string; name: string; kind: RecentDeployment["app"]["kind"]; repo: string | null; image?: string | null },
  projectSlug: string,
  environment: string,
  people: People = NO_PEOPLE,
): RecentDeployment {
  return {
    id: d.id,
    appId: d.appId,
    status: deploymentStatus(d.status),
    commit: d.commitSha,
    message: d.message,
    trigger: d.trigger,
    createdAt: iso(d.createdAt),
    finishedAt: d.finishedAt ? iso(d.finishedAt) : null,
    app: { id: app.id, name: app.name, ...(app.kind ? { kind: app.kind } : {}) },
    projectSlug,
    environment,
    repo: app.repo,
    ...externalOf(d),
    ...(d.actorType ? { actor: actorRef({ actorType: d.actorType, actorId: d.actorId ?? null, actorName: d.actorName ?? null, gitAuthor: d.gitAuthor ?? null, gitAuthorAvatarUrl: d.gitAuthorAvatarUrl ?? null }, people) } : {}),
    ...deploymentSource({ actorType: d.actorType ?? "system", actorId: d.actorId ?? null, actorName: d.actorName ?? null, gitAuthor: d.gitAuthor ?? null, gitAuthorAvatarUrl: d.gitAuthorAvatarUrl ?? null, gitAuthorName: d.gitAuthorName ?? null, branch: d.branch, commitSha: d.commitSha, imageRef: d.imageRef ?? null }, app, people),
  };
}

/** "owner/repo" for a repository URL, or the URL itself when it does not parse. */
export function repoLabel(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "") || u.hostname;
  } catch {
    return url;
  }
}

/** Lowercase letters, digits and dashes, at most 40 characters, matching the Slug contract. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/** The slug to try for attempt n (0 is the plain slug), still within 40 characters. */
export function slugCandidate(base: string, n: number): string {
  if (n === 0) return base;
  const suffix = `-${n + 1}`;
  return `${base.slice(0, 40 - suffix.length).replace(/-+$/, "")}${suffix}`;
}
