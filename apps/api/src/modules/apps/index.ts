/**
 * The apps module: the Deploy button here, and read, settings, delete, start, stop, restart and the
 * config tab in handlers.ts. A server-target deploy goes through the deployments module's single
 * in-flight guard; a Vercel-target deploy queues the Vercel sync job instead.
 */
import type { EndpointId } from "@dockify/contracts";
import { assertProjectScope } from "../../actor.ts";
import type { Handlers } from "../../app.ts";
import { audit } from "../../audit.ts";
import { HttpError, unauthenticated } from "../../errors.ts";
import { enqueueDeployment } from "../deployments/index.ts";
import { followOnly, requestVercelDeploy } from "../integrations/vercel.ts";
import { appLifecycleHandlers } from "./handlers.ts";

export const APPS_ENDPOINTS = [
  "apps.deploy", "apps.get", "apps.patch", "apps.rename", "apps.delete", "apps.start", "apps.stop", "apps.restart", "apps.config.get", "apps.config.patch",
] as const satisfies readonly EndpointId[];

const STATEFUL = new Set(["postgres", "redis", "s3"]);

export const appsHandlers: Handlers = {
  ...appLifecycleHandlers,
  "apps.deploy": async ({ params, actor, req, ctx }) => {
    if (!actor) throw unauthenticated();
    const app = await ctx.db.app.findUnique({
      where: { id: params.id },
      select: {
        id: true, name: true, kind: true, deployTarget: true, vercelFollowOnly: true, gitBranch: true, image: true, gitRepository: true, serverId: true,
        environment: { select: { projectId: true } },
      },
    });
    if (!app) throw new HttpError(404, "App not found", "NOT_FOUND");
    assertProjectScope(actor, app.environment.projectId);
    const by = {
      actorType: actor.kind === "token" ? ("token" as const) : ("user" as const),
      actorId: actor.kind === "token" ? actor.tokenId : actor.userId,
      actorName: actor.name,
    };
    if (app.deployTarget === "vercel") {
      if (app.vercelFollowOnly) throw followOnly();
      const deploymentId = await requestVercelDeploy(ctx.db, app.id, { trigger: actor.kind === "token" ? "api" : "manual", ...by });
      await audit(ctx.db, { category: "deploys", action: "app.deploy", verb: "deployed", ...by, targetType: "app", targetId: app.id, targetLabel: app.name, ip: req.clientIp, userAgent: req.headers["user-agent"] ?? null });
      return { deploymentId };
    }
    if (!STATEFUL.has(app.kind) && !app.image && !app.gitRepository) {
      throw new HttpError(400, "This app has no source to deploy yet", "NO_SOURCE");
    }
    const id = await enqueueDeployment(ctx.db, app.id, {
      trigger: actor.kind === "token" ? "api" : "manual",
      branch: app.gitBranch,
      ...by,
    });
    await audit(ctx.db, { category: "deploys", action: "app.deploy", verb: "deployed", ...by, targetType: "app", targetId: app.id, targetLabel: app.name, ip: req.clientIp, userAgent: req.headers["user-agent"] ?? null });
    return { deploymentId: id };
  },
};
