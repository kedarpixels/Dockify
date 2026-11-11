// The api never writes a terminal status for a server build: cancel moves it to `cancelling` and
// the worker that owns it unwinds and writes `cancelled`.
import { meta, requireActor } from "../../actor.ts";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db, Prisma } from "@dockify/db";
import { assertProjectScope, enforce, tokenProjectLimit, type Actor } from "../../actor.ts";
import type { Ctx, Handlers } from "../../app.ts";
import { POLICIES } from "../../policy.ts";
import { createReauthorizer, type Reauthorizer } from "../../reauth.ts";
import { audit } from "../../audit.ts";
import { loadPeople } from "../../actor-view.ts";
import { HttpError, unauthenticated } from "../../errors.ts";
import { swapStrategy } from "../../../../worker/src/deploy/strategy.ts";
import { followOnly, vercelApiFor } from "../integrations/vercel.ts";
import { readBuildLog, streamBuildLog } from "../integrations/vercel-logs.ts";
import { createHttpClient, type HttpClient } from "@dockify/net-guard";
import { appendLog, enqueueDeployment } from "./enqueue.ts";
import {
  decodeChunk, decodeCursor, encodeCursor, IN_FLIGHT, median, sseFrame, statusFilter, TERMINAL, toRecent, toSteps, vercelSteps,
  type DeploymentRow, type LogLine,
} from "./mapping.ts";

const PAGE = 50;
const MAX_LINES_PER_PAGE = 5_000;
/** Decoded bytes per page, roughly: text plus per-line overhead. */
export const MAX_PAGE_BYTES = 1024 * 1024;
const CHUNKS_PER_READ = 100;
const SSE_POLL_MS = 1_000;
const SSE_HEARTBEAT_MS = 15_000;
const SSE_MAX_MS = 60 * 60_000;
/** Each open stream polls the DB for up to an hour, so a viewer or read token must not hold hundreds. */
const MAX_DEPLOY_STREAMS_PER_USER = 4;
const openDeployStreams = new Map<string, number>();

const include = { app: { include: { environment: { include: { project: { select: { slug: true, id: true } } } } } } } as const;

const notFound = () => new HttpError(404, "Deployment not found", "NOT_FOUND");

async function load(db: Db, id: string, actor: Actor) {
  const d = await db.deployment.findUnique({ where: { id }, include });
  if (!d) throw notFound();
  assertProjectScope(actor, d.app.environment.project.id);
  return d;
}

const who = (a: Actor) => ({ actorType: a.kind === "token" ? ("token" as const) : ("user" as const), actorId: a.kind === "token" ? a.tokenId : a.userId, actorName: a.name });

/**
 * Lines after `after`, oldest first. A repetitive log gzips about a thousand to one, so the line
 * cap alone would let one request inflate tens of MiB: the byte budget is the real bound.
 * At least one line is always returned so paging makes progress.
 */
export async function readLines(
  db: Db, deploymentId: string, after: number, max = MAX_LINES_PER_PAGE, maxBytes = MAX_PAGE_BYTES,
): Promise<{ lines: LogLine[]; more: boolean }> {
  const chunks = await db.$queryRaw<Array<{ firstSeq: number; lineCount: number; gzip: Uint8Array }>>`
    SELECT "firstSeq", "lineCount", gzip FROM deployment_log_chunks
    WHERE "deploymentId" = ${deploymentId}::uuid AND "firstSeq" + "lineCount" > ${after + 1}
    ORDER BY "firstSeq" ASC LIMIT ${CHUNKS_PER_READ}`;
  const lines: LogLine[] = [];
  let bytes = 0;
  for (const c of chunks) {
    for (const l of decodeChunk(c.firstSeq, c.gzip, c.lineCount)) {
      if (l.seq <= after) continue;
      if (lines.length >= max) return { lines, more: true };
      const size = l.text.length + l.ts.length + 48;
      if (lines.length > 0 && bytes + size > maxBytes) return { lines, more: true };
      lines.push(l);
      bytes += size;
    }
  }
  return { lines, more: chunks.length === CHUNKS_PER_READ };
}

const MAX_LOG_READS_PER_USER = 2;
const logReads = new Map<string, number>();

export async function withLogReadSlot<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const n = logReads.get(userId) ?? 0;
  if (n >= MAX_LOG_READS_PER_USER) throw new HttpError(429, "Too many log reads at once", "TOO_MANY_READS");
  logReads.set(userId, n + 1);
  try {
    return await fn();
  } finally {
    const left = (logReads.get(userId) ?? 1) - 1;
    if (left <= 0) logReads.delete(userId);
    else logReads.set(userId, left);
  }
}

function dayStart(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

async function stats(db: Db, scope: Prisma.DeploymentWhereInput) {
  const now = Date.now();
  const since = new Date(now - 48 * 3600_000);
  const [inFlight, queued, recent] = await Promise.all([
    db.deployment.count({ where: { ...scope, status: { in: ["building", "deploying", "cancelling"] } } }),
    db.deployment.count({ where: { ...scope, status: "queued" } }),
    db.deployment.findMany({
      where: { ...scope, finishedAt: { gte: since }, status: { in: ["ready", "failed"] } },
      select: { status: true, createdAt: true, startedAt: true, finishedAt: true },
      take: 20_000,
    }),
  ]);
  const cut = now - 24 * 3600_000;
  const cur = recent.filter((r) => r.finishedAt!.getTime() >= cut);
  const prev = recent.filter((r) => r.finishedAt!.getTime() < cut);
  const secs = (rs: typeof recent) => rs.filter((r) => r.status === "ready").map((r) => Math.round((r.finishedAt!.getTime() - (r.startedAt ?? r.createdAt).getTime()) / 1000));
  return {
    inFlight,
    queued,
    succeeded24h: cur.filter((r) => r.status === "ready").length,
    failed24h: cur.filter((r) => r.status === "failed").length,
    succeededPrev24h: prev.filter((r) => r.status === "ready").length,
    failedPrev24h: prev.filter((r) => r.status === "failed").length,
    medianSeconds: median(secs(cur)),
    medianPrevSeconds: median(secs(prev)),
  };
}

/** A stream outlives the request's auth check, so it re-runs the route policy and the token's project limit while open. */
export function streamReauth(ctx: Pick<Ctx, "db" | "web">, req: FastifyRequest, endpoint: "deployments.logs" | "deployments.logs.stream", projectId: string): Reauthorizer {
  return createReauthorizer(async () => {
    const actor = await enforce(ctx.db, req, ctx.web, POLICIES[endpoint]);
    if (!actor) throw unauthenticated();
    assertProjectScope(actor, projectId);
  });
}

/** SSE. Resumes from Last-Event-ID and ends with a `done` event. */
async function streamLogs(db: Db, req: FastifyRequest, reply: FastifyReply, id: string, after: number, allowed: Reauthorizer): Promise<void> {
  // Checked before hijack so the cap answers a clean 429 instead of opening the stream.
  const userId = req.actor?.userId ?? null;
  if (userId && (openDeployStreams.get(userId) ?? 0) >= MAX_DEPLOY_STREAMS_PER_USER) {
    throw new HttpError(429, "Too many open deployment log streams", "TOO_MANY_STREAMS");
  }
  if (userId) openDeployStreams.set(userId, (openDeployStreams.get(userId) ?? 0) + 1);
  let released = false;
  const release = (): void => {
    if (released || !userId) return;
    released = true;
    openDeployStreams.set(userId, Math.max(0, (openDeployStreams.get(userId) ?? 1) - 1));
  };
  const lastId = Number(req.headers["last-event-id"]);
  let cursor = Number.isInteger(lastId) && lastId >= 0 ? lastId : after;
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
    Connection: "keep-alive",
  });
  let closed = false;
  req.raw.on("close", () => {
    closed = true;
    release();
  });
  const started = Date.now();
  let lastBeat = Date.now();
  try {
    while (!closed && Date.now() - started < SSE_MAX_MS) {
      if (!(await allowed())) {
        res.write(sseFrame("end", { reason: "unauthorized" }));
        break;
      }
      const { lines, more } = await readLines(db, id, cursor, 1_000);
      for (const l of lines) res.write(sseFrame("line", l, l.seq));
      if (lines.length) cursor = lines[lines.length - 1]!.seq;
      if (more) continue;
      const row = await db.deployment.findUnique({ where: { id }, select: { status: true, imageId: true } });
      if (!row || TERMINAL.includes(row.status)) {
        res.write(sseFrame("done", { status: row?.status ?? "failed" }));
        break;
      }
      if (Date.now() - lastBeat > SSE_HEARTBEAT_MS) {
        res.write(": keep-alive\n\n");
        lastBeat = Date.now();
      }
      await new Promise((r) => setTimeout(r, SSE_POLL_MS));
    }
  } catch {
    if (!closed) res.write(sseFrame("error", { error: "log stream failed" }));
  } finally {
    res.end();
    release();
  }
}

async function streamVercel(ctx: Ctx, req: FastifyRequest, reply: FastifyReply, d: { id: string; externalId: string | null; projectId: string; status: string }, after: number, endpoint: "deployments.logs" | "deployments.logs.stream"): Promise<void> {
  const settled = async () => {
    const row = await ctx.db.deployment.findUnique({ where: { id: d.id }, select: { status: true } });
    return row && TERMINAL.includes(row.status) ? row.status : null;
  };
  await streamBuildLog(ctx.db, ctx.ring, req, reply, d, after, streamReauth(ctx, req, endpoint, d.projectId), settled, req.actor?.userId ?? "anonymous");
}

let vercelHttp: HttpClient | undefined;
export const setDeploymentsVercelHttp = (h: HttpClient | undefined): void => {
  vercelHttp = h;
};

export const wantsStream = (req: FastifyRequest) => String(req.headers.accept ?? "").includes("text/event-stream");

export const deploymentHandlers: Handlers = {
  "deployments.list": async ({ query, actor, ctx }) => {
    const a = requireActor(actor);
    const where: Prisma.DeploymentWhereInput = {};
    const and: Prisma.DeploymentWhereInput[] = [];
    const limit = tokenProjectLimit(a);
    if (limit) and.push({ app: { environment: { projectId: { in: limit } } } });
    // The KPI strip ignores the list's filters, so its scope is taken before any is added.
    const scope: Prisma.DeploymentWhereInput = and.length ? { AND: [...and] } : {};
    const statuses = statusFilter(query.status);
    if (statuses) and.push({ status: { in: statuses } });
    if (query.project) and.push({ app: { environment: { project: { slug: query.project } } } });
    if (query.provider) and.push({ provider: query.provider });
    if (query.q?.trim()) {
      const q = query.q.trim();
      and.push({ OR: [
        { message: { contains: q, mode: "insensitive" } },
        { branch: { contains: q, mode: "insensitive" } },
        { commitSha: { startsWith: q.toLowerCase() } },
        { app: { name: { contains: q, mode: "insensitive" } } },
        { app: { displayName: { contains: q, mode: "insensitive" } } },
      ] });
    }
    if (query.from) and.push({ createdAt: { gte: dayStart(query.from) } });
    if (query.to) and.push({ createdAt: { lt: dayStart(query.to) } });
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      if (!c) throw new HttpError(400, "Invalid cursor", "INVALID_CURSOR");
      and.push({ OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] });
    }
    if (and.length) where.AND = and;
    const rows = await ctx.db.deployment.findMany({ where, include, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: PAGE + 1 });
    const page = rows.slice(0, PAGE);
    const people = await loadPeople(ctx.db, a, page);
    return {
      items: page.map((r) => toRecent(r as unknown as DeploymentRow, people)),
      nextCursor: rows.length > PAGE ? encodeCursor(page[page.length - 1]!) : null,
      ...(query.cursor ? {} : { stats: await stats(ctx.db, scope) }),
    };
  },

  "deployments.get": async ({ params, actor, ctx }) => {
    const a = requireActor(actor);
    const d = await load(ctx.db, params.id, a);
    const app = await ctx.db.app.findUnique({
      where: { id: d.appId },
      select: { currentDeploymentId: true, kind: true, replicas: true, volumes: { select: { name: true, mountPath: true } } },
    });
    const recent = toRecent(d as unknown as DeploymentRow, await loadPeople(ctx.db, a, [d]));
    const preview = d.previewId ? await ctx.db.previewDeployment.findUnique({ where: { id: d.previewId }, select: { env: { select: { prNumber: true } } } }) : null;
    return {
      ...recent,
      actor: recent.actor ?? null,
      current: app?.currentDeploymentId === d.id,
      error: d.error,
      steps: d.provider === "vercel" ? vercelSteps(d) : toSteps(d.steps),
      rolledBack: d.rolledBack,
      swapReasons: d.provider === "vercel" ? [] : app ? swapStrategy({ kind: app.kind, volumes: app.volumes, replicas: app.replicas }).reasons : [],
      pr: preview?.env.prNumber ?? null,
      ...(d.provider === "vercel" ? { followOnly: d.app.vercelFollowOnly } : {}),
    };
  },

  "deployments.logs": async ({ params, query, actor, req, reply, ctx }) => {
    const a = requireActor(actor);
    const d = await load(ctx.db, params.id, a);
    const after = query.after ?? -1;
    if (d.provider === "vercel") {
      const source = { id: d.id, externalId: d.externalId, projectId: d.app.environment.project.id, status: d.status };
      if (wantsStream(req)) {
        await streamVercel(ctx, req, reply, source, after, "deployments.logs");
        return undefined;
      }
      return withLogReadSlot(a.userId, () => readBuildLog(ctx.db, ctx.ring, { ...source, terminal: TERMINAL.includes(d.status) }, after));
    }
    if (wantsStream(req)) {
      await streamLogs(ctx.db, req, reply, d.id, after, streamReauth(ctx, req, "deployments.logs", d.app.environment.project.id));
      return undefined;
    }
    const { lines, more } = await withLogReadSlot(a.userId, () => readLines(ctx.db, d.id, after));
    const row = await ctx.db.deployment.findUnique({ where: { id: d.id }, select: { status: true } });
    return { lines, done: !more && !!row && TERMINAL.includes(row.status) };
  },

  "deployments.logs.stream": async ({ params, query, actor, req, reply, ctx }) => {
    const a = requireActor(actor);
    const d = await load(ctx.db, params.id, a);
    if (d.provider === "vercel") {
      await streamVercel(ctx, req, reply, { id: d.id, externalId: d.externalId, projectId: d.app.environment.project.id, status: d.status }, query.after ?? -1, "deployments.logs.stream");
      return undefined;
    }
    await streamLogs(ctx.db, req, reply, d.id, query.after ?? -1, streamReauth(ctx, req, "deployments.logs.stream", d.app.environment.project.id));
    return undefined;
  },

  "deployments.redeploy": async ({ params, actor, req, ctx }) => {
    const a = requireActor(actor);
    const src = await load(ctx.db, params.id, a);
    // Never promote a preview build: it is fork/PR code, and redeploying it would run that code
    // in the app's real environment with its production secrets.
    if (src.previewId) throw new HttpError(409, "A preview deployment cannot be redeployed into the live app", "PREVIEW_NOT_PROMOTABLE");
    if (src.provider === "vercel" || src.app.deployTarget !== "server") throw new HttpError(409, "This deployment ran on Vercel. Press Deploy on the app, or redeploy it on Vercel.", "NOT_SERVER_TARGET");
    // Same commit and, while it still exists, the same image; env is resolved fresh.
    const id = await enqueueDeployment(ctx.db, src.appId, {
      trigger: "redeploy",
      commitSha: src.commitSha,
      branch: src.branch,
      message: src.message,
      imageId: src.imageId,
      imageRef: src.imageRef,
      gitAuthor: src.gitAuthor,
      gitAuthorAvatarUrl: src.gitAuthorAvatarUrl,
      gitAuthorName: src.gitAuthorName,
      ...who(a),
    });
    await audit(ctx.db, { category: "deploys", action: "deployment.redeploy", verb: "redeployed", ...who(a), targetType: "app", targetId: src.appId, targetLabel: src.app.name, ...meta(req) });
    return { deployment: toRecent((await load(ctx.db, id, a)) as unknown as DeploymentRow) };
  },

  "deployments.rollback": async ({ params, actor, req, ctx }) => {
    const a = requireActor(actor);
    const target = await load(ctx.db, params.id, a);
    // A settled preview passes the ready+imageId check below, but it is fork/PR code: rolling
    // back to it would serve that code with production secrets.
    if (target.previewId) throw new HttpError(409, "A preview deployment cannot be rolled back into the live app", "PREVIEW_NOT_PROMOTABLE");
    if (target.provider === "vercel" || target.app.deployTarget !== "server") throw new HttpError(409, "This deployment ran on Vercel. Roll it back on Vercel: Instant Rollback there also pauses automatic production domains, which Dockify cannot undo for you.", "NOT_SERVER_TARGET");
    if (target.status !== "ready" || !target.imageId) throw new HttpError(409, "Only a deployment that went ready can be rolled back to", "NOT_ROLLBACK_TARGET");
    const app = await ctx.db.app.findUnique({ where: { id: target.appId }, select: { currentDeploymentId: true } });
    if (app?.currentDeploymentId === target.id) throw new HttpError(409, "This deployment is already the one serving", "ALREADY_CURRENT");
    const id = await enqueueDeployment(ctx.db, target.appId, {
      trigger: "rollback",
      rollbackOfId: target.id,
      commitSha: target.commitSha,
      branch: target.branch,
      message: `Rollback to ${target.commitSha ? target.commitSha.slice(0, 7) : target.id.slice(0, 8)}${target.message ? `: ${target.message}` : ""}`.slice(0, 500),
      imageId: target.imageId,
      imageRef: target.imageRef,
      gitAuthor: target.gitAuthor,
      gitAuthorAvatarUrl: target.gitAuthorAvatarUrl,
      gitAuthorName: target.gitAuthorName,
      ...who(a),
    });
    await audit(ctx.db, { category: "deploys", action: "deployment.rollback", verb: "rolled back", ...who(a), targetType: "app", targetId: target.appId, targetLabel: target.app.name, suffix: target.id, ...meta(req) });
    return { deployment: toRecent((await load(ctx.db, id, a)) as unknown as DeploymentRow) };
  },

  "deployments.cancel": async ({ params, actor, req, ctx }) => {
    const a = requireActor(actor);
    const d = await load(ctx.db, params.id, a);
    if (TERMINAL.includes(d.status)) throw new HttpError(409, `This deployment already finished (${d.status})`, "ALREADY_FINISHED");
    // No worker owns a Vercel row: Vercel stops the build, and its answer settles the row here.
    if (d.provider === "vercel") {
      if (d.app.vercelFollowOnly) throw followOnly();
      if (!d.externalId) {
        const job = await ctx.db.job.findFirst({ where: { dedupeKey: `vercel_sync:${d.appId}:deploy`, completedAt: null, failedAt: null }, select: { id: true } });
        if (job) throw new HttpError(409, "Vercel has not accepted this deployment yet. Try again in a moment.", "NOT_STARTED");
        // No job left to run it and Vercel never heard of it: only this can settle it.
      } else {
        const api = await vercelApiFor(ctx.db, ctx.ring, (vercelHttp ??= createHttpClient()));
        await api.cancelDeployment(d.externalId);
      }
      const n = await ctx.db.deployment.updateMany({ where: { id: d.id, status: { in: IN_FLIGHT } }, data: { status: "cancelled", finishedAt: new Date() } });
      if (n.count === 1) await audit(ctx.db, { category: "deploys", action: "deployment.cancel", verb: "cancelled a Vercel deployment of", ...who(a), targetType: "app", targetId: d.appId, targetLabel: d.app.name, suffix: d.id, ...meta(req) });
      return { deployment: toRecent((await load(ctx.db, d.id, a)) as unknown as DeploymentRow) };
    }
    if (d.status !== "cancelling") {
      const n = await ctx.db.deployment.updateMany({ where: { id: d.id, status: { in: IN_FLIGHT.filter((s) => s !== "cancelling") } }, data: { status: "cancelling" } });
      if (n.count === 1) {
        await appendLog(ctx.db, d.id, [`==> cancel requested by ${a.name}`]).catch(() => {});
        await audit(ctx.db, { category: "deploys", action: "deployment.cancel", verb: "cancelled a deployment of", ...who(a), targetType: "app", targetId: d.appId, targetLabel: d.app.name, suffix: d.id, ...meta(req) });
      }
    }
    return { deployment: toRecent((await load(ctx.db, d.id, a)) as unknown as DeploymentRow) };
  },
};
