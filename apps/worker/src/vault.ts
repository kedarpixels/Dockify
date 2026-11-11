/**
 * The worker holds no master key: every plaintext secret comes from the api's internal routes, which check the
 * named job is live and audit the call. Timers name themselves ("timer:janitor") so the audit row says why.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { readSecret, type Sealed } from "@dockify/crypto";
import type { SecretOwner, SecretVault } from "@dockify/db";

export interface JobContext {
  jobId: string | null;
  /** The job kind, or "timer:<name>". */
  purpose: string;
}

export const jobContext = new AsyncLocalStorage<JobContext>();

export class VaultError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, message: string, code: string) {
    super(message);
    this.name = "VaultError";
    this.status = status;
    this.code = code;
  }
}

export interface RemoteVaultOptions {
  /** The api's control-network address, for example http://api:3001. */
  apiUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  context?: () => JobContext | undefined;
}

export function readInternalToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = readSecret("DOCKIFY_INTERNAL_TOKEN", env);
  if (!token) throw new Error("DOCKIFY_INTERNAL_TOKEN is not set; the worker needs it to reach the api's secret-opening routes");
  return token;
}

export function readApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DOCKIFY_API_INTERNAL_URL?.trim();
  if (!raw) throw new Error("DOCKIFY_API_INTERNAL_URL is not set (for example http://api:3001)");
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("DOCKIFY_API_INTERNAL_URL must be http or https");
  return u.origin;
}

interface SealedWire {
  kekId: string;
  wrappedDek: string;
  dekNonce: string;
  ciphertext: string;
  ctNonce: string;
}

/** The api did not answer, or could not: its secrets may open again in a moment. A refusal is something else. */
export const isVaultDown = (e: unknown): boolean => e instanceof VaultError && (e.code === "VAULT_UNREACHABLE" || e.status >= 500);

export function createRemoteVault(opts: RemoteVaultOptions): SecretVault {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.apiUrl.replace(/\/+$/, "");
  const context = opts.context ?? (() => jobContext.getStore());

  async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const c = context() ?? { jobId: null, purpose: "worker" };
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
        body: JSON.stringify({ ...body, context: { jobId: c.jobId, purpose: c.purpose } }),
        redirect: "error",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new VaultError(503, `the api did not answer the secrets call: ${(e as Error).message}`, "VAULT_UNREACHABLE");
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new VaultError(res.status, typeof json.error === "string" ? json.error : `secrets call answered ${res.status}`, typeof json.code === "string" ? json.code : "VAULT_ERROR");
    return json as T;
  }

  return {
    async open(_tx, ids) {
      const out = new Map<string, string | null>();
      if (!ids.length) return out;
      const r = await call<{ values: Record<string, string | null> }>("/internal/secrets/open", { ids });
      for (const id of ids) out.set(id, r.values[id] ?? null);
      return out;
    },
    async seal(owner: SecretOwner & { id: string }, value: string): Promise<Sealed> {
      const s = await call<SealedWire>("/internal/secrets/seal", { id: owner.id, kind: owner.kind, ownerType: owner.ownerType, ownerId: owner.ownerId, value });
      return {
        kekId: s.kekId,
        wrappedDek: Buffer.from(s.wrappedDek, "base64"),
        dekNonce: Buffer.from(s.dekNonce, "base64"),
        ciphertext: Buffer.from(s.ciphertext, "base64"),
        ctNonce: Buffer.from(s.ctNonce, "base64"),
      };
    },
    async escrow(_tx, id) {
      const r = await call<{ text: string }>("/internal/secrets/escrow", { id });
      return r.text;
    },
  };
}
