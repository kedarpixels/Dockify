/**
 * An app with deployTarget "vercel" is not built here: the worker pushes its resolved env to Vercel,
 * asks it to deploy the branch and follows it. Sync state lives under the vercel integration row.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { readSecretValue, type Db, type Prisma, type SecretVault } from "@dockify/db";
import { jsonOf, type HttpClient } from "@dockify/net-guard";
import { httpsOfHost, safeInspectorUrl } from "./vercel-host.ts";

export const VERCEL_API = "https://api.vercel.com";
export const FOLLOW_ONLY = "This app only follows its Vercel project, so Dockify sent nothing to Vercel";
const POLL_MS = 5_000;
const DEPLOY_TIMEOUT_MS = 30 * 60_000;

export type VercelState = "QUEUED" | "INITIALIZING" | "BUILDING" | "READY" | "ERROR" | "CANCELED";

export function mapState(s: string | undefined): "ready" | "building" | "error" {
  if (s === "READY") return "ready";
  if (s === "ERROR" || s === "CANCELED") return "error";
  return "building";
}

export function vercelTargetFor(environmentName: string): "production" | "preview" {
  return environmentName === "production" || environmentName === "prod" ? "production" : "preview";
}

export class VercelJobError extends Error {
  readonly permanent: boolean;
  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = "VercelJobError";
    this.permanent = permanent;
  }
}

export interface VercelTargetDeps {
  db: Db;
  vault: SecretVault;
  http: HttpClient;
  resolveEnv(appId: string): Promise<Record<string, string>>;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

interface Payload {
  appId: string;
  action: "sync_env" | "deploy" | "status";
  deploymentId?: string;
  vercelDeploymentId?: string;
}

function parsePayload(p: unknown): Payload {
  const o = (p ?? {}) as Record<string, unknown>;
  if (typeof o.appId !== "string" || !["sync_env", "deploy", "status"].includes(String(o.action))) {
    throw new VercelJobError("vercel_sync payload is malformed", true);
  }
  return {
    appId: o.appId,
    action: o.action as Payload["action"],
    ...(typeof o.deploymentId === "string" ? { deploymentId: o.deploymentId } : {}),
    ...(typeof o.vercelDeploymentId === "string" ? { vercelDeploymentId: o.vercelDeploymentId } : {}),
  };
}

class Vercel {
  private readonly http: HttpClient;
  private readonly token: string;
  private readonly teamId: string | null;
  constructor(http: HttpClient, token: string, teamId: string | null) {
    this.http = http;
    this.token = token;
    this.teamId = teamId;
  }
  async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const url = `${VERCEL_API}${path}${this.teamId ? `${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(this.teamId)}` : ""}`;
    const res = await this.http({ method, url, headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401 || res.status === 403) throw new VercelJobError("Vercel refused the stored token; reconnect Vercel", true);
    if (res.status === 404) throw new VercelJobError("The linked Vercel project no longer exists", true);
    if (res.status === 429 || res.status >= 500) throw new VercelJobError(`Vercel answered ${res.status}`, false);
    if (res.status < 200 || res.status >= 300) throw new VercelJobError(`Vercel answered ${res.status}`, true);
    const out = jsonOf<T>(res);
    if (out === null) throw new VercelJobError("Vercel sent a body that is not JSON", false);
    return out;
  }
}

/** Every value is stored encrypted on Vercel. */
export function envPayload(env: Record<string, string>, target: "production" | "preview") {
  return Object.entries(env)
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !k.startsWith("VERCEL_"))
    .map(([key, value]) => ({ key, value, type: "encrypted", target: [target] }));
}

async function setSync(db: Db, integrationId: string, appId: string, patch: Record<string, unknown>): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dockify.integration.vercel'))`;
    const row = await tx.integration.findUnique({ where: { id: integrationId }, select: { config: true } });
    const config = (row?.config ?? {}) as Record<string, unknown>;
    const apps = (config.apps ?? {}) as Record<string, Record<string, unknown>>;
    apps[appId] = { ...(apps[appId] ?? {}), ...patch };
    await tx.integration.update({ where: { id: integrationId }, data: { config: { ...config, apps } as Prisma.InputJsonValue } });
  });
}

/** Ties the row a person started to Vercel's id; if a mirror pass saw the id first, its row goes. */
async function claimExternal(db: Db, deploymentId: string, created: { id: string; url: string; inspectorUrl?: string | null }): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.deployment.deleteMany({ where: { provider: "vercel", externalId: created.id, id: { not: deploymentId } } });
    await tx.deployment.updateMany({
      where: { id: deploymentId },
      data: {
        provider: "vercel", externalId: created.id, externalUrl: httpsOfHost(created.url), inspectorUrl: safeInspectorUrl(created.inspectorUrl),
      },
    });
  });
}

export async function runVercelSync(deps: VercelTargetDeps, payload: unknown, signal: AbortSignal): Promise<void> {
  const p = parsePayload(payload);
  const { db } = deps;
  const wait = deps.wait ?? ((ms, s) => sleep(ms, undefined, { signal: s }));
  const app = await db.app.findUnique({
    where: { id: p.appId },
    select: { id: true, deployTarget: true, vercelProjectId: true, vercelFollowOnly: true, gitBranch: true, gitRepoId: true, environment: { select: { name: true, branch: true, project: { select: { gitRepoId: true } } } } },
  });
  if (!app) return;
  if (app.vercelFollowOnly) {
    // A job queued before the switch, or by anything else: the row says what happened, and no call is made.
    if (p.deploymentId) await db.deployment.updateMany({ where: { id: p.deploymentId }, data: { status: "cancelled", error: FOLLOW_ONLY, finishedAt: new Date() } });
    throw new VercelJobError(FOLLOW_ONLY, true);
  }
  if (app.deployTarget !== "vercel" || !app.vercelProjectId) throw new VercelJobError("This app does not deploy to Vercel", true);
  const row = await db.integration.findUnique({ where: { kind_name: { kind: "vercel", name: "default" } } });
  if (!row?.secretId) throw new VercelJobError("Vercel is not connected", true);
  const token = await readSecretValue(db, deps.vault, row.secretId);
  if (!token) throw new VercelJobError("Vercel token is missing", true);
  const teamId = ((row.config as { team?: { id?: string } | null })?.team?.id) ?? null;
  const api = new Vercel(deps.http, token, teamId);
  const project = encodeURIComponent(app.vercelProjectId);
  const target = vercelTargetFor(app.environment.name);
  const mark = (patch: Record<string, unknown>) => setSync(db, row.id, app.id, patch);
  /** Asked right before each write, so a switch to follow while this job runs stops the next one. */
  const stillDeploys = async () => {
    const now = await db.app.findUnique({ where: { id: app.id }, select: { vercelFollowOnly: true } });
    if (!now || now.vercelFollowOnly) throw new VercelJobError(FOLLOW_ONLY, true);
  };

  const fail = async (e: unknown) => {
    await mark({ state: "failed", at: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) });
    if (p.deploymentId) await db.deployment.updateMany({ where: { id: p.deploymentId }, data: { status: "failed", error: e instanceof Error ? e.message.slice(0, 500) : "failed", finishedAt: new Date() } });
  };

  try {
    if (p.action === "status") {
      if (!p.vercelDeploymentId) throw new VercelJobError("status needs vercelDeploymentId", true);
      const d = await api.call<{ url: string; readyState: VercelState; createdAt: number }>("GET", `/v13/deployments/${encodeURIComponent(p.vercelDeploymentId)}`);
      await mark({ lastDeploy: { url: `https://${d.url}`, state: mapState(d.readyState), at: new Date(d.createdAt).toISOString() } });
      return;
    }

    // Asked before the push: a deploy that cannot start must not have sent the secrets first.
    const repoId = app.gitRepoId ?? app.environment.project.gitRepoId;
    if (p.action === "deploy" && !repoId) throw new VercelJobError("This app has no GitHub repository picked through the GitHub App, so Vercel has nothing to build. Nothing was sent to Vercel.", true);

    const env = await deps.resolveEnv(app.id);
    const entries = envPayload(env, target);
    await mark({ state: "pending", at: new Date().toISOString() });
    await stillDeploys();
    if (entries.length) await api.call("POST", `/v10/projects/${project}/env?upsert=true`, entries);
    await mark({ state: "synced", at: new Date().toISOString(), envVars: entries.length, error: null });
    if (p.action === "sync_env") return;

    const ref = app.gitBranch?.trim() || app.environment.branch;
    if (p.deploymentId) await db.deployment.updateMany({ where: { id: p.deploymentId }, data: { status: "building", startedAt: new Date(), externalTarget: target } });
    const meta = await api.call<{ name: string }>("GET", `/v9/projects/${project}`);
    await stillDeploys();
    const created = await api.call<{ id: string; url: string; readyState: VercelState; inspectorUrl?: string | null }>("POST", "/v13/deployments", {
      name: meta.name, project: app.vercelProjectId, target, gitSource: { type: "github", repoId, ref },
    });
    await mark({ lastDeploy: { url: `https://${created.url}`, state: "building", at: new Date().toISOString() } });
    if (p.deploymentId) await claimExternal(db, p.deploymentId, created);

    const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
    let state = created.readyState;
    while (mapState(state) === "building") {
      if (Date.now() > deadline) throw new VercelJobError("Vercel did not finish the deployment in 30 minutes", true);
      await wait(POLL_MS, signal);
      state = (await api.call<{ readyState: VercelState }>("GET", `/v13/deployments/${encodeURIComponent(created.id)}`)).readyState;
    }
    const final = mapState(state);
    await mark({ lastDeploy: { url: `https://${created.url}`, state: final, at: new Date().toISOString() } });
    if (p.deploymentId) {
      await db.deployment.updateMany({
        where: { id: p.deploymentId },
        data: final === "ready" ? { status: "ready", finishedAt: new Date() } : state === "CANCELED" ? { status: "cancelled", finishedAt: new Date() } : { status: "failed", error: `Vercel deployment ended ${state}`, finishedAt: new Date() },
      });
    }
    // Someone cancelled it on Vercel. That is not a failure, so nothing alerts.
    if (state === "CANCELED") return;
    if (final !== "ready") throw new VercelJobError(`Vercel deployment ended ${state}`, true);
  } catch (e) {
    if (signal.aborted) throw e;
    if (!(e instanceof VercelJobError && !e.permanent)) await fail(e);
    throw e;
  }
}
