/**
 * One-click templates. Both routes read only the catalog in this folder, which ships with the
 * release: no remote catalog, so nothing fetched at run time can add a container to this server.
 *
 * Deploying one is an ordinary New app: the apps go through createApps, every plain image is pulled
 * by its tag and every managed service records its digest on first pull. Services deploy first, the
 * routed app last: the deploy lane runs one job at a time, in order, so a database is up before the
 * app that reads it starts.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { testDomainName, type templates as T } from "@dockify/contracts";
import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import { actorFields, assertProjectScope, requireActor } from "../../actor.ts";
import type { Ctx, Handlers } from "../../app.ts";
import { audit } from "../../audit.ts";
import { HttpError, isUniqueViolation } from "../../errors.ts";
import { enqueueDeployment } from "../deployments/index.ts";
import { assertTestDomainRoom, domainHandlers, insertTestDomain, usableHostname } from "../domains/handlers.ts";
import { createApps } from "../projects/handlers.ts";
import { CATALOG } from "./catalog/index.ts";
import { describeTemplate, resolveTemplate, TemplateError, type Template } from "./format.ts";

/** The list, built once: it is the same for every viewer and never changes while the api runs. */
const LIST: Array<z.infer<typeof T.TemplateRow>> = CATALOG.map(describeTemplate).sort((a, b) => a.name.localeCompare(b.name));

const refused = (e: TemplateError) => new HttpError(400, e.refusals[0]?.reason ?? "Refused", "REFUSED", { field: e.refusals[0]?.field, refusals: e.refusals });

/** A plain image app's network name, the same one the worker gives it (deploy/containers.ts). */
const networkName = (id: string) => `dk-${id}`;

/** The name it will answer on, chosen before the apps so their variables can hold it. */
async function plannedHostname(ctx: Ctx, base: string, domain: z.infer<typeof T.TemplateDomain>): Promise<string | null> {
  if (domain.type === "none") return null;
  if (domain.type === "custom") return usableHostname(ctx, domain.hostname);
  await assertTestDomainRoom(ctx);
  return testDomainName(base, randomBytes(3).toString("hex"), ctx.config.serverIpv4!);
}

export const templateHandlers: Handlers = {
  "templates.list": async () => LIST,

  "projects.apps.template": async ({ params, body, actor, ctx, req }) => {
    const a = requireActor(actor);
    const p = await ctx.db.project.findUnique({ where: { slug: params.slug }, select: { id: true, slug: true, archivedAt: true } });
    if (!p || p.archivedAt) throw new HttpError(404, "Project not found", "NOT_FOUND");
    assertProjectScope(a, p.id);
    const t: Template | undefined = CATALOG.find((x) => x.id === body.templateId);
    if (!t) throw new HttpError(404, "That template does not exist", "NOT_FOUND", { field: "templateId" });

    const hostname = await plannedHostname(ctx, body.name, body.domain);
    const row = LIST.find((x) => x.id === t.id)!;
    const ids = Object.fromEntries(row.apps.map((x) => [x.service, randomUUID()]));
    let resolved;
    try {
      resolved = resolveTemplate(t, { base: body.name, hostname, inputs: body.inputs, ids, hostOf: networkName });
    } catch (e) {
      if (e instanceof TemplateError) throw refused(e);
      throw e;
    }

    await createApps(ctx, a, p, body.environment, resolved.map((r) => ({ id: r.id, spec: r.spec, name: r.name, kind: r.spec.kind, plain: r.plain, refs: r.refs, memoryMb: r.memoryMb, pinImage: r.spec.source.type === "image" })), req as FastifyRequest);
    const primary = resolved.find((r) => r.service === t.primary)!;
    await audit(ctx.db, {
      category: "config", action: "template.deploy", verb: "deployed the template", ...actorFields(a), targetType: "app", targetId: primary.id,
      targetLabel: `${p.slug}/${body.environment}/${primary.name}`, suffix: `${t.name}, ${resolved.length} app${resolved.length === 1 ? "" : "s"}`,
      // Names only: no value, generated or typed, reaches the log.
      changes: { template: t.id, apps: resolved.map((r) => r.name), images: row.apps.map((x) => x.image || x.managed), inputs: Object.keys(body.inputs) },
      ip: req.clientIp, userAgent: req.headers["user-agent"] ?? null,
    });

    // The domain before the deploys, so the first deploy routes it. The apps exist from here on, so a
    // failure is reported rather than thrown: a thrown error would read as if nothing had been made.
    let warning: string | null = null;
    try {
      if (hostname && body.domain.type === "custom") {
        await domainHandlers["domains.create"]!({ body: { appId: primary.id, hostname }, actor, req, ctx } as never);
      } else if (hostname) {
        await insertTestDomain(ctx, a, req, { id: primary.id, name: primary.name }, hostname);
      }
    } catch (e) {
      const why = e instanceof HttpError ? e.message : isUniqueViolation(e) ? "That hostname was just taken" : "It could not be added";
      warning = `The apps were created, but ${hostname} was not added: ${why}. Add a domain on its Domains tab, then update its variables.`;
    }

    // Managed services first: the lane runs in order, so the database is up before its app starts.
    const by = { actorType: "user" as const, actorId: a.kind === "token" ? a.tokenId : a.userId, actorName: a.name };
    const order = [...resolved].sort((x, y) => rank(x, t) - rank(y, t));
    for (const r of order) {
      await enqueueDeployment(ctx.db, r.id, { trigger: "manual", ...by }).catch((e: unknown) => {
        warning ??= `${r.name} was created but its deploy did not start: ${e instanceof Error ? e.message : "unknown error"}. Press Deploy on it.`;
      });
    }
    return { ids: resolved.map((r) => r.id), primaryId: primary.id, url: hostname ? `https://${hostname}` : null, warning };
  },
};

const rank = (r: { spec: { source: { type: string } }; service: string }, t: Template): number => (r.spec.source.type === "service" ? 0 : r.service === t.primary ? 2 : 1);
