import type { Db } from "@dockify/db";
import type { Actor } from "../../actor.ts";
import { assertProjectScope, tokenProjectLimit } from "../../actor.ts";
import { HttpError } from "../../errors.ts";

/** Project ids a caller may see, or null for every project (sessions, unlimited tokens). */
export const projectLimit = (actor: Actor | null): string[] | null => tokenProjectLimit(actor);

export const notFound = (): HttpError => new HttpError(404, "Not found", "NOT_FOUND");

/** Loads an app for an app-scoped route, 404 when missing, 403 when a token is limited elsewhere. */
export async function loadApp(db: Db, actor: Actor | null, id: string) {
  const app = await db.app.findUnique({
    where: { id },
    select: {
      id: true, name: true, kind: true, cpuLimit: true, memoryLimitMb: true, pidsLimit: true,
      environment: { select: { name: true, projectId: true, project: { select: { slug: true } } } },
    },
  });
  if (!app) throw notFound();
  if (actor) assertProjectScope(actor, app.environment.projectId);
  return app;
}
