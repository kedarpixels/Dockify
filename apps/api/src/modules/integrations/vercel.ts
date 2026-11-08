/**
 * Vercel: token check, teams, projects, importing a Vercel project's env and domains into a Dockify
 * environment, the deployment webhook and the app's logs. The frontend deploy target (sync env,
 * trigger a deploy, read its status) runs in the worker as vercel_sync jobs and the deployment mirror
 * as vercel_mirror jobs; enqueueVercelSync and enqueueVercelMirror below are the api side of them.
 *
 * Row: integrations kind vercel, name "default". config { username, name, team: {id,name,slug}|null,
 * webhook: {id,url,projectIds,registeredAt,state,reason}|null, mirror: {triedAt,syncedAt,error}|null,
 * apps: per-app sync state }, secretId the token (integration_token), secondSecretId the secret Vercel
 * signs its webhook deliveries with (vercel_webhook_secret).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { Hostname, isPublicBuildKey } from "@dockify/contracts";
import type { Db, Tx } from "@dockify/db";
import type { Keyring } from "@dockify/crypto";
import type { Handlers } from "../../app.ts";
import { assertProjectScope, type Actor } from "../../actor.ts";
import { audit } from "../../audit.ts";
import { forbidden, HttpError, stepUpRequired } from "../../errors.ts";
import { createReauthorizer } from "../../reauth.ts";
import { enforce } from "../../actor.ts";
import { POLICIES } from "../../policy.ts";
import { enqueueTx } from "@dockify/db";
import { retentionNote, streamRuntimeLog, tailRuntime, viewerLeft } from "./vercel-logs.ts";
import { withLogReadSlot } from "../deployments/handlers.ts";
import { IN_FLIGHT } from "../deployments/mapping.ts";
import { enqueueEdge, usableHostname } from "../domains/handlers.ts";
import { isReserved, jobsForCreate, normalizeHost, reservedHosts, ROUTABLE_KINDS } from "../domains/logic.ts";
import { EnvPlanError, entryId, type Entry, type ResolvedChange } from "../projects/env-model.ts";
import { applyChanges, loadEntries, loadScope } from "../projects/env-store.ts";
import { dangerousGate, dangerousIn } from "../projects/handlers.ts";
import { requireActor, requireSession, who, type IntegrationDeps } from "./deps.ts";
import { jsonOf, outboundUrlProblem, type HttpClient } from "@dockify/net-guard";
import { asJson, configOf, dropIntegration, findIntegration, hintOfSecret, openSecret, replaceSecret, requireIntegration } from "./store.ts";

export const VERCEL_API = "https://api.vercel.com";

export type VercelTarget = "production" | "preview" | "development";

interface VercelWebhookRecord {
  id: string | null;
  url: string | null;
  projectIds: string[];
  registeredAt: string | null;
  state: "active" | "unavailable";
  reason: string | null;
}

interface VercelConfig {
  username: string;
  name: string | null;
  team: { id: string; name: string; slug: string } | null;
  webhook?: VercelWebhookRecord | null;
  mirror?: { triedAt?: string | null; syncedAt?: string | null; error?: string | null } | null;
  [k: string]: unknown;
}

/**
 * Vercel's event for a deleted deployment. It fires when the deployment is removed for good, after
 * the recovery period; the mirror's own pass notices a deletion sooner, by Vercel answering 404.
 */
export const DELETED_EVENT = "deployment.cleanup";
/** The deployment events the mirror cares about; each only ever queues a sync. */
export const WEBHOOK_EVENTS = ["deployment.created", "deployment.succeeded", "deployment.ready", "deployment.error", "deployment.canceled", "deployment.promoted", "deployment.rollback", DELETED_EVENT];
/** A deployment event's body is small. Past this it is not one of Vercel's, or not worth reading. */
export const VERCEL_WEBHOOK_MAX_BYTES = 256 * 1024;
/** Vercel retries a delivery for up to 24 hours, so a signed body older than this is a replay. */
const WEBHOOK_MAX_AGE_MS = 25 * 3600_000;

export class VercelApi {
  private readonly http: HttpClient;
  private readonly token: string;
  private readonly teamId: string | null;
  constructor(http: HttpClient, token: string, teamId: string | null) {
    this.http = http;
    this.token = token;
    this.teamId = teamId;
  }

  private url(path: string, team = true): string {
    if (!team || !this.teamId) return `${VERCEL_API}${path}`;
    return `${VERCEL_API}${path}${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(this.teamId)}`;
  }

  async call<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, team = true): Promise<T> {
    const send = () =>
      this.http({
        method,
        url: this.url(path, team),
        headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    let res = await send();
    // A read Vercel asks to slow down is tried once more after a short wait; a longer wait is the caller's answer.
    if (res.status === 429 && method === "GET") {
      const wait = vercelRetryAfter(res.headers);
      if (wait <= INLINE_RETRY_S) {
        await new Promise((r) => setTimeout(r, Math.max(250, wait * 1000)));
        res = await send();
      }
    }
    if (res.status === 429) throw vercelRateLimited(vercelRetryAfter(res.headers));
    if (res.status === 401 || res.status === 403) throw new HttpError(400, "Vercel refused this token", "VERCEL_TOKEN");
    if (res.status === 404) throw new HttpError(404, "Vercel could not find that", "NOT_FOUND");
    if (res.status < 200 || res.status >= 300) throw new HttpError(502, `Vercel returned ${res.status}`, "UPSTREAM");
    const out = jsonOf<T>(res);
    if (out === null) throw new HttpError(502, "Vercel sent a body that is not JSON", "UPSTREAM");
    return out;
  }

  async account() {
    const u = await this.call<{ user: { username: string; name?: string | null } }>("GET", "/v2/user", undefined, false);
    return { username: u.user.username, name: u.user.name ?? null };
  }

  async teams() {
    const t = await this.call<{ teams: Array<{ id: string; name: string; slug: string }> }>("GET", "/v2/teams?limit=100", undefined, false);
    return t.teams.map((x) => ({ id: x.id, name: x.name ?? x.slug, slug: x.slug }));
  }

  async projects(limit = 50) {
    const p = await this.call<{ projects: Array<{ id: string; name: string; framework: string | null; updatedAt: number }> }>("GET", `/v9/projects?limit=${limit}`);
    return p.projects;
  }

  async envs(projectId: string) {
    const e = await this.call<{ envs: Array<{ id: string; key: string; target?: string[] | string; type: string }> }>("GET", `/v10/projects/${encodeURIComponent(projectId)}/env`);
    return e.envs.map((x) => ({ ...x, target: normaliseTargets(x.target) }));
  }

  async envValue(projectId: string, envId: string): Promise<string | null> {
    const e = await this.call<{ value?: string; type?: string }>("GET", `/v1/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}`);
    return typeof e.value === "string" ? e.value : null;
  }

  async domains(projectId: string) {
    const d = await this.call<{ domains: Array<{ name: string; redirect?: string | null }> }>("GET", `/v9/projects/${encodeURIComponent(projectId)}/domains?limit=100`);
    return d.domains;
  }

  /**
   * Registers an account webhook. A refusal that is about the plan or the address is an answer, not
   * an error: the mirror polls instead, and the card says why. The token being refused is an error.
   */
  async createWebhook(url: string, projectIds: string[]): Promise<{ ok: true; id: string; secret: string } | { ok: false; reason: string }> {
    const res = await this.http({
      method: "POST",
      url: this.url("/v1/webhooks"),
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, events: WEBHOOK_EVENTS, projectIds }),
    });
    const out = jsonOf<{ id?: unknown; secret?: unknown; error?: { message?: unknown } }>(res);
    if (res.status >= 200 && res.status < 300) {
      if (typeof out?.id !== "string" || typeof out.secret !== "string" || !out.secret) throw new HttpError(502, "Vercel sent no webhook secret", "UPSTREAM");
      return { ok: true, id: out.id, secret: out.secret };
    }
    if (res.status === 401) throw new HttpError(400, "Vercel refused this token", "VERCEL_TOKEN");
    if (res.status === 429 || res.status >= 500) throw new HttpError(502, `Vercel returned ${res.status}`, "UPSTREAM");
    const said = typeof out?.error?.message === "string" ? out.error.message.replace(/\s+/g, " ").slice(0, 200) : null;
    return { ok: false, reason: res.status === 402 || res.status === 403 ? (said ?? "Vercel only offers account webhooks on Pro and Enterprise plans, or this token may not create them") : (said ?? `Vercel answered ${res.status}`) };
  }

  /** Removes a webhook. One that is already gone counts as removed. */
  async deleteWebhook(id: string): Promise<void> {
    const res = await this.http({ method: "DELETE", url: this.url(`/v1/webhooks/${encodeURIComponent(id)}`), headers: { Authorization: `Bearer ${this.token}` } });
    if (res.status === 404 || res.status === 410 || (res.status >= 200 && res.status < 300)) return;
    if (res.status === 401 || res.status === 403) throw new HttpError(400, "Vercel refused this token", "VERCEL_TOKEN");
    throw new HttpError(502, `Vercel returned ${res.status}`, "UPSTREAM");
  }

  /** Stops a build in progress. Vercel answers 400 once it has already finished. */
  async cancelDeployment(id: string): Promise<void> {
    const res = await this.http({ method: "PATCH", url: this.url(`/v12/deployments/${encodeURIComponent(id)}/cancel`), headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" } });
    if (res.status >= 200 && res.status < 300) return;
    if (res.status === 400) throw new HttpError(409, "This deployment already finished on Vercel", "ALREADY_FINISHED");
    if (res.status === 401 || res.status === 403) throw new HttpError(400, "Vercel refused this token", "VERCEL_TOKEN");
    if (res.status === 404) throw new HttpError(404, "Vercel could not find that", "NOT_FOUND");
    throw new HttpError(502, `Vercel returned ${res.status}`, "UPSTREAM");
  }
}

/** The longest wait a read sits out by itself before trying Vercel once more. */
const INLINE_RETRY_S = 2;

/**
 * Seconds until Vercel takes this token's calls again: Retry-After when it sends one, else its
 * X-RateLimit-Reset (epoch seconds). Bounded, and a minute when it says neither.
 */
export function vercelRetryAfter(headers: Record<string, string | string[] | undefined>, now = Date.now()): number {
  const one = (h: string) => {
    const v = headers[h];
    return typeof v === "string" ? v.trim() : Array.isArray(v) ? (v[0]?.trim() ?? "") : "";
  };
  const ra = one("retry-after");
  let s = /^\d+$/.test(ra) ? Number(ra) : ra && !Number.isNaN(Date.parse(ra)) ? Math.ceil((Date.parse(ra) - now) / 1000) : NaN;
  if (!Number.isFinite(s)) {
    const reset = one("x-ratelimit-reset");
    s = /^\d+$/.test(reset) ? Math.ceil(Number(reset) - now / 1000) : NaN;
  }
  return Number.isFinite(s) ? Math.min(3600, Math.max(0, s)) : 60;
}

/** Vercel's 429, as Dockify answers it: a clear sentence and when to try again. */
export function vercelRateLimited(retryAfter: number): HttpError {
  const wait = Math.max(1, retryAfter);
  const when = wait < 90 ? `${wait} second${wait === 1 ? "" : "s"}` : `${Math.ceil(wait / 60)} minutes`;
  return new HttpError(429, `Vercel is limiting requests from this token. Try again in ${when}.`, "VERCEL_RATE_LIMITED", { retryAfter: wait });
}

export function normaliseTargets(t: string[] | string | undefined): VercelTarget[] {
  const list = Array.isArray(t) ? t : typeof t === "string" ? [t] : [];
  return list.filter((x): x is VercelTarget => x === "production" || x === "preview" || x === "development");
}

/** Which Vercel variables an import takes: the chosen target, readable, a valid Dockify key, not Vercel's own. */
export function importableEnv<T extends { key: string; target: VercelTarget[]; type: string }>(envs: T[], target: VercelTarget): T[] {
  const seen = new Set<string>();
  return envs.filter((e) => {
    if (!e.target.includes(target) || e.type === "sensitive" || e.type === "system") return false;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(e.key) || e.key.startsWith("VERCEL_")) return false;
    // Reserved keys are Dockify's to set (DOCKIFY_*, PORT); never take them from a third party.
    if (/^(?:DOCKIFY_|PORT$)/.test(e.key)) return false;
    if (seen.has(e.key)) return false;
    seen.add(e.key);
    return true;
  });
}

/** Domains worth importing: not the *.vercel.app ones, not redirects. */
export function importableDomains(domains: Array<{ name: string; redirect?: string | null }>): string[] {
  return domains.filter((d) => !d.redirect && !d.name.endsWith(".vercel.app")).map((d) => d.name.toLowerCase());
}

/**
 * The env changes an import makes, as the versioned env store applies them. A new key is added as
 * a secret, or plain for a browser-facing name; an existing key keeps its secret flag and target and only gets the Vercel value; a key
 * whose value already matches is left out, so an import that changes nothing writes no version.
 */
export function importChanges(
  values: Array<{ key: string; value: string }>,
  stored: ReadonlyMap<string, Pick<Entry, "value">>,
  env: { id: string; name: string },
): ResolvedChange[] {
  const out: ResolvedChange[] = [];
  for (const { key, value } of values) {
    const before = stored.get(entryId("environment", env.id, key));
    if (before && before.value === value) continue;
    out.push(before
      ? { scope: "environment", scopeId: env.id, environment: env.name, key, op: "change", value }
      // A browser-facing name is public and has to reach the build as an ARG, which a secret never does.
      : isPublicBuildKey(key)
        ? { scope: "environment", scopeId: env.id, environment: env.name, key, op: "add", value, secret: false, target: "both" }
        : { scope: "environment", scopeId: env.id, environment: env.name, key, op: "add", value, secret: true });
  }
  return out;
}

/** Imported values are secrets: the same rule as every other secret write (step-up, no tokens). */
export const importGate = (a: Actor) => (touchesSecret: boolean): void => {
  if (!touchesSecret) return;
  if (a.kind === "token") throw forbidden("API tokens cannot change secrets");
  if (!a.elevated) throw stepUpRequired();
};

/** Hostnames an import may add: valid, not reserved (the dashboard and DOCKIFY_RESERVED_HOSTS), once each. */
export function importableHosts(hosts: string[], reserved: Set<string>): string[] {
  const out = new Set<string>();
  for (const h of hosts) {
    const host = normalizeHost(h);
    if (!host || isReserved(host, reserved) || !Hostname.safeParse(host).success) continue;
    out.add(host);
  }
  return [...out];
}

export async function vercelApiFor(db: Tx, ring: Keyring, http: HttpClient): Promise<VercelApi> {
  const row = await requireIntegration(db, "vercel", "default", "Vercel");
  const token = await openSecret(db, ring, row);
  if (!token) throw new HttpError(409, "Vercel is not connected", "NOT_CONNECTED");
  return new VercelApi(http, token, configOf<VercelConfig>(row).team?.id ?? null);
}

/** The Vercel projects at least one app is linked to. */
export async function linkedProjects(db: Tx): Promise<string[]> {
  const apps = await db.app.findMany({ where: { deployTarget: "vercel", vercelProjectId: { not: null } }, select: { vercelProjectId: true } });
  return [...new Set(apps.map((a) => a.vercelProjectId!))];
}

/** The contract's webhook state. Projects linked since the last registration are not covered yet. */
export function webhookState(w: VercelWebhookRecord | null | undefined, linked: readonly string[]) {
  if (!w) return { state: "off" as const, projects: 0, missingProjects: 0, registeredAt: null, reason: null };
  if (w.state !== "active") return { state: "unavailable" as const, projects: 0, missingProjects: 0, registeredAt: null, reason: w.reason };
  const covered = new Set(w.projectIds);
  return { state: "active" as const, projects: linked.filter((p) => covered.has(p)).length, missingProjects: linked.filter((p) => !covered.has(p)).length, registeredAt: w.registeredAt, reason: null };
}

/** What the card says once Vercel refuses the stored token. */
export const TOKEN_DEAD = "Vercel no longer accepts the stored token. Connect again with a new token; your links and deployments stay.";
/** The mirror's words for a refused token (worker/integrations/vercel-mirror.ts). */
const tokenRefused = (e: string | null | undefined) => typeof e === "string" && /refused the stored token/i.test(e);

export async function vercelView(db: Tx) {
  const row = await findIntegration(db, "vercel");
  if (!row || row.status === "disconnected") return null;
  const c = configOf<VercelConfig>(row);
  const linked = await linkedProjects(db);
  return {
    account: { username: c.username ?? "", name: c.name ?? null },
    team: c.team ?? null,
    tokenHint: await hintOfSecret(db, row.secretId),
    connectedAt: row.createdAt.toISOString(),
    // The mirror is what notices first when Vercel stops taking the token; the card then asks for a new one.
    error: row.error ?? (tokenRefused(c.mirror?.error) ? TOKEN_DEAD : null),
    webhook: webhookState(c.webhook, linked),
    mirror: { syncedAt: c.mirror?.syncedAt ?? null, error: c.mirror?.error ?? null, projects: linked.length },
  };
}

/** Writes part of the config under the lock the worker's writes take, so neither loses the other's. */
async function patchConfig(tx: Tx, id: string, patch: Partial<VercelConfig>): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dockify.integration.vercel'))`;
  const row = await tx.integration.findUnique({ where: { id }, select: { config: true } });
  await tx.integration.update({ where: { id }, data: { config: asJson({ ...configOf(row ?? { config: null }), ...patch }) } });
}

/**
 * Queues a mirror pass: one project, or every linked one. An open pass for the same scope covers it.
 * A deployment Vercel said it deleted gets a pass of its own that asks about that id, since the
 * scope's open pass may have read the list before the deletion.
 */
export async function enqueueVercelMirror(db: Db, projectId: string | null, deletedId: string | null = null): Promise<void> {
  const payload = projectId ? { projectId, ...(deletedId ? { deploymentId: deletedId } : {}) } : {};
  const key = `vercel_mirror:${projectId ?? "all"}${projectId && deletedId ? `:deleted:${deletedId}` : ""}`;
  await db.$transaction(async (tx) => {
    await enqueueTx(tx, { kind: "vercel_mirror", lane: "maintenance", payload, dedupeKey: key, maxAttempts: 3 });
  });
}

/** Vercel's signature: the hex HMAC-SHA1 of the raw body. Compared in constant time. */
export function verifyVercelSignature(secret: string, payload: Buffer, header: unknown): boolean {
  if (typeof header !== "string" || !/^[0-9a-f]{40}$/.test(header)) return false;
  const expected = createHmac("sha1", secret).update(payload).digest("hex");
  return timingSafeEqual(Buffer.from(header, "utf8"), Buffer.from(expected, "utf8"));
}

/**
 * One delivery, already raw. Answers 202 for anything correctly signed, so Vercel does not retry what
 * Dockify chose to ignore. Its only effect is a mirror pass for a linked project, which reads Vercel
 * itself: nothing in the body is ever stored or believed beyond naming that project, so a replay or
 * a forged id can at worst cause one more read. No signing secret means no webhook: 404.
 */
export async function receiveVercelWebhook(db: Db, ring: Keyring, req: FastifyRequest, raw: unknown, now = Date.now()): Promise<{ status: number; error?: { error: string; code: string } }> {
  const row = await findIntegration(db, "vercel");
  if (!row?.secondSecretId || row.status === "disconnected") return { status: 404, error: { error: "No Vercel webhook is registered", code: "NOT_CONNECTED" } };
  if (!Buffer.isBuffer(raw)) return { status: 400, error: { error: "Expected a raw request body", code: "BAD_BODY" } };
  const secret = await openSecret(db, ring, row, "second");
  if (!secret || !verifyVercelSignature(secret, raw, req.headers["x-vercel-signature"])) {
    return { status: 401, error: { error: "Signature verification failed", code: "BAD_SIGNATURE" } };
  }
  let event: { id?: unknown; type?: unknown; createdAt?: unknown; payload?: { project?: { id?: unknown } | null; projectId?: unknown; deployment?: { id?: unknown } | null } | null };
  try {
    event = JSON.parse(raw.toString("utf8")) as typeof event;
  } catch {
    return { status: 400, error: { error: "The payload is not valid JSON", code: "BAD_JSON" } };
  }
  const id = event?.id;
  if (typeof id !== "string" || !/^[\w.:-]{1,100}$/.test(id)) return { status: 400, error: { error: "The delivery has no id", code: "NO_DELIVERY_ID" } };
  if (typeof event.createdAt === "number" && now - event.createdAt > WEBHOOK_MAX_AGE_MS) return { status: 202 };
  const type = typeof event.type === "string" ? event.type.slice(0, 64) : "";
  if (!type.startsWith("deployment")) return { status: 202 };

  const started = Date.now();
  // A known id is a repeat: skipped by the insert itself, so no raw unique violation reaches the log.
  const fresh = await db.webhookDelivery.createMany({ data: [{ provider: "vercel", deliveryId: id, event: type }], skipDuplicates: true });
  if (fresh.count !== 1) {
    req.log.info({ deliveryId: id, event: type }, "Vercel sent a delivery already handled; nothing to do");
    return { status: 202 };
  }
  const rowId = (await db.webhookDelivery.findFirstOrThrow({ where: { provider: "vercel", deliveryId: id }, select: { id: true } })).id;
  const named = event.payload?.project?.id ?? event.payload?.projectId;
  const projectId = typeof named === "string" && /^[\w-]{1,128}$/.test(named) ? named : null;
  const app = projectId ? await db.app.findFirst({ where: { deployTarget: "vercel", vercelProjectId: projectId }, select: { environment: { select: { projectId: true } } } }) : null;
  // A deletion names the deployment, so the pass asks Vercel about it by id; it never deletes on this word.
  const dpl = event.payload?.deployment?.id;
  const deletedId = type === DELETED_EVENT && typeof dpl === "string" && /^[\w-]{1,128}$/.test(dpl) ? dpl : null;
  if (app) await enqueueVercelMirror(db, projectId, deletedId);
  await db.webhookDelivery.update({
    where: { id: rowId },
    data: { statusCode: 202, summary: app ? `${type}: ${deletedId ? "removal check" : "mirror"} queued` : `${type}: no linked app`, projectId: app?.environment.projectId ?? null, durationMs: Date.now() - started },
  });
  return { status: 202 };
}

/** The app a Vercel log read is for, and the deployment it reads: the one named, else what it serves. */
async function logTarget(db: Db, appId: string, deployment: string | undefined) {
  const app = await db.app.findUnique({
    where: { id: appId },
    select: { id: true, deployTarget: true, vercelProjectId: true, currentDeploymentId: true, environment: { select: { projectId: true } } },
  });
  if (!app) throw new HttpError(404, "App not found", "NOT_FOUND");
  const select = { id: true, appId: true, provider: true, externalId: true, externalUrl: true, externalTarget: true, createdAt: true } as const;
  let dep;
  if (deployment) {
    dep = await db.deployment.findUnique({ where: { id: deployment }, select });
    if (!dep || dep.appId !== app.id || dep.provider !== "vercel") throw new HttpError(404, "This app has no such Vercel deployment", "NOT_FOUND");
  } else {
    if (app.deployTarget !== "vercel") throw new HttpError(400, "This app does not deploy to Vercel", "NOT_VERCEL_TARGET");
    const current = app.currentDeploymentId ? await db.deployment.findFirst({ where: { id: app.currentDeploymentId, provider: "vercel" }, select }) : null;
    dep = current ?? (await db.deployment.findFirst({ where: { appId: app.id, provider: "vercel", status: "ready", externalId: { not: null } }, orderBy: { createdAt: "desc" }, select }));
  }
  return { app, dep };
}

const logDeployment = (d: { id: string; externalId: string | null; externalUrl: string | null; externalTarget: "production" | "preview" | null; createdAt: Date }) => ({
  id: d.id, externalId: d.externalId ?? "", url: d.externalUrl, target: d.externalTarget, createdAt: d.createdAt.toISOString(),
});

async function currentRetention(db: Tx) {
  const row = await findIntegration(db, "vercel");
  return retentionNote(row ? configOf<VercelConfig>(row).webhook?.state === "active" : false);
}

/** apps.vercel.logs, and apps.logs for an app Vercel hosts. */
export async function vercelRuntimeTail(db: Db, ring: Keyring, appId: string, deployment: string | undefined, tail: number, signal?: AbortSignal) {
  const { app, dep } = await logTarget(db, appId, deployment);
  const fetchedAt = new Date().toISOString();
  const retention = await currentRetention(db);
  const projectId = app.vercelProjectId;
  if (!dep?.externalId || !projectId) return { lines: [], nextCursor: null, deployment: dep?.externalId ? logDeployment(dep) : null, retention, fetchedAt };
  const lines = await tailRuntime(db, ring, { appId: app.id, externalId: dep.externalId, vercelProjectId: projectId, projectId: app.environment.projectId }, tail, signal);
  return { lines, nextCursor: null, deployment: logDeployment(dep), retention, fetchedAt };
}

/** The answer to anything that would change Vercel for an app that only follows its project. */
export const followOnly = (): HttpError =>
  new HttpError(409, "This app only follows its Vercel project, so Dockify changes nothing on Vercel for it. Do this on Vercel, or make Vercel its deploy target in the app's Settings.", "VERCEL_FOLLOW_ONLY");

/**
 * Queues the worker side of the Vercel deploy target for one app. The one way to that job, so it is
 * the one place that refuses a followed app, inside the transaction that would queue it.
 */
export async function enqueueVercelSync(db: Db, appId: string, action: "sync_env" | "deploy" | "status", extra: Record<string, unknown> = {}): Promise<void> {
  const key = `vercel_sync:${appId}:${action}`;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    const app = await tx.app.findUnique({ where: { id: appId }, select: { vercelFollowOnly: true, serverId: true } });
    if (!app) return;
    if (app.vercelFollowOnly) throw followOnly();
    const open = await tx.job.findFirst({ where: { dedupeKey: key, completedAt: null, failedAt: null }, select: { id: true } });
    if (open) return;
    await tx.job.create({ data: { kind: "vercel_sync", lane: "deploy", serverId: app.serverId, dedupeKey: key, payload: asJson({ appId, action, ...extra }) } });
  });
}

/**
 * A Deploy of a Vercel app: its row and its job in one transaction, or a refusal. With a deploy already
 * open a second row would have no job to run it, so nothing could ever cancel it or let the app go.
 */
export async function requestVercelDeploy(db: Db, appId: string, row: { trigger: "api" | "manual"; actorType: "token" | "user"; actorId: string; actorName: string }): Promise<string> {
  const key = `vercel_sync:${appId}:deploy`;
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    const app = await tx.app.findUnique({ where: { id: appId }, select: { vercelFollowOnly: true, serverId: true } });
    if (!app) throw new HttpError(404, "App not found", "NOT_FOUND");
    if (app.vercelFollowOnly) throw followOnly();
    const open = await tx.deployment.findFirst({ where: { appId, provider: "vercel", status: { in: IN_FLIGHT } }, select: { id: true } });
    const job = open ? null : await tx.job.findFirst({ where: { dedupeKey: key, completedAt: null, failedAt: null }, select: { id: true } });
    if (open || job) throw new HttpError(409, "A deployment of this app is already in progress", "DEPLOY_IN_FLIGHT", open ? { deploymentId: open.id } : {});
    const dep = await tx.deployment.create({ data: { appId, serverId: app.serverId, provider: "vercel", status: "queued", ...row }, select: { id: true } });
    await tx.job.create({ data: { kind: "vercel_sync", lane: "deploy", serverId: app.serverId, dedupeKey: key, payload: asJson({ appId, action: "deploy", deploymentId: dep.id }) } });
    return dep.id;
  });
}

export function vercelHandlers(deps: IntegrationDeps): Handlers {
  return {
    "integrations.vercel.connect": async ({ body, actor, req, ctx }) => {
      const api = new VercelApi(deps.http, body.token, body.teamId ?? null);
      const account = await api.account();
      const teams = await api.teams();
      if (body.check) return { account, teams };
      const team = body.teamId ? teams.find((t) => t.id === body.teamId) : null;
      if (body.teamId && !team) throw new HttpError(400, "That team is not visible to this token", "VERCEL_TEAM");
      const config = asJson({ username: account.username, name: account.name, team: team ?? null });
      await ctx.db.$transaction(async (tx) => {
        const existing = await findIntegration(tx, "vercel");
        // Same scope: what the worker and the webhook wrote stays. Another scope starts over: its webhook
        // cannot be reached with this token, so the owner removes it on Vercel (the docs say so).
        const before = existing ? configOf<VercelConfig>(existing) : null;
        const sameScope = (before?.team?.id ?? null) === (team?.id ?? null);
        // A new token answers the old one's refusal: the mirror's error goes with it, so the card stops asking.
        const mirror = before?.mirror ? { ...before.mirror, error: tokenRefused(before.mirror.error) ? null : (before.mirror.error ?? null) } : before?.mirror;
        const merged = before && sameScope ? asJson({ ...before, ...(mirror ? { mirror } : {}), username: account.username, name: account.name, team: team ?? null }) : config;
        if (existing && !sameScope && existing.secondSecretId) {
          await tx.integration.update({ where: { id: existing.id }, data: { secondSecretId: null } });
          await tx.secret.delete({ where: { id: existing.secondSecretId } }).catch(() => undefined);
        }
        const row = existing
          ? await tx.integration.update({ where: { id: existing.id }, data: { config: merged, status: "connected", error: null, lastCheckedAt: new Date() } })
          : await tx.integration.create({ data: { kind: "vercel", name: "default", config, lastCheckedAt: new Date() } });
        await replaceSecret(tx, ctx.ring, row, "primary", "integration_token", body.token);
        await audit(tx, { category: "config", action: "integration.vercel.connect", verb: "connected Vercel", targetType: "integration", targetLabel: team?.name ?? account.username, ...who(actor, req) });
      });
      const view = await vercelView(ctx.db);
      if (!view) throw new HttpError(500, "Vercel row vanished", "INTERNAL");
      return view;
    },

    "integrations.vercel.delete": async ({ actor, req, ctx }) => {
      // The webhook goes first, while the token still works. A failure must not keep the owner from
      // disconnecting; without a signing secret here its deliveries are refused anyway.
      const before = await findIntegration(ctx.db, "vercel");
      const hook = before ? configOf<VercelConfig>(before).webhook?.id : null;
      if (hook) await vercelApiFor(ctx.db, ctx.ring, deps.http).then((api) => api.deleteWebhook(hook)).catch(() => undefined);
      await ctx.db.$transaction(async (tx) => {
        const row = await findIntegration(tx, "vercel");
        if (!row) return;
        // Nothing will read these again, so none may stay in flight forever.
        await tx.deployment.updateMany({
          where: { provider: "vercel", status: { in: ["queued", "building", "deploying", "cancelling"] } },
          data: { status: "cancelled", finishedAt: new Date(), error: "Vercel was disconnected, so Dockify stopped following this deployment" },
        });
        await dropIntegration(tx, row);
        await audit(tx, { category: "config", action: "integration.vercel.delete", verb: "disconnected Vercel", targetType: "integration", ...who(actor, req) });
      });
      return undefined;
    },

    "integrations.vercel.webhook.create": async ({ actor, req, ctx }) => {
      requireSession(actor);
      const row = await requireIntegration(ctx.db, "vercel", "default", "Vercel");
      const before = configOf<VercelConfig>(row).webhook ?? null;
      const linked = await linkedProjects(ctx.db);
      if (!linked.length) throw new HttpError(409, "Link an app to a Vercel project first", "NO_LINKED_PROJECTS");
      const url = new URL("/api/v1/webhooks/vercel", ctx.config.publicUrl.origin).toString();
      const problem = outboundUrlProblem(url);
      const api = await vercelApiFor(ctx.db, ctx.ring, deps.http);
      const made = problem
        ? { ok: false as const, reason: `Vercel can only call a public https address, and this dashboard is at ${ctx.config.publicUrl.origin}` }
        : await api.createWebhook(url, linked);
      if (!made.ok) {
        const record: VercelWebhookRecord = { id: before?.id ?? null, url: before?.url ?? null, projectIds: before?.projectIds ?? [], registeredAt: before?.registeredAt ?? null, state: before?.id ? "active" : "unavailable", reason: made.reason };
        await ctx.db.$transaction(async (tx) => {
          await patchConfig(tx, row.id, { webhook: record });
          await audit(tx, { category: "config", action: "integration.vercel.webhook.refused", verb: "tried to register the Vercel webhook", targetType: "integration", suffix: made.reason.slice(0, 200), ...who(actor, req) });
        });
        // An existing webhook keeps working, so the refusal of a second one is an error, not a state.
        if (before?.id) throw new HttpError(409, made.reason, "VERCEL_WEBHOOK_REFUSED");
        return { ...webhookState(record, linked) };
      }
      const record: VercelWebhookRecord = { id: made.id, url, projectIds: linked, registeredAt: new Date().toISOString(), state: "active", reason: null };
      try {
        await ctx.db.$transaction(async (tx) => {
          const fresh = (await findIntegration(tx, "vercel")) ?? row;
          await replaceSecret(tx, ctx.ring, fresh, "second", "vercel_webhook_secret", made.secret);
          await patchConfig(tx, row.id, { webhook: record });
          await audit(tx, { category: "config", action: "integration.vercel.webhook.create", verb: "registered the Vercel webhook", targetType: "integration", suffix: `for ${linked.length} project${linked.length === 1 ? "" : "s"}`, ...who(actor, req) });
        });
      } catch (e) {
        // Never leave a webhook on the owner's account that nothing here can verify.
        await api.deleteWebhook(made.id).catch(() => undefined);
        throw e;
      }
      // The new one is in force; the old one only repeats it, and its secret is gone.
      if (before?.id && before.id !== made.id) await api.deleteWebhook(before.id).catch((e: unknown) => req.log.warn({ code: e instanceof HttpError ? e.code : "UPSTREAM" }, "the previous Vercel webhook was not removed"));
      await enqueueVercelMirror(ctx.db, null);
      return webhookState(record, linked);
    },

    "integrations.vercel.webhook.delete": async ({ actor, req, ctx }) => {
      requireSession(actor);
      const row = await requireIntegration(ctx.db, "vercel", "default", "Vercel");
      const hook = configOf<VercelConfig>(row).webhook?.id;
      // On Vercel first: if that fails the owner sees why, and nothing here has changed.
      if (hook) await (await vercelApiFor(ctx.db, ctx.ring, deps.http)).deleteWebhook(hook);
      await ctx.db.$transaction(async (tx) => {
        const fresh = (await findIntegration(tx, "vercel")) ?? row;
        await patchConfig(tx, row.id, { webhook: null });
        if (fresh.secondSecretId) {
          await tx.integration.update({ where: { id: row.id }, data: { secondSecretId: null } });
          await tx.secret.delete({ where: { id: fresh.secondSecretId } }).catch(() => undefined);
        }
        await audit(tx, { category: "config", action: "integration.vercel.webhook.delete", verb: "removed the Vercel webhook", targetType: "integration", ...who(actor, req) });
      });
      return undefined;
    },

    "integrations.vercel.sync": async ({ ctx }) => {
      await requireIntegration(ctx.db, "vercel", "default", "Vercel");
      await enqueueVercelMirror(ctx.db, null);
      return undefined;
    },

    "webhooks.vercel": async ({ req, reply, ctx }) => {
      const out = await receiveVercelWebhook(ctx.db, ctx.ring, req, req.body);
      if (out.error) {
        await reply.code(out.status).send(out.error);
        return undefined;
      }
      await reply.code(out.status).send();
      return undefined;
    },

    "apps.vercel.logs": async ({ params, query, actor, reply, ctx }) => {
      const a = requireActor(actor);
      const left = viewerLeft(reply);
      const { app } = await logTarget(ctx.db, params.id, query.deployment);
      assertProjectScope(a, app.environment.projectId);
      return withLogReadSlot(a.userId, () => vercelRuntimeTail(ctx.db, ctx.ring, params.id, query.deployment, query.tail ?? 256, left));
    },

    "apps.vercel.logs.stream": async ({ params, query, actor, req, reply, ctx }) => {
      const a = requireActor(actor);
      const { app, dep } = await logTarget(ctx.db, params.id, query.deployment);
      assertProjectScope(a, app.environment.projectId);
      if (!dep?.externalId || !app.vercelProjectId) throw new HttpError(409, "This app has no Vercel deployment to read yet", "NOT_STARTED");
      const allowed = createReauthorizer(async () => {
        const again = await enforce(ctx.db, req, ctx.web, POLICIES["apps.vercel.logs.stream"]);
        if (!again) throw new HttpError(401, "Sign in to continue", "UNAUTHENTICATED");
        assertProjectScope(again, app.environment.projectId);
      });
      await streamRuntimeLog(ctx.db, ctx.ring, req, reply, { appId: app.id, externalId: dep.externalId, vercelProjectId: app.vercelProjectId, projectId: app.environment.projectId }, allowed, a.userId);
      return undefined;
    },

    "integrations.vercel.projects": async ({ ctx }) => {
      const api = await vercelApiFor(ctx.db, ctx.ring, deps.http);
      const projects = await api.projects();
      const out = [];
      // Two calls per project; five at a time keeps under Vercel's rate limit.
      for (let i = 0; i < projects.length; i += 5) {
        const slice = projects.slice(i, i + 5);
        out.push(...(await Promise.all(slice.map(async (p) => {
          // One project's read failing leaves its lists empty; Vercel slowing the token down stops them all.
          const soft = (e: unknown): never[] => {
            if (e instanceof HttpError && (e.code === "VERCEL_RATE_LIMITED" || e.code === "VERCEL_TOKEN")) throw e;
            return [];
          };
          const [envs, domains] = await Promise.all([api.envs(p.id).catch(soft), api.domains(p.id).catch(soft)]);
          return {
            id: p.id,
            name: p.name,
            framework: p.framework ?? null,
            updatedAt: new Date(p.updatedAt).toISOString(),
            env: envs.map((e) => ({ key: e.key, targets: e.target })),
            domains: domains.map((d) => d.name),
          };
        }))));
      }
      return out;
    },

    "integrations.vercel.import": async ({ body, actor, req, ctx }) => {
      const a = requireActor(actor);
      const project = await ctx.db.project.findUnique({ where: { slug: body.project }, select: { id: true, environments: { where: { name: body.environment }, select: { id: true, apps: { select: { id: true, serverId: true, kind: true, deployTarget: true, vercelProjectId: true } } } } } });
      const env = project?.environments[0];
      if (!project || !env) throw new HttpError(404, "Unknown project or environment", "NOT_FOUND");
      assertProjectScope(a, project.id);

      const api = await vercelApiFor(ctx.db, ctx.ring, deps.http);
      const vars = importableEnv(await api.envs(body.vercelProjectId), body.target);
      // Refuse before any Vercel value is read: every imported value is a secret write.
      if (vars.length) importGate(a)(true);
      const values: Array<{ key: string; value: string }> = [];
      for (const v of vars) {
        const value = await api.envValue(body.vercelProjectId, v.id);
        if (value !== null) values.push({ key: v.key, value });
      }
      const reserved = reservedHosts(ctx.config.publicUrl, ctx.config.reservedHosts.join(","));
      const hosts = importableHosts(importableDomains(await api.domains(body.vercelProjectId)), reserved);
      // Domains attach to the app linked to this Vercel project, else the environment's only frontend,
      // else its only app. Only an app this server routes can serve one: a linked app that stays on
      // Vercel, or a database, gets none. With no single answer they wait, and the result says how many.
      const routes = (x: { kind: string; deployTarget: string }) => x.deployTarget === "server" && ROUTABLE_KINDS.has(x.kind);
      const servable = env.apps.filter(routes);
      const frontends = servable.filter((x) => x.kind === "frontend");
      const linked = env.apps.find((x) => x.vercelProjectId === body.vercelProjectId);
      const target = linked ? (routes(linked) ? linked : undefined) : frontends.length === 1 ? frontends[0] : servable.length === 1 ? servable[0] : undefined;
      // The same rules as adding a domain by hand. A name they refuse is skipped, not the whole import.
      const usable: string[] = [];
      for (const host of target ? hosts : []) {
        const name = await usableHostname(ctx, host).catch((e: unknown) => {
          if (e instanceof HttpError) return null;
          throw e;
        });
        if (name) usable.push(name);
      }

      let domains = 0;
      let version: number | null = null;
      try {
        await ctx.db.$transaction(async (tx) => {
          // Through the versioned store: conflict checked, snapshotted, rollback-able, step-up gated.
          const scope = await loadScope(tx, project.id);
          const stored = await loadEntries(tx, ctx.ring, scope, true);
          const changes = importChanges(values, stored, { id: env.id, name: body.environment });
          // A process-hook key (NODE_OPTIONS, LD_PRELOAD, ...) from a third-party Vercel project runs
          // code before the app's own; refuse it unless an elevated admin confirms, and audit it.
          const hooks = dangerousGate(a, dangerousIn(changes), body.confirmDangerous);
          if (changes.length) {
            const r = await applyChanges(tx, ctx.ring, scope, {
              baseVersion: "current", changes, redeploy: false, authorize: importGate(a),
              writer: { actorType: "user", actorId: a.userId, actorName: a.name, source: "dashboard" },
            });
            version = r.version;
          }
          if (hooks.length) {
            await audit(tx, {
              category: "access", action: "env.dangerousKey", verb: "set a process hook variable in", targetType: "project", targetId: project.id,
              targetLabel: body.project, suffix: hooks.join(", "), ...who(actor, req),
            });
          }
          if (target) {
            for (const hostname of usable) {
              const taken = await tx.domain.findUnique({ where: { hostname }, select: { id: true } });
              if (taken) continue;
              // A preview holds its hostname in a separate table; domains.create refuses a clash, so must this.
              if (await tx.previewDeployment.findUnique({ where: { hostname }, select: { id: true } })) continue;
              const d = await tx.domain.create({ data: { appId: target.id, hostname }, select: { id: true, appId: true } });
              for (const job of jobsForCreate(d, ctx.config.ingress)) await enqueueEdge(tx, job, target.serverId);
              domains++;
            }
          }
          await audit(tx, {
            category: "config", action: "integration.vercel.import", verb: "imported from Vercel into", targetType: "environment", targetId: env.id,
            targetLabel: `${body.project}/${body.environment}`, changes: asJson({ keys: values.map((v) => v.key), domains, version }), ...who(actor, req),
          });
        });
      } catch (e) {
        if (e instanceof EnvPlanError) throw new HttpError(400, e.message, e.code, e.key ? { key: e.key } : {});
        throw e;
      }
      return { variables: values.length, domains, domainsSkipped: target ? hosts.length - usable.length : hosts.length };
    },
  };
}
