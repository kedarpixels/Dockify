import type { JobKind, JobLane, Prisma, PrismaClient } from "../generated/client/index.js";

/** The job kinds only a server can run. In step with CHECK jobs_server_bound (queue.test.ts). */
export const SERVER_BOUND_KINDS = [
  "deploy", "remove_app", "backup", "restore", "restore_test", "prune", "janitor", "reconcile",
  "preview_cleanup", "preview_wake", "edge_route_sync", "app_power", "scheduled_run", "service_upgrade", "vercel_sync",
] as const satisfies readonly JobKind[];
export type ServerBoundKind = (typeof SERVER_BOUND_KINDS)[number];

/** The lanes only a server's loops claim, so a null there would never run. In step with the CHECK too. */
export const SERVER_ONLY_LANES = ["deploy", "data", "cron"] as const satisfies readonly JobLane[];
export type ServerOnlyLane = (typeof SERVER_ONLY_LANES)[number];

type GlobalKind = Exclude<JobKind, ServerBoundKind>;

interface EnqueueFields {
  payload: Prisma.InputJsonValue;
  /** While an open job has this key, a second enqueue returns the open one instead. */
  dedupeKey?: string;
  maxAttempts?: number;
  runAfterMs?: number;
}

/**
 * The one enqueue for the leased jobs table, shared by the api and the worker. While an open job
 * has the dedupe key, a second enqueue returns the open one instead of adding a row. The type says
 * what CHECK jobs_server_bound says: a server-bound kind or a server's lane names its server (the
 * lane defaults to deploy, so only a bound kind may leave it out), and anything else names none.
 */
export type EnqueueInput = EnqueueFields &
  (
    | { kind: ServerBoundKind; lane?: JobLane; serverId: string }
    | { kind: GlobalKind; lane: ServerOnlyLane; serverId: string }
    | { kind: GlobalKind; lane: Exclude<JobLane, ServerOnlyLane>; serverId?: never }
  );

/** The primary server's id: where new apps go, and what runs the jobs no app owns. Never cached. */
export async function defaultServerId(db: Prisma.TransactionClient): Promise<string> {
  const server = await db.server.findFirst({ where: { isPrimary: true }, select: { id: true } });
  if (!server) throw new Error("The database has no primary server row: its migrations have not run");
  return server.id;
}

/** Enqueues inside a transaction the caller already holds, so the job commits with its rows. */
export async function enqueueTx(tx: Prisma.TransactionClient, input: EnqueueInput): Promise<string> {
  if (input.dedupeKey) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.dedupeKey}))`;
    const open = await tx.job.findFirst({ where: { dedupeKey: input.dedupeKey, completedAt: null, failedAt: null }, select: { id: true } });
    if (open) return open.id;
  }
  const job = await tx.job.create({
    data: {
      kind: input.kind,
      lane: input.lane ?? "deploy",
      serverId: input.serverId ?? null,
      payload: input.payload,
      dedupeKey: input.dedupeKey ?? null,
      maxAttempts: input.maxAttempts ?? 3,
      runAfter: new Date(Date.now() + (input.runAfterMs ?? 0)),
    },
    select: { id: true },
  });
  return job.id;
}

export async function enqueue(db: PrismaClient, input: EnqueueInput): Promise<string> {
  return db.$transaction((tx) => enqueueTx(tx, input));
}

/** Preview apps run on the primary server for now, so these two take its id (defaultServerId). */
export type ServerPreviewJobKind = "preview_cleanup" | "preview_wake";
export type GlobalPreviewJobKind = "preview_feedback" | "preview_dns";
export type PreviewJobKind = ServerPreviewJobKind | GlobalPreviewJobKind;

/**
 * The one enqueue for preview jobs, keyed per preview (or per domain for preview_dns). A feedback
 * or wake job that a worker already claimed read the old state, so a new one is added behind it;
 * an unclaimed one is reused. A cleanup is idempotent, so any open one is reused.
 */
export async function enqueuePreviewTx(tx: Prisma.TransactionClient, kind: ServerPreviewJobKind, id: string, serverId: string): Promise<string>;
export async function enqueuePreviewTx(tx: Prisma.TransactionClient, kind: GlobalPreviewJobKind, id: string): Promise<string>;
export async function enqueuePreviewTx(tx: Prisma.TransactionClient, kind: PreviewJobKind, id: string, serverId?: string): Promise<string> {
  const key = `${kind}:${id}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  const open = await tx.job.findFirst({
    where: { dedupeKey: key, completedAt: null, failedAt: null, ...(kind === "preview_cleanup" ? {} : { lockedBy: null }) },
    select: { id: true },
  });
  if (open) return open.id;
  const payload = kind === "preview_dns" ? { domain: id } : { previewId: id };
  const job = await tx.job.create({
    data: { kind, lane: "maintenance", serverId: serverId ?? null, payload, dedupeKey: key, maxAttempts: kind === "preview_cleanup" ? 10 : 5, runAfter: new Date() },
    select: { id: true },
  });
  return job.id;
}
