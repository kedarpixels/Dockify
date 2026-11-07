/**
 * Where encrypted dumps live: an S3-compatible bucket (R2, S3, MinIO, custom) or this server's own
 * disk, unless the owner turned that off. Both behind one small interface so the backup and
 * restore pipelines never care which.
 *
 * The S3 client is hand-written SigV4 over fetch, ported from the old worker: four calls and one
 * signing algorithm do not justify an SDK and its dependency tree. Path-style addressing, because a
 * self-hosted MinIO has one hostname and cannot vhost per bucket, and every provider accepts it.
 * Every request refuses redirects (a redirect would carry the signed request somewhere it was not
 * signed for), and the endpoint host passes the outbound guard at call time, not only at save time.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface ObjectStore {
  readonly kind: "s3" | "local";
  put(key: string, body: Readable, length: number): Promise<void>;
  get(key: string): Promise<Readable>;
  /** Idempotent: an object already gone is success. */
  delete(key: string): Promise<void>;
  /** What a delete of this key would really free, when the store can tell without a round trip. */
  sizeOf?(key: string): Promise<number>;
  /** Writes and deletes a probe object: write access is what backups need, so it is what is proven. */
  probe(): Promise<number>;
}

export class StoreError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "StoreError";
    this.status = status;
  }
}

/** Object keys: what Dockify generates, nothing a caller could turn into a path escape. */
const KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,500}$/;
export function assertKey(key: string): void {
  if (!KEY.test(key) || key.split("/").some((p) => p === "" || p === "." || p === "..")) {
    throw new StoreError(`object key ${key} is not allowed`, 400);
  }
}

/** `<prefix>apps/<sourceAppId>/<stamp>-<backupId>.<ext>.dkbk`. Grouped per app so orphans stay findable. */
export function backupObjectKey(prefix: string, a: { sourceAppId: string; backupId: string; createdAt: Date; kind: string }): string {
  const stamp = a.createdAt.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const ext = a.kind === "postgres" ? "sql.gz" : a.kind === "redis" ? "rdb.gz" : "tar.gz";
  const p = prefix.replace(/^\/+/, "");
  const key = `${p}${p && !p.endsWith("/") ? "/" : ""}apps/${a.sourceAppId}/${stamp}-${a.backupId}.${ext}.dkbk`;
  assertKey(key);
  return key;
}

// ------------------------------------------------------------------------------------------ S3

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export type FetchLike = (url: string, init: RequestInit & { duplex?: "half" }) => Promise<Response>;
/** Resolves the host and throws when it is not a public address (the shared SSRF rule). */
export type OutboundGuard = (hostname: string) => Promise<void>;

const ALGORITHM = "AWS4-HMAC-SHA256";
const UNSIGNED = "UNSIGNED-PAYLOAD";
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const TRANSFER_TIMEOUT_MS = 60 * 60_000;
const CONTROL_TIMEOUT_MS = 20_000;

const sha256hex = (d: string | Buffer) => createHash("sha256").update(d).digest("hex");
const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d, "utf8").digest();

function uriEncode(input: string, encodeSlash: boolean): string {
  let out = "";
  for (const ch of input) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else if (ch === "/") out += encodeSlash ? "%2F" : "/";
    else for (const b of Buffer.from(ch, "utf8")) out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/** SigV4 for one path-style object request. Exported for the signing test. */
export function signRequest(cfg: S3Config, method: string, key: string, payloadHash: string, now: Date, extra: Record<string, string> = {}): SignedRequest {
  const base = new URL(cfg.endpoint);
  if (base.protocol !== "https:") throw new StoreError("storage endpoints must be https", 400);
  const uri = `/${uriEncode(cfg.bucket, true)}/${uriEncode(key, false)}`;
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${cfg.region}/s3/aws4_request`;
  const signed: Record<string, string> = { host: base.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const names = Object.keys(signed).sort();
  const canonical = [method, uri, "", names.map((n) => `${n}:${signed[n]}\n`).join(""), names.join(";"), payloadHash].join("\n");
  const toSign = [ALGORITHM, amzDate, scope, sha256hex(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, day), cfg.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign, "utf8").digest("hex");
  return {
    url: `${base.origin}${uri}`,
    headers: { ...extra, ...signed, authorization: `${ALGORITHM} Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` },
  };
}

function s3Message(status: number, body: string): string {
  const code = /<Code>([^<]{1,100})<\/Code>/.exec(body)?.[1];
  const msg = /<Message>([^<]{1,300})<\/Message>/.exec(body)?.[1];
  return code || msg ? [code, msg].filter(Boolean).join(": ") : `the storage endpoint answered HTTP ${status}`;
}

export class S3Store implements ObjectStore {
  readonly kind = "s3" as const;
  #cfg: S3Config;
  #fetch: FetchLike;
  #guard: OutboundGuard;
  #now: () => Date;

  constructor(cfg: S3Config, opts: { fetch?: FetchLike; guard: OutboundGuard; now?: () => Date }) {
    this.#cfg = cfg;
    this.#fetch = opts.fetch ?? (fetch as FetchLike);
    this.#guard = opts.guard;
    this.#now = opts.now ?? (() => new Date());
  }

  async #send(method: string, key: string, init: { body?: NonNullable<RequestInit["body"]>; hash: string; headers?: Record<string, string>; timeoutMs: number }): Promise<Response> {
    assertKey(key);
    await this.#guard(new URL(this.#cfg.endpoint).hostname);
    const req = signRequest(this.#cfg, method, key, init.hash, this.#now(), init.headers);
    let res: Response;
    try {
      res = await this.#fetch(req.url, {
        method,
        headers: req.headers,
        ...(init.body !== undefined ? { body: init.body, duplex: "half" as const } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(init.timeoutMs),
      });
    } catch (e) {
      throw new StoreError(`could not reach the storage endpoint: ${e instanceof Error ? e.message : String(e)}`, 0);
    }
    return res;
  }

  async put(key: string, body: Readable, length: number): Promise<void> {
    const res = await this.#send("PUT", key, {
      body: Readable.toWeb(body) as unknown as NonNullable<RequestInit["body"]>,
      hash: UNSIGNED,
      headers: { "content-type": "application/octet-stream", "content-length": String(length) },
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });
    if (!res.ok) throw new StoreError(s3Message(res.status, await res.text().catch(() => "")), res.status);
    await res.body?.cancel().catch(() => {});
  }

  async get(key: string): Promise<Readable> {
    const res = await this.#send("GET", key, { hash: EMPTY_SHA256, timeoutMs: TRANSFER_TIMEOUT_MS });
    if (!res.ok || !res.body) throw new StoreError(s3Message(res.status, await res.text().catch(() => "")), res.status);
    return Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  }

  async delete(key: string): Promise<void> {
    const res = await this.#send("DELETE", key, { hash: EMPTY_SHA256, timeoutMs: CONTROL_TIMEOUT_MS });
    if (!res.ok && res.status !== 404) throw new StoreError(s3Message(res.status, await res.text().catch(() => "")), res.status);
    await res.body?.cancel().catch(() => {});
  }

  async probe(): Promise<number> {
    const started = Date.now();
    const key = `dockify/.probe/${randomBytes(12).toString("hex")}`;
    const body = Buffer.from(`dockify probe ${this.#now().toISOString()}\n`);
    const res = await this.#send("PUT", key, {
      body,
      hash: sha256hex(body),
      headers: { "content-type": "text/plain", "content-length": String(body.length) },
      timeoutMs: CONTROL_TIMEOUT_MS,
    });
    if (!res.ok) throw new StoreError(s3Message(res.status, await res.text().catch(() => "")), res.status);
    await res.body?.cancel().catch(() => {});
    await this.delete(key).catch(() => {});
    return Date.now() - started;
  }
}

// --------------------------------------------------------------------------------------- local

/**
 * The server's own disk (the dockify-backups volume). On by default, so a fresh install has
 * working backups, manual and scheduled alike, before any bucket is added: a copy on the same disk
 * beats no copy. It is not off the server and dies with the disk, which the API (LOCAL_WARNING)
 * and the dashboard say wherever such a backup or schedule is listed; retention bounds the space it
 * takes. DOCKIFY_ALLOW_LOCAL_BACKUPS=0 turns it off for owners who want S3 only.
 */
export const LOCAL_FLAG = "DOCKIFY_ALLOW_LOCAL_BACKUPS";
export const localBackupsAllowed = (env: NodeJS.ProcessEnv = process.env): boolean => (env[LOCAL_FLAG] ?? "").trim() !== "0";
export const LOCAL_WARNING =
  "Stored on this server's own disk, not off the server: a failed disk or a lost server takes these backups with it. Add S3 compatible storage in Settings, Integrations to keep copies elsewhere.";

export class LocalStore implements ObjectStore {
  readonly kind = "local" as const;
  #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  #path(key: string): string {
    assertKey(key);
    const p = resolve(join(this.#root, key));
    if (!p.startsWith(this.#root + sep)) throw new StoreError(`object key ${key} escapes the backup directory`, 400);
    return p;
  }

  async put(key: string, body: Readable, length: number): Promise<void> {
    const p = this.#path(key);
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.part-${randomBytes(6).toString("hex")}`;
    try {
      await pipeline(body, createWriteStream(tmp, { mode: 0o600, flags: "wx" }));
      const size = (await stat(tmp)).size;
      if (size !== length) throw new StoreError(`wrote ${size} bytes, expected ${length}`, 0);
      await rename(tmp, p);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  async get(key: string): Promise<Readable> {
    const p = this.#path(key);
    await stat(p).catch(() => {
      throw new StoreError("the backup file is missing from local storage", 404);
    });
    return createReadStream(p);
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }

  /** Zero for a file that is not there: deleting it frees nothing. */
  async sizeOf(key: string): Promise<number> {
    return stat(this.#path(key)).then((s) => s.size, () => 0);
  }

  async probe(): Promise<number> {
    const started = Date.now();
    const key = `dockify-probe/${randomBytes(8).toString("hex")}`;
    const body = Buffer.from("probe\n");
    await this.put(key, Readable.from([body]), body.length);
    await this.delete(key);
    return Date.now() - started;
  }
}
