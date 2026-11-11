/**
 * The secret-opening service. The worker holds no master key: it names secret rows here with the internal
 * channel token, and the api checks every kind and that the claimed job is live, audits, and answers with
 * the values. Nothing else leaves: no key, no wrapped DEK, no row it did not name.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { Uuid } from "@dockify/contracts";
import { keyringVault, type SecretKind } from "@dockify/db";
import { audit } from "../audit.ts";
import type { Ctx } from "../app.ts";
import { HttpError } from "../errors.ts";
import { INFRA_POLICIES } from "../policy.ts";

/**
 * Kinds the worker may open. Deliberately absent, the api's alone: totp seeds, env versions, the inbound
 * webhook secrets GitHub and Vercel sign with, and the GitHub App's client secret.
 */
export const WORKER_OPEN_KINDS: ReadonlySet<SecretKind> = new Set<SecretKind>([
  "env_var", "env_snapshot", "integration_token", "storage_secret_key", "channel_url", "channel_secret", "github_private_key", "backup_key", "database_password",
  "email_message",
]);
/** Kinds the worker creates. */
export const WORKER_SEAL_KINDS = ["env_snapshot", "backup_key"] as const satisfies readonly SecretKind[];

const MAX_IDS = 500;

/** What the worker says it is doing. Audited as given; checked only when it names a job. */
export const Context = z.strictObject({
  jobId: Uuid.nullable(),
  /** A job kind, or "timer:<name>" for periodic work. */
  purpose: z.string().min(1).max(80),
});
export const OpenBody = z.strictObject({ ids: z.array(Uuid).min(1).max(MAX_IDS), context: Context });
export const SealBody = z.strictObject({
  id: Uuid,
  kind: z.enum(WORKER_SEAL_KINDS),
  ownerType: z.string().min(1).max(40),
  ownerId: z.string().min(1).max(80),
  value: z.string().max(1024 * 1024),
  context: Context,
});
export const EscrowBody = z.strictObject({ id: Uuid, context: Context });

type Context = z.infer<typeof Context>;

/** A job the worker names must exist, be claimed and still leased, and not be settled. */
async function assertLiveJob(ctx: Ctx, c: Context, now = new Date()): Promise<void> {
  if (!c.jobId) return;
  const job = await ctx.db.job.findUnique({ where: { id: c.jobId }, select: { kind: true, lockedUntil: true, completedAt: true, failedAt: true } });
  const live = !!job && !job.completedAt && !job.failedAt && !!job.lockedUntil && job.lockedUntil > now;
  if (!live) throw new HttpError(409, "That job is not running", "JOB_NOT_LIVE");
  if (job.kind !== c.purpose) throw new HttpError(409, "That job is not of the kind named", "JOB_KIND_MISMATCH");
}

const target = (c: Context) => (c.jobId ? { targetType: "job", targetId: c.jobId, targetLabel: c.purpose } : { targetType: "worker", targetLabel: c.purpose });

async function auditOpen(ctx: Ctx, req: FastifyRequest, c: Context, action: string, verb: string, suffix: string, failed = false): Promise<void> {
  await audit(ctx.db, { category: "access", action, verb, actorType: "system", actorName: "worker", ...target(c), suffix, failed, ip: req.clientIp });
}

export function registerInternalRoutes(app: FastifyInstance, ctx: Ctx): void {
  const vault = keyringVault(ctx.ring);

  app.post("/internal/secrets/open", { schema: { body: OpenBody }, config: { policy: INFRA_POLICIES["POST /internal/secrets/open"] } }, async (req) => {
    const body = req.body as z.infer<typeof OpenBody>;
    const ids = [...new Set(body.ids)];
    await assertLiveJob(ctx, body.context);
    const rows = await ctx.db.secret.findMany({ where: { id: { in: ids } }, select: { id: true, kind: true } });
    const refused = rows.filter((r) => !WORKER_OPEN_KINDS.has(r.kind));
    if (refused.length) {
      await auditOpen(ctx, req, body.context, "secret.open.refused", "was refused secret values for", `${refused.length} ${[...new Set(refused.map((r) => r.kind))].join(", ")}`, true);
      throw new HttpError(403, "The worker may not open secrets of that kind", "SECRET_KIND_REFUSED");
    }
    const values = await vault.open(ctx.db, ids);
    const kinds = [...new Set(rows.map((r) => r.kind))].sort().join(", ");
    await auditOpen(ctx, req, body.context, "secret.open", "opened secret values for", `${rows.length} value${rows.length === 1 ? "" : "s"}${kinds ? ` (${kinds})` : ""}`);
    return { values: Object.fromEntries(values) };
  });

  app.post("/internal/secrets/seal", { schema: { body: SealBody }, config: { policy: INFRA_POLICIES["POST /internal/secrets/seal"] } }, async (req) => {
    const body = req.body as z.infer<typeof SealBody>;
    await assertLiveJob(ctx, body.context);
    const s = await vault.seal({ id: body.id, kind: body.kind, ownerType: body.ownerType, ownerId: body.ownerId }, body.value);
    await auditOpen(ctx, req, body.context, "secret.seal", "sealed a secret value for", `${body.kind} ${body.ownerType}:${body.ownerId}`);
    return {
      kekId: s.kekId,
      wrappedDek: s.wrappedDek.toString("base64"),
      dekNonce: s.dekNonce.toString("base64"),
      ciphertext: s.ciphertext.toString("base64"),
      ctNonce: s.ctNonce.toString("base64"),
    };
  });

  app.post("/internal/secrets/escrow", { schema: { body: EscrowBody }, config: { policy: INFRA_POLICIES["POST /internal/secrets/escrow"] } }, async (req) => {
    const body = req.body as z.infer<typeof EscrowBody>;
    await assertLiveJob(ctx, body.context);
    const row = await ctx.db.secret.findUnique({ where: { id: body.id }, select: { kind: true } });
    if (!row || row.kind !== "backup_key") {
      await auditOpen(ctx, req, body.context, "secret.escrow.refused", "was refused an escrow copy of", row?.kind ?? "a missing row", true);
      throw new HttpError(403, "Only the backup key can be escrowed", "SECRET_KIND_REFUSED");
    }
    const text = await vault.escrow(ctx.db, body.id);
    await auditOpen(ctx, req, body.context, "secret.escrow", "sealed the backup key for offsite escrow for", "backup_key");
    return { text };
  });
}
