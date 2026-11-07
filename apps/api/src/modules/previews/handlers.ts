/**
 * Preview endpoints: the list with its settings, one preview's detail, the settings (every
 * guardrail), wake, delete and the DNS check. Teardown and wake are worker jobs; these handlers
 * write rows and queue them in the same transaction.
 */
import { iso, projects as P } from "@dockify/contracts";
import { defaultServerId, enqueuePreviewTx, enqueueTx, type Db, type Tx } from "@dockify/db";
import type { FastifyRequest } from "fastify";
import type { Handlers } from "../../app.ts";
import { assertProjectScope, type Actor } from "../../actor.ts";
import { audit } from "../../audit.ts";
import { HttpError, unauthenticated } from "../../errors.ts";
import { deploymentStatus, recentDeployment } from "../projects/views.ts";
import { previewNeedsOwnDb, DISK_GUARD_PCT, expiresAt, includedInPreviews, isLive, pickBaseEnvironment, PREVIEW_KINDS, previewName } from "./logic.ts";
import { hashPreviewPassword, newPreviewPassword } from "./gate.ts";
import { instancePreview, latestDiskPct, retirePreview, SERVER_LOCK } from "./webhook.ts";

type PreviewRow = ReturnType<typeof P.PreviewRow.parse>;

const notFound = (what: string) => new HttpError(404, `${what} not found`, "NOT_FOUND");

function actorOf(actor: Actor | null): Actor {
  if (!actor) throw unauthenticated();
  return actor;
}

const who = (actor: Actor, req: FastifyRequest) => ({
  actorType: actor.kind === "token" ? ("token" as const) : ("user" as const),
  actorId: actor.kind === "token" ? actor.tokenId : actor.userId,
  actorName: actor.name,
  ip: req.clientIp,
  userAgent: req.headers["user-agent"] ?? null,
});

const PROJECT = {
  id: true, slug: true, archivedAt: true, previewEnabled: true, previewBaseEnv: true, previewMaxConcurrent: true, previewDomain: true,
  previewCpuLimit: true, previewMemoryMb: true, previewPidsLimit: true, previewIdleMinutes: true, previewTtlHours: true,
  previewFromForks: true, previewIsolatedDb: true, previewProductionAccess: true, previewAccess: true, previewPasswordSetAt: true,
  environments: { select: { id: true, name: true, apps: { select: { id: true, name: true, kind: true, previewEnabled: true, gitRepository: true, deployTarget: true } } } },
} as const;

async function projectFor(db: Db, actor: Actor | null, slug: string) {
  const p = await db.project.findUnique({ where: { slug }, select: PROJECT });
  if (!p || p.archivedAt) throw notFound("Project");
  if (actor) assertProjectScope(actor, p.id);
  return p;
}
type Project = Awaited<ReturnType<typeof projectFor>>;

/** What a push would copy (webhook.ts), so settings never read differently from what previews do. */
function includedApps(p: Project) {
  return pickBaseEnvironment(p.environments, p.previewBaseEnv)?.apps.filter(includedInPreviews) ?? [];
}

export function settingsOf(p: Project, serverMax: number): P.PreviewSettings {
  return {
    enabled: p.previewEnabled,
    baseEnvironment: pickBaseEnvironment(p.environments, p.previewBaseEnv)?.name ?? p.previewBaseEnv,
    appIds: includedApps(p).map((a) => a.id).sort(),
    domain: p.previewDomain,
    maxConcurrent: p.previewMaxConcurrent,
    serverMaxConcurrent: serverMax,
    cpuLimit: p.previewCpuLimit,
    memoryMb: p.previewMemoryMb,
    pidsLimit: p.previewPidsLimit,
    idleMinutes: p.previewIdleMinutes,
    ttlHours: p.previewTtlHours,
    fromForks: p.previewFromForks,
    isolatedDb: p.previewIsolatedDb,
    productionAccess: p.previewProductionAccess,
    access: p.previewAccess,
  };
}

const ROW_SELECT = {
  id: true, prNumber: true, title: true, author: true, branch: true, commitSha: true, status: true, reason: true, error: true,
  fromFork: true, isolatedDb: true, createdAt: true, updatedAt: true, lastCommitAt: true, lastRequestAt: true, sleptAt: true,
  repo: true,
  baseEnvironment: { select: { name: true } },
  project: { select: { previewProductionAccess: true, environments: { select: { id: true } } } },
  apps: {
    orderBy: { createdAt: "asc" as const },
    select: {
      hostname: true, cpuPct: true, memoryBytes: true, currentDeploymentId: true,
      app: { select: { id: true, name: true, kind: true, port: true, gitRepository: true } },
      deployments: { orderBy: { createdAt: "desc" as const }, take: 1, select: { id: true, status: true, commitSha: true, error: true, createdAt: true } },
    },
  },
} as const;
type Row = Awaited<ReturnType<typeof loadRows>>[number];
const loadRows = (db: Tx, projectId: string) =>
  db.previewEnv.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take: 60, select: ROW_SELECT });

/** The stored owner/name as a URL, or null when it is not one. */
const repoUrlOf = (ownerName: string): string | null => (/^[\w.-]+\/[\w.-]+$/.test(ownerName) ? `https://github.com/${ownerName}` : null);

export function toRow(r: Row, ttlHours: number): PreviewRow {
  const live = isLive(r.status);
  const apps = r.apps.map((m) => {
    const d = m.deployments[0];
    // Only what answers gets a link: a first build that failed serves nothing.
    const url = m.app.port !== null && live && m.currentDeploymentId ? `https://${m.hostname}` : null;
    return {
      appId: m.app.id, name: m.app.name, kind: m.app.kind, url,
      deployment: d ? { id: d.id, status: deploymentStatus(d.status), commit: d.commitSha, error: d.error, createdAt: d.createdAt.toISOString() } : null,
      cpuPct: live ? m.cpuPct : null,
      memoryBytes: live && m.memoryBytes !== null ? Number(m.memoryBytes) : null,
    };
  });
  const sum = (xs: Array<number | null>) => (xs.some((x) => x !== null) ? xs.reduce<number>((a, x) => a + (x ?? 0), 0) : null);
  return {
    pr: r.prNumber, name: previewName(r.prNumber), title: r.title, branch: r.branch, author: r.author, status: r.status, reason: r.reason, error: r.error,
    url: apps.find((a) => a.url)?.url ?? null, commit: r.commitSha, repo: repoUrlOf(r.repo), fromFork: r.fromFork, isolatedDb: r.isolatedDb, isolation: P.previewIsolation(r), baseEnvironment: r.baseEnvironment.name,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), lastCommitAt: r.lastCommitAt.toISOString(),
    lastRequestAt: iso(r.lastRequestAt), sleptAt: iso(r.sleptAt), expiresAt: live ? expiresAt(r.lastCommitAt, ttlHours).toISOString() : null,
    usage: { cpuPct: sum(apps.map((a) => a.cpuPct)), memoryBytes: sum(apps.map((a) => a.memoryBytes)) },
    apps,
  };
}

/** Open previews first (newest first), then the 20 newest closed ones. */
export function orderRows(rows: PreviewRow[]): PreviewRow[] {
  const open = rows.filter((r) => r.status !== "closed");
  const closed = rows.filter((r) => r.status === "closed").slice(0, 20);
  return [...open, ...closed];
}

async function dnsView(db: Db, domain: string | null, source: P.PreviewDomainSource, ingress: string, serverIpv4: string | null): Promise<ReturnType<typeof P.PreviewDns.parse>> {
  const row = domain ? await db.previewDomain.findUnique({ where: { domain } }) : null;
  const cf = await db.integration.findFirst({ where: { kind: "cloudflare", status: { not: "disconnected" } }, orderBy: { createdAt: "asc" }, select: { config: true } });
  const tunnelId = (cf?.config as { tunnelId?: unknown } | null)?.tunnelId;
  const tunnel = ingress === "cloudflare_tunnel";
  const record = !domain
    ? null
    : tunnel
      ? typeof tunnelId === "string" ? { type: "CNAME" as const, name: P.previewWildcard(domain), content: `${tunnelId}.cfargotunnel.com` } : null
      : serverIpv4 ? { type: "A" as const, name: P.previewWildcard(domain), content: serverIpv4 } : null;
  const dns01 = !tunnel && process.env.DOCKIFY_ACME_DNS01 === "1";
  return {
    domain, source,
    status: row?.dnsStatus ?? "unchecked",
    detail: row?.dnsDetail ?? null,
    checkedAt: iso(row?.checkedAt),
    cloudflare: row?.cfState ?? "none",
    cloudflareMessage: row?.cfMessage ?? null,
    record,
    tls: tunnel ? "cloudflare" : dns01 ? "wildcard_dns01" : "per_host_http01",
  };
}

async function stateOf(db: Db, p: Project, ingress: string, serverIpv4: string | null) {
  const inst = await instancePreview(db);
  const settings = settingsOf(p, inst.cap);
  const eff = P.effectivePreviewDomain(p.previewDomain, inst.domain, inst.publicUrl);
  const [rows, running, diskPct, dns] = await Promise.all([
    loadRows(db, p.id),
    db.previewEnv.count({ where: { status: { in: ["building", "ready", "asleep", "failed"] } } }),
    latestDiskPct(db),
    dnsView(db, eff.domain, eff.source, ingress, serverIpv4),
  ]);
  return {
    settings,
    passwordSetAt: iso(p.previewPasswordSetAt),
    previews: orderRows(rows.map((r) => toRow(r, p.previewTtlHours))),
    server: { running, cap: inst.cap, diskPct, diskGuardPct: DISK_GUARD_PCT },
    dns,
    ceiling: P.previewCeiling(settings, settings.appIds.length),
  };
}

async function previewOf(db: Tx, projectId: string, pr: number) {
  const row = await db.previewEnv.findUnique({ where: { projectId_prNumber: { projectId, prNumber: pr } }, select: { id: true, status: true, title: true } });
  if (!row) throw notFound("Preview");
  return row;
}

export const previewHandlers: Handlers = {
  "previews.get": async ({ params, actor, ctx }) => {
    const p = await projectFor(ctx.db, actor, params.slug);
    return stateOf(ctx.db, p, ctx.config.ingress, ctx.config.serverIpv4);
  },

  "previews.detail": async ({ params, actor, ctx }) => {
    const p = await projectFor(ctx.db, actor, params.slug);
    const row = await ctx.db.previewEnv.findUnique({ where: { projectId_prNumber: { projectId: p.id, prNumber: params.pr } }, select: { ...ROW_SELECT, apps: { ...ROW_SELECT.apps, select: { ...ROW_SELECT.apps.select, id: true } } } });
    if (!row) throw notFound("Preview");
    const deps = await ctx.db.deployment.findMany({
      where: { previewId: { in: row.apps.map((a) => a.id) } }, orderBy: { createdAt: "desc" }, take: 30,
      select: { id: true, appId: true, status: true, commitSha: true, branch: true, message: true, trigger: true, createdAt: true, finishedAt: true, actorType: true, actorId: true, actorName: true, gitAuthor: true, gitAuthorAvatarUrl: true, gitAuthorName: true },
    });
    const byId = new Map(row.apps.map((a) => [a.app.id, a.app]));
    return {
      ...toRow(row, p.previewTtlHours),
      deployments: deps.map((d) => {
        const a = byId.get(d.appId);
        return recentDeployment(d, { id: d.appId, name: a?.name ?? "", kind: a?.kind, repo: a?.gitRepository ?? null }, p.slug, previewName(params.pr));
      }),
    };
  },

  "previews.settings": async ({ params, body, actor, req, ctx }) => {
    const a = actorOf(actor);
    const p = await projectFor(ctx.db, actor, params.slug);
    const base = p.environments.find((e) => e.name === body.baseEnvironment);
    if (!base) throw new HttpError(400, `There is no ${body.baseEnvironment} environment in this project`, "INVALID_REQUEST", { field: "baseEnvironment" });
    if (body.enabled && previewNeedsOwnDb({ environments: p.environments, previewIsolatedDb: body.isolatedDb }) && !body.isolatedDb) {
      throw new HttpError(400, "This project has one environment, so each preview needs its own database, or add an environment for previews to share", "INVALID_REQUEST", { field: "isolatedDb" });
    }
    const eligible = new Map(base.apps.filter((x) => PREVIEW_KINDS.has(x.kind) && x.gitRepository && x.deployTarget === "server").map((x) => [x.id, x]));
    const wanted = new Set(body.appIds);
    for (const id of wanted) {
      if (!eligible.has(id)) throw new HttpError(400, "Only git-built frontend, backend and bot apps of the base environment can be in a preview", "INVALID_REQUEST", { field: "appIds" });
    }
    if (body.enabled && wanted.size === 0) throw new HttpError(400, "Pick at least one app to include in previews", "INVALID_REQUEST", { field: "appIds" });
    if (body.domain && new URL(ctx.config.publicUrl.origin).hostname === body.domain) {
      throw new HttpError(400, "The preview domain cannot be the dashboard host", "INVALID_REQUEST", { field: "domain" });
    }
    const inst = await instancePreview(ctx.db);
    const before = P.effectivePreviewDomain(p.previewDomain, inst.domain, inst.publicUrl).domain;
    const after = P.effectivePreviewDomain(body.domain, inst.domain, inst.publicUrl).domain;
    // Turning protection on with no password yet makes one now, so no preview is ever locked behind a
    // password nobody has seen. The answer below is the only place it ever appears.
    const firstPassword = body.enabled && body.access === "password" && !p.previewPasswordSetAt ? newPreviewPassword() : null;
    const firstHash = firstPassword ? await hashPreviewPassword(firstPassword) : null;

    await ctx.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${SERVER_LOCK}))`;
      await tx.project.update({
        where: { id: p.id },
        data: {
          previewEnabled: body.enabled, previewBaseEnv: body.baseEnvironment, previewMaxConcurrent: body.maxConcurrent, previewDomain: body.domain,
          previewCpuLimit: body.cpuLimit, previewMemoryMb: body.memoryMb, previewPidsLimit: body.pidsLimit, previewIdleMinutes: body.idleMinutes,
          previewTtlHours: body.ttlHours, previewFromForks: body.fromForks, previewIsolatedDb: body.isolatedDb, previewProductionAccess: body.productionAccess, previewAccess: body.access,
          ...(firstHash ? { previewPasswordHash: firstHash, previewPasswordSetAt: new Date() } : {}),
        },
      });
      // An explicit choice per app, so a later default change never adds or drops one silently.
      for (const x of eligible.values()) await tx.app.update({ where: { id: x.id }, data: { previewEnabled: wanted.has(x.id) } });
      if (body.serverMaxConcurrent !== inst.cap) await tx.instance.update({ where: { id: 1 }, data: { previewServerMax: body.serverMaxConcurrent } });
      // A comment on an open pull request says whether its URL asks for a password and what it runs
      // with, so it follows the settings.
      if (body.enabled && (body.access !== p.previewAccess || body.productionAccess !== p.previewProductionAccess)) {
        const open = await tx.previewEnv.findMany({ where: { projectId: p.id, status: { in: ["building", "ready", "asleep", "failed"] } }, select: { id: true } });
        for (const o of open) await enqueuePreviewTx(tx, "preview_feedback", o.id);
      }
      // A running preview holds its secrets in its container's config, so this setting has to reach
      // it now, not at the next timed pass. No dedupe key: an open reconcile may have read the old
      // value already. A preview still building waits for the timed pass (planIsolationDrift).
      if (body.enabled && body.productionAccess !== p.previewProductionAccess) {
        await enqueueTx(tx, { kind: "reconcile", lane: "maintenance", serverId: await defaultServerId(tx), payload: {} });
      }
      // Turned off: every running preview goes now; the janitor would find them anyway.
      if (!body.enabled) {
        const open = await tx.previewEnv.findMany({ where: { projectId: p.id, status: { in: ["building", "ready", "asleep", "failed", "blocked"] } }, select: { id: true } });
        for (const o of open) await retirePreview(tx, o.id, "disabled");
      }
      for (const d of new Set([before, after])) if (d && body.enabled) await enqueuePreviewTx(tx, "preview_dns", d);
      if (before && before !== after) await enqueuePreviewTx(tx, "preview_dns", before);
      await audit(tx, {
        category: "config", action: "previews.settings", verb: "changed the preview settings of", targetType: "project", targetId: p.id, targetLabel: p.slug,
        changes: { ...body, appIds: [...wanted] }, ...who(a, req),
      });
    });
    const fresh = await projectFor(ctx.db, actor, params.slug);
    return { ...settingsOf(fresh, body.serverMaxConcurrent), ...(firstPassword ? { password: firstPassword } : {}) };
  },

  "previews.password": async ({ params, actor, req, ctx }) => {
    const a = actorOf(actor);
    const p = await projectFor(ctx.db, actor, params.slug);
    const password = newPreviewPassword();
    const passwordHash = await hashPreviewPassword(password);
    const setAt = new Date();
    await ctx.db.$transaction(async (tx) => {
      await tx.project.update({ where: { id: p.id }, data: { previewPasswordHash: passwordHash, previewPasswordSetAt: setAt } });
      await audit(tx, { category: "config", action: "previews.password", verb: p.previewPasswordSetAt ? "changed the preview password of" : "made the preview password of", targetType: "project", targetId: p.id, targetLabel: p.slug, ...who(a, req) });
    });
    return { password, setAt: setAt.toISOString() };
  },

  "previews.wake": async ({ params, actor, req, ctx }) => {
    const a = actorOf(actor);
    const p = await projectFor(ctx.db, actor, params.slug);
    const row = await previewOf(ctx.db, p.id, params.pr);
    if (row.status !== "asleep" && row.status !== "ready") throw new HttpError(409, `Preview ${previewName(params.pr)} is ${row.status}, so there is nothing to wake`, "NOT_ASLEEP");
    await ctx.db.$transaction(async (tx) => {
      await enqueuePreviewTx(tx, "preview_wake", row.id, await defaultServerId(tx));
      await audit(tx, { category: "deploys", action: "previews.wake", verb: "woke preview", targetType: "preview", targetId: row.id, targetLabel: `${p.slug}/${previewName(params.pr)}`, ...who(a, req) });
    });
    return undefined;
  },

  "previews.delete": async ({ params, actor, req, ctx }) => {
    const a = actorOf(actor);
    const p = await projectFor(ctx.db, actor, params.slug);
    const row = await previewOf(ctx.db, p.id, params.pr);
    await ctx.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${SERVER_LOCK}))`;
      await retirePreview(tx, row.id, "deleted");
      await audit(tx, { category: "deploys", action: "previews.delete", verb: "deleted preview", targetType: "preview", targetId: row.id, targetLabel: `${p.slug}/${previewName(params.pr)}`, ...who(a, req) });
    });
    return undefined;
  },

  "previews.dns.check": async ({ params, actor, ctx }) => {
    const p = await projectFor(ctx.db, actor, params.slug);
    const inst = await instancePreview(ctx.db);
    const d = P.effectivePreviewDomain(p.previewDomain, inst.domain, inst.publicUrl).domain;
    if (!d) throw new HttpError(409, "Set a preview domain first", "NO_PREVIEW_DOMAIN");
    await ctx.db.$transaction((tx) => enqueuePreviewTx(tx, "preview_dns", d));
    return undefined;
  },
};
