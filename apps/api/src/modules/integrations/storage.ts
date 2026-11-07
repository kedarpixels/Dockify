/**
 * Storage destinations (S3 compatible) for backups. Each one is an integrations row plus the
 * BackupDestination row the backups module points apps at, kept in step here.
 *
 * Row: integrations kind storage, name = the destination name. config { provider, endpoint, bucket,
 * region }, secretId the access key (integration_token), secondSecretId the secret key
 * (storage_secret_key). lastCheckedAt is the last successful test.
 */
import type { Keyring } from "@dockify/crypto";
import type { Integration, Tx } from "@dockify/db";
import type { Handlers } from "../../app.ts";
import { audit } from "../../audit.ts";
import { badField, HttpError, isUniqueViolation } from "../../errors.ts";
import { who, type IntegrationDeps } from "./deps.ts";
import { OutboundError, outboundUrlProblem, type HttpClient } from "@dockify/net-guard";
import { sha256Hex, signV4 } from "./sigv4.ts";
import { asJson, configOf, hintOfSecret, openSecret, replaceSecret } from "./store.ts";

export type StorageProvider = "r2" | "s3" | "minio" | "custom";

interface StorageConfig {
  provider: StorageProvider;
  endpoint: string;
  bucket: string;
  region: string;
  [k: string]: unknown;
}

export interface S3Target {
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
}

/** Path-style URL: works on R2, MinIO and AWS alike, and never puts the bucket in a hostname. */
export function bucketUrl(endpoint: string, bucket: string, query: Record<string, string> = {}): URL {
  const u = new URL(endpoint);
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/${bucket}`;
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u;
}

/** Lists at most one key: proves the endpoint answers, the keys sign and the bucket is readable. */
export async function testS3(http: HttpClient, t: S3Target, now = new Date()): Promise<{ latencyMs: number }> {
  const problem = outboundUrlProblem(t.endpoint);
  if (problem) throw badField(problem, "endpoint");
  const url = bucketUrl(t.endpoint, t.bucket, { "list-type": "2", "max-keys": "1" });
  const headers = signV4({
    method: "GET", url, region: t.region, service: "s3", accessKey: t.accessKey, secretKey: t.secretKey,
    headers: { "x-amz-content-sha256": sha256Hex("") }, now,
  });
  const started = Date.now();
  let status: number;
  try {
    status = (await http({ method: "GET", url: url.toString(), headers, timeoutMs: 10_000, maxBytes: 256 * 1024 })).status;
  } catch (e) {
    throw new HttpError(502, e instanceof OutboundError ? e.message : "The storage endpoint could not be reached", "STORAGE_UNREACHABLE");
  }
  const latencyMs = Date.now() - started;
  if (status === 200) return { latencyMs };
  if (status === 403 || status === 401) throw new HttpError(400, "The storage provider refused these keys", "STORAGE_AUTH");
  if (status === 404) throw new HttpError(400, "That bucket does not exist", "STORAGE_BUCKET");
  if (status >= 300 && status < 400) throw new HttpError(400, "The endpoint redirected; use the bucket's own regional endpoint", "STORAGE_REDIRECT");
  throw new HttpError(502, `The storage endpoint answered ${status}`, "STORAGE_UPSTREAM");
}

async function targetOf(db: Tx, ring: Keyring, row: Integration): Promise<S3Target> {
  const c = configOf<StorageConfig>(row);
  const accessKey = await openSecret(db, ring, row, "primary");
  const secretKey = await openSecret(db, ring, row, "second");
  if (!accessKey || !secretKey) throw new HttpError(409, "This destination is missing its keys", "STORAGE_KEYS");
  return { endpoint: c.endpoint, bucket: c.bucket, region: c.region, accessKey, secretKey };
}

export async function storageView(db: Tx, row: Integration) {
  const c = configOf<StorageConfig>(row);
  const dest = await db.backupDestination.findUnique({ where: { integrationId: row.id }, select: { isDefault: true } });
  return {
    id: row.id,
    name: row.name,
    provider: c.provider,
    endpoint: c.endpoint,
    bucket: c.bucket,
    region: c.region,
    accessKeyHint: await hintOfSecret(db, row.secretId),
    secretKeyHint: await hintOfSecret(db, row.secondSecretId),
    isDefault: dest?.isDefault ?? false,
    lastTestedAt: row.status === "connected" && row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    error: row.error,
  };
}

async function setDefault(tx: Tx, integrationId: string, isDefault: boolean): Promise<void> {
  if (isDefault) await tx.backupDestination.updateMany({ where: { isDefault: true, NOT: { integrationId } }, data: { isDefault: false } });
  await tx.backupDestination.update({ where: { integrationId }, data: { isDefault } });
}

const notFound = () => new HttpError(404, "Unknown storage destination", "NOT_FOUND");
const regionFor = (provider: StorageProvider, region: string) => (provider === "r2" ? "auto" : region);

export function storageHandlers(deps: IntegrationDeps): Handlers {
  return {
    "integrations.storage.list": async ({ ctx }) => {
      const rows = await ctx.db.integration.findMany({ where: { kind: "storage" }, orderBy: { createdAt: "asc" } });
      return Promise.all(rows.map((r) => storageView(ctx.db, r)));
    },

    "integrations.storage.create": async ({ body, actor, req, ctx }) => {
      const problem = outboundUrlProblem(body.endpoint);
      if (problem) throw badField(problem, "endpoint");
      const region = regionFor(body.provider, body.region);
      // Tested before anything is stored: a destination that cannot be written is not saved.
      await testS3(deps.http, { endpoint: body.endpoint, bucket: body.bucket, region, accessKey: body.accessKey, secretKey: body.secretKey });
      const row = await ctx.db.$transaction(async (tx) => {
        let r: Integration;
        try {
          r = await tx.integration.create({
            data: { kind: "storage", name: body.name, config: asJson({ provider: body.provider, endpoint: body.endpoint, bucket: body.bucket, region }), lastCheckedAt: new Date() },
          });
          await tx.backupDestination.create({ data: { name: body.name, type: "s3", integrationId: r.id, isDefault: false } });
        } catch (e) {
          if (isUniqueViolation(e)) throw new HttpError(409, "A destination with that name exists", "DUPLICATE", { field: "name" });
          throw e;
        }
        await replaceSecret(tx, ctx.ring, r, "primary", "integration_token", body.accessKey);
        const fresh = await tx.integration.findUniqueOrThrow({ where: { id: r.id } });
        await replaceSecret(tx, ctx.ring, fresh, "second", "storage_secret_key", body.secretKey);
        const anyDefault = await tx.backupDestination.count({ where: { isDefault: true } });
        if (body.isDefault || anyDefault === 0) await setDefault(tx, r.id, true);
        await audit(tx, { category: "config", action: "integration.storage.create", verb: "added storage destination", targetType: "storage", targetId: r.id, targetLabel: body.name, ...who(actor, req) });
        return tx.integration.findUniqueOrThrow({ where: { id: r.id } });
      });
      return storageView(ctx.db, row);
    },

    "integrations.storage.patch": async ({ params, body, actor, req, ctx }) => {
      const row = await ctx.db.integration.findFirst({ where: { id: params.id, kind: "storage" } });
      if (!row) throw notFound();
      const c = configOf<StorageConfig>(row);
      const provider = body.provider ?? c.provider;
      const next = { provider, endpoint: body.endpoint ?? c.endpoint, bucket: body.bucket ?? c.bucket, region: regionFor(provider, body.region ?? c.region) };
      const connChanged = next.endpoint !== c.endpoint || next.bucket !== c.bucket || next.region !== c.region || !!body.accessKey || !!body.secretKey;
      // Stored keys only sign for the endpoint they were saved for, here on the test and later on every backup.
      if (next.endpoint !== c.endpoint && !(body.accessKey && body.secretKey)) {
        throw new HttpError(400, "Enter both keys again: stored keys only go to the endpoint they were saved for.", "INVALID_REQUEST", { field: body.accessKey ? "secretKey" : "accessKey" });
      }
      if (connChanged) {
        const cur = await targetOf(ctx.db, ctx.ring, row);
        await testS3(deps.http, { ...next, accessKey: body.accessKey || cur.accessKey, secretKey: body.secretKey || cur.secretKey });
      }
      const updated = await ctx.db.$transaction(async (tx) => {
        try {
          await tx.integration.update({
            where: { id: row.id },
            data: { ...(body.name ? { name: body.name } : {}), config: asJson(next), ...(connChanged ? { status: "connected", error: null, lastCheckedAt: new Date() } : {}) },
          });
          if (body.name) await tx.backupDestination.update({ where: { integrationId: row.id }, data: { name: body.name } });
        } catch (e) {
          if (isUniqueViolation(e)) throw new HttpError(409, "A destination with that name exists", "DUPLICATE", { field: "name" });
          throw e;
        }
        if (body.accessKey) await replaceSecret(tx, ctx.ring, row, "primary", "integration_token", body.accessKey);
        if (body.secretKey) {
          const fresh = await tx.integration.findUniqueOrThrow({ where: { id: row.id } });
          await replaceSecret(tx, ctx.ring, fresh, "second", "storage_secret_key", body.secretKey);
        }
        if (body.isDefault !== undefined) await setDefault(tx, row.id, body.isDefault);
        await audit(tx, { category: "config", action: "integration.storage.patch", verb: "changed storage destination", targetType: "storage", targetId: row.id, targetLabel: body.name ?? row.name, ...who(actor, req) });
        return tx.integration.findUniqueOrThrow({ where: { id: row.id } });
      });
      return storageView(ctx.db, updated);
    },

    "integrations.storage.delete": async ({ params, actor, req, ctx }) => {
      await ctx.db.$transaction(async (tx) => {
        const row = await tx.integration.findFirst({ where: { id: params.id, kind: "storage" } });
        if (!row) throw notFound();
        const dest = await tx.backupDestination.findUnique({ where: { integrationId: row.id }, select: { id: true, _count: { select: { backups: true, apps: true } } } });
        if (dest && (dest._count.backups > 0 || dest._count.apps > 0)) {
          throw new HttpError(409, "Backups or apps still use this destination; move them first", "IN_USE");
        }
        if (dest) await tx.backupDestination.delete({ where: { id: dest.id } });
        await tx.integration.delete({ where: { id: row.id } });
        const ids = [row.secretId, row.secondSecretId].filter((x): x is string => !!x);
        if (ids.length) await tx.secret.deleteMany({ where: { id: { in: ids } } });
        await audit(tx, { category: "config", action: "integration.storage.delete", verb: "removed storage destination", targetType: "storage", targetId: row.id, targetLabel: row.name, ...who(actor, req) });
      });
      return undefined;
    },

    "integrations.storage.test": async ({ params, ctx }) => {
      const row = await ctx.db.integration.findFirst({ where: { id: params.id, kind: "storage" } });
      if (!row) throw notFound();
      try {
        const r = await testS3(deps.http, await targetOf(ctx.db, ctx.ring, row));
        await ctx.db.integration.update({ where: { id: row.id }, data: { status: "connected", error: null, lastCheckedAt: new Date() } });
        return r;
      } catch (e) {
        if (e instanceof HttpError) await ctx.db.integration.update({ where: { id: row.id }, data: { status: "error", error: e.message } });
        throw e;
      }
    },
  };
}
