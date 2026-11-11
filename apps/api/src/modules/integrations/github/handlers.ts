import type { FastifyRequest } from "fastify";
import type { Keyring } from "@dockify/crypto";
import { storeSecret, type Db, type GitHubInstallation, type Tx } from "@dockify/db";
import type { Ctx, Handlers } from "../../../app.ts";
import { audit } from "../../../audit.ts";
import { HttpError, isUniqueViolation } from "../../../errors.ts";
import { requireSession, who, type IntegrationDeps } from "../deps.ts";
import { asJson, findIntegration, openSecret } from "../store.ts";
import {
  GitHubApiError, consumeInstallState, consumeManifestState, convertManifestCode, installUrl, loadGitHubApp, requireGitHubApp,
  signInstallState, verifyGitHubSignature, webhookPayloadText, type GitHubAppRow,
} from "./app.ts";
import {
  manageUrl, matchPushTargets, parseInstallationEvent, parsePullRequestEvent, parsePushEvent, type InstallationEvent, type PushEvent,
} from "./events.ts";
import { onPullRequest } from "../../previews/webhook.ts";

const SYNC_EVERY_MS = 60_000;
const PER_PAGE = 50;
const SEARCH_PAGES = 10;

interface ApiInstallation {
  id: number;
  account: { login: string; type: string; avatar_url?: string } | null;
  repository_selection: string;
  suspended_at: string | null;
}
interface ApiRepo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  default_branch: string;
  pushed_at: string | null;
  language: string | null;
}

const toGitInstallation = (r: GitHubInstallation) => ({
  id: r.installationId.toString(),
  account: { login: r.accountLogin, type: r.accountType === "Organization" ? ("Organization" as const) : ("User" as const), avatarUrl: r.avatarUrl },
  repositorySelection: r.repositorySelection === "selected" ? ("selected" as const) : ("all" as const),
  ...(r.selectedCount !== null ? { selectedCount: r.selectedCount } : {}),
  manageUrl: manageUrl(r.accountType, r.accountLogin, r.installationId.toString()),
});

const toGitRepo = (r: ApiRepo) => ({
  id: String(r.id),
  fullName: r.full_name,
  name: r.name,
  owner: r.owner.login,
  private: r.private,
  defaultBranch: r.default_branch,
  pushedAt: r.pushed_at ?? new Date(0).toISOString(),
  language: r.language,
  framework: null,
});

async function upsertInstallation(db: Tx, i: { id: string; login: string; accountType: string; avatarUrl: string | null; repositorySelection: string; suspended?: boolean }) {
  const data = {
    accountLogin: i.login,
    accountType: i.accountType,
    avatarUrl: i.avatarUrl,
    repositorySelection: i.repositorySelection,
    ...(i.suspended === undefined ? {} : { suspendedAt: i.suspended ? new Date() : null }),
  };
  await db.gitHubInstallation.upsert({ where: { installationId: BigInt(i.id) }, create: { installationId: BigInt(i.id), ...data }, update: data });
}

/** Pulls the installations from GitHub, so the picker works even when a webhook was missed. */
export async function syncInstallations(db: Db, ring: Keyring, deps: IntegrationDeps, app: GitHubAppRow): Promise<void> {
  const jwt = await deps.github.jwt(db, ring, app);
  const seen: string[] = [];
  for (let page = 1; page <= 20; page++) {
    const rows = await deps.github.call<ApiInstallation[]>("GET", `/app/installations?per_page=100&page=${page}`, { jwt });
    for (const r of rows) {
      if (!r.account) continue;
      seen.push(String(r.id));
      await upsertInstallation(db, {
        id: String(r.id), login: r.account.login, accountType: r.account.type, avatarUrl: r.account.avatar_url ?? null,
        repositorySelection: r.repository_selection, suspended: r.suspended_at !== null,
      });
    }
    if (rows.length < 100) break;
  }
  await db.gitHubInstallation.deleteMany({ where: { installationId: { notIn: seen.map((s) => BigInt(s)) } } });
}

async function requireInstallation(db: Tx, id: string): Promise<GitHubInstallation> {
  if (!/^\d{1,20}$/.test(id)) throw new HttpError(404, "Unknown installation", "NOT_FOUND");
  const row = await db.gitHubInstallation.findUnique({ where: { installationId: BigInt(id) } });
  if (!row) throw new HttpError(404, "Unknown installation", "NOT_FOUND");
  if (row.suspendedAt) throw new HttpError(409, "This installation is suspended on GitHub", "SUSPENDED");
  return row;
}


interface Delivery {
  projectId: string | null;
  summary: string;
}

async function onPush(db: Db, deps: IntegrationDeps, push: PushEvent): Promise<Delivery> {
  if (push.deleted) return { projectId: null, summary: `branch ${push.branch} deleted, nothing to deploy` };
  const apps = await db.app.findMany({
    // Only apps this server builds: Vercel builds its own from its own Git integration.
    where: { gitRepository: { not: null }, deployTarget: "server", environment: { project: { autoDeploy: true, archivedAt: null } } },
    select: { id: true, name: true, gitRepository: true, gitRepoId: true, gitBranch: true, deployTarget: true, environment: { select: { branch: true, project: { select: { id: true, slug: true } } } } },
  });
  // The app's own repository, never its project's: an app can be built from another one.
  const candidates = apps.map((a) => ({ ...a, repoId: a.gitRepoId, envBranch: a.environment.branch }));
  const targets = matchPushTargets(push, candidates);
  const queued: string[] = [];
  const coalesced: string[] = [];
  for (const t of targets) {
    const out = await deps.deploys.request(db, {
      appId: t.id, trigger: "push", actorType: "webhook", actorName: "GitHub", gitAuthor: push.author, gitAuthorAvatarUrl: push.authorAvatarUrl, gitAuthorName: push.authorName, branch: push.branch, commitSha: push.commitSha, message: push.message,
    });
    (out.kind === "queued" ? queued : coalesced).push(t.name);
    if (out.kind === "queued") {
      await audit(db, {
        category: "deploys", action: "deploy.push", verb: "started a deploy of", actorType: "webhook", actorName: "GitHub", gitAuthor: push.author,
        targetType: "deployment", targetId: out.deploymentId, targetLabel: `${t.environment.project.slug} / ${t.name}`, targetHref: `/deployments/${out.deploymentId}`,
        suffix: `from a push to ${push.branch}`,
      });
    }
  }
  const summary = targets.length
    ? `push to ${push.branch}: ${[queued.length && `deploying ${queued.join(", ")}`, coalesced.length && `queued after current build ${coalesced.join(", ")}`].filter(Boolean).join("; ")}`
    : `push to ${push.branch}: no app follows this branch`;
  return { projectId: targets[0]?.environment.project.id ?? null, summary };
}

async function onInstallation(db: Db, deps: IntegrationDeps, ev: InstallationEvent): Promise<Delivery> {
  if (ev.action === "deleted") {
    await db.gitHubInstallation.deleteMany({ where: { installationId: BigInt(ev.id) } });
    deps.github.forget(ev.id);
    return { projectId: null, summary: `GitHub App removed from ${ev.login}` };
  }
  await upsertInstallation(db, {
    id: ev.id, login: ev.login, accountType: ev.accountType, avatarUrl: ev.avatarUrl, repositorySelection: ev.repositorySelection,
    ...(ev.action === "suspend" ? { suspended: true } : ev.action === "unsuspend" ? { suspended: false } : {}),
  });
  if (ev.action === "suspend") deps.github.forget(ev.id);
  return { projectId: null, summary: `installation on ${ev.login}: ${ev.action}` };
}

const DELIVERY_EVENT: Record<string, string> = { push: "push", pull_request: "pull_request", ping: "ping", installation: "installation", installation_repositories: "installation" };

/**
 * No session: the HMAC over the raw bytes is the whole authentication, so it is checked before anything is written.
 * The delivery id insert (unique index) is the replay check.
 */
export async function receiveGitHubWebhook(
  db: Db, ring: Keyring, deps: IntegrationDeps, req: FastifyRequest, raw: unknown,
): Promise<{ status: number; error?: { error: string; code: string } }> {
  const started = Date.now();
  const app = await loadGitHubApp(db);
  if (!app) return { status: 404, error: { error: "No GitHub App is configured", code: "NOT_CONNECTED" } };
  if (!Buffer.isBuffer(raw)) return { status: 400, error: { error: "Expected a raw request body", code: "BAD_BODY" } };
  const secret = await openSecret(db, ring, app.row, "second");
  if (!secret || !verifyGitHubSignature(secret, raw, req.headers["x-hub-signature-256"])) {
    return { status: 401, error: { error: "Signature verification failed", code: "BAD_SIGNATURE" } };
  }
  const event = typeof req.headers["x-github-event"] === "string" ? req.headers["x-github-event"] : "";
  const deliveryId = req.headers["x-github-delivery"];
  if (typeof deliveryId !== "string" || !/^[\w-]{1,100}$/.test(deliveryId)) {
    return { status: 400, error: { error: "Missing X-GitHub-Delivery header", code: "NO_DELIVERY_ID" } };
  }
  const stored = DELIVERY_EVENT[event];
  if (!stored) return { status: 202 };

  let rowId: string;
  // A known id is expected (a manual redelivery), so the insert skips duplicates: a caught unique violation
  // would still reach Prisma's error log.
  const fresh = await db.webhookDelivery.createMany({ data: [{ provider: "github", deliveryId, event: stored }], skipDuplicates: true });
  if (fresh.count === 1) {
    rowId = (await db.webhookDelivery.findFirstOrThrow({ where: { provider: "github", deliveryId }, select: { id: true } })).id;
  } else {
    // GitHub never redelivers on its own, so a repeat of a delivery that failed here is the owner asking again.
    // The update claims it, so two at once run it once.
    const retry = await db.webhookDelivery.updateMany({ where: { provider: "github", deliveryId, statusCode: { gte: 500 } }, data: { statusCode: null, summary: "" } });
    if (retry.count !== 1) {
      req.log.info({ deliveryId, event }, "GitHub redelivered a delivery already handled; nothing to do");
      return { status: 202 };
    }
    req.log.info({ deliveryId, event }, "GitHub redelivered a delivery that failed here; running it again");
    rowId = (await db.webhookDelivery.findFirstOrThrow({ where: { provider: "github", deliveryId }, select: { id: true } })).id;
  }

  const finish = async (status: number, d: Delivery) => {
    await db.webhookDelivery.update({
      where: { id: rowId },
      data: { statusCode: status, summary: d.summary.slice(0, 500), projectId: d.projectId, durationMs: Date.now() - started },
    });
    return status;
  };

  const text = webhookPayloadText(req.headers["content-type"], raw);
  let payload: unknown;
  try {
    payload = text === null ? undefined : JSON.parse(text);
  } catch {
    payload = undefined;
  }
  if (payload === undefined) {
    await finish(400, { projectId: null, summary: "the payload is not valid JSON" });
    return { status: 400, error: { error: "The payload is not valid JSON", code: "BAD_JSON" } };
  }

  let d: Delivery = { projectId: null, summary: event === "ping" ? "ping" : `ignored ${event}` };
  try {
    if (event === "push") {
      const push = parsePushEvent(payload);
      if (push) d = await onPush(db, deps, push);
      else d = { projectId: null, summary: "not a branch push" };
    } else if (event === "pull_request") {
      const pr = parsePullRequestEvent(payload);
      if (pr) d = await onPullRequest(db, pr);
    } else if (event === "installation" || event === "installation_repositories") {
      const ev = parseInstallationEvent(event, payload);
      if (ev) d = await onInstallation(db, deps, ev);
    }
  } catch (e) {
    await finish(500, { projectId: d.projectId, summary: "Dockify failed to process this delivery" });
    throw e;
  }
  await finish(202, d);
  return { status: 202 };
}

/** Handles the setup redirect GitHub sends after an install. */
export async function completeInstall(
  db: Db, ring: Keyring, deps: IntegrationDeps, query: { installation_id?: string; state?: string },
): Promise<{ ok: boolean }> {
  const sessionId = query.state ? consumeInstallState(ring, deps.states, query.state) : null;
  if (!sessionId || !query.installation_id || !/^\d{1,20}$/.test(query.installation_id)) return { ok: false };
  // Same rule as the App's own callback: still signed in, and still an enabled Admin.
  const session = await liveAdmin(db, sessionId);
  if (!session) return { ok: false };
  const app = await requireGitHubApp(db);
  const jwt = await deps.github.jwt(db, ring, app);
  const r = await deps.github.call<ApiInstallation>("GET", `/app/installations/${query.installation_id}`, { jwt });
  if (!r.account) return { ok: false };
  await upsertInstallation(db, {
    id: String(r.id), login: r.account.login, accountType: r.account.type, avatarUrl: r.account.avatar_url ?? null,
    repositorySelection: r.repository_selection, suspended: r.suspended_at !== null,
  });
  // Adding the App grants clone and push-to-deploy access, so it is audited like its removal.
  await audit(db, {
    category: "access", action: "git.installation.add", verb: "added the GitHub App",
    actorType: "user", actorId: session.userId, actorName: session.name,
    targetType: "github_installation", targetId: String(r.id), targetLabel: r.account.login,
  });
  return { ok: true };
}


/** Anything not shaped like a manifest code is not worth a call to GitHub. */
const MANIFEST_CODE = /^[\w-]{1,128}$/;

/** Null unless the session is still signed in and its user is still an enabled Admin. */
async function liveAdmin(db: Db, sessionId: string, now = new Date()): Promise<{ userId: string; name: string } | null> {
  const s = await db.session.findUnique({
    where: { id: sessionId },
    select: {
      revokedAt: true, expiresAt: true, absoluteExpiresAt: true, userId: true,
      user: { select: { name: true, disabledAt: true, member: { select: { role: true } } } },
    },
  });
  if (!s || s.revokedAt || s.expiresAt <= now || s.absoluteExpiresAt <= now) return null;
  if (s.user.disabledAt || s.user.member?.role !== "admin") return null;
  return { userId: s.userId, name: s.user.name };
}

export type AppManifestOutcome = { ok: true; slug: string } | { ok: false; reason: string };

/**
 * GitHub redirects back cross-site, so no session cookie arrives: the signed single-use state is the only
 * authentication, and the session it names must still be a live Admin before the code is traded.
 * The refusal reason never carries the code or a secret.
 */
export async function completeAppManifest(
  db: Db, ring: Keyring, deps: IntegrationDeps, query: { code?: string; state?: string }, client: { ip: string; userAgent: string | null },
): Promise<AppManifestOutcome> {
  const sessionId = query.state ? consumeManifestState(ring, deps.states, query.state) : null;
  if (!sessionId) return { ok: false, reason: "the state is missing, expired, already used or not from this server" };
  if (!query.code || !MANIFEST_CODE.test(query.code)) return { ok: false, reason: "GitHub sent no usable code" };
  const admin = await liveAdmin(db, sessionId);
  if (!admin) return { ok: false, reason: "the session that started this has ended or is no longer an Admin" };
  // Checked before the exchange, so a refused App's credentials are never even fetched.
  if (await findIntegration(db, "github_app")) return { ok: false, reason: "a GitHub App is already configured" };

  const out = await convertManifestCode(deps.http, query.code);
  if (!out.ok) return out;
  const app = out.app;
  try {
    await db.$transaction(async (tx) => {
      const row = await tx.integration.create({ data: { kind: "github_app", name: "default", config: asJson({ appId: app.appId, slug: app.slug }) } });
      const pk = await storeSecret(tx, ring, { kind: "github_private_key", ownerType: "integration", ownerId: row.id }, app.pem, null);
      const wh = await storeSecret(tx, ring, { kind: "github_webhook_secret", ownerType: "integration", ownerId: row.id }, app.webhookSecret, null);
      // GitHub hands the client secret over only here.
      const cs = app.clientSecret ? await storeSecret(tx, ring, { kind: "github_client_secret", ownerType: "integration", ownerId: row.id }, app.clientSecret, null) : null;
      const config = {
        appId: app.appId, slug: app.slug, clientId: app.clientId, htmlUrl: app.htmlUrl, source: "manifest",
        ...(app.owner ? { owner: app.owner } : {}), ...(cs ? { clientSecretId: cs } : {}),
      };
      await tx.integration.update({ where: { id: row.id }, data: { secretId: pk, secondSecretId: wh, config: asJson(config) } });
      await audit(tx, {
        category: "config", action: "git.app.create", verb: "created the GitHub App",
        actorType: "user", actorId: admin.userId, actorName: admin.name,
        targetType: "github_app", targetId: String(app.appId), targetLabel: app.slug,
        ip: client.ip, userAgent: client.userAgent,
      });
    });
  } catch (e) {
    // Two callbacks that both passed the check above meet here: the unique (kind, name) row lets one win.
    if (isUniqueViolation(e)) return { ok: false, reason: "a GitHub App is already configured" };
    throw e;
  }
  return { ok: true, slug: app.slug };
}


export function gitHandlers(deps: IntegrationDeps): Handlers {
  let lastSync = 0;
  const repoInstallation = new Map<string, string>();

  return {
    "git.installations": async ({ ctx }) => {
      const app = await loadGitHubApp(ctx.db);
      if (app && Date.now() - lastSync > SYNC_EVERY_MS) {
        lastSync = Date.now();
        await syncInstallations(ctx.db, ctx.ring, deps, app).catch(() => undefined);
      }
      const rows = await ctx.db.gitHubInstallation.findMany({ orderBy: { createdAt: "asc" } });
      return rows.map(toGitInstallation);
    },

    "git.installUrl": async ({ actor, ctx }) => {
      const s = requireSession(actor);
      const app = await requireGitHubApp(ctx.db);
      return { url: installUrl(app.config.slug, signInstallState(ctx.ring, deps.states, s.sessionId)) };
    },

    "git.repos": async ({ query, ctx }) => {
      const inst = await requireInstallation(ctx.db, query.installation);
      const app = await requireGitHubApp(ctx.db);
      const id = inst.installationId.toString();
      const token = await deps.github.installationToken(ctx.db, ctx.ring, app, id);
      const list = async (page: number) =>
        deps.github.call<{ total_count: number; repositories: ApiRepo[] }>("GET", `/installation/repositories?per_page=${PER_PAGE}&page=${page}`, { token });

      if (query.q) {
        const needle = query.q.toLowerCase();
        const items: ApiRepo[] = [];
        for (let page = 1; page <= SEARCH_PAGES; page++) {
          const r = await list(page);
          items.push(...r.repositories.filter((x) => x.full_name.toLowerCase().includes(needle)));
          if (r.repositories.length < PER_PAGE) break;
        }
        for (const r of items) repoInstallation.set(String(r.id), id);
        return { items: items.slice(0, 100).map(toGitRepo), nextCursor: null };
      }
      const page = query.cursor && /^\d{1,4}$/.test(query.cursor) ? Number(query.cursor) : 1;
      const r = await list(page);
      for (const x of r.repositories) repoInstallation.set(String(x.id), id);
      const more = page * PER_PAGE < r.total_count;
      await ctx.db.gitHubInstallation.update({ where: { id: inst.id }, data: { selectedCount: inst.repositorySelection === "selected" ? r.total_count : null } });
      return { items: r.repositories.map(toGitRepo), nextCursor: more ? String(page + 1) : null };
    },

    "git.branches": async ({ params, ctx }) => {
      if (!/^\d{1,20}$/.test(params.id)) throw new HttpError(404, "Unknown repository", "NOT_FOUND");
      const app = await requireGitHubApp(ctx.db);
      const known = repoInstallation.get(params.id);
      const all = await ctx.db.gitHubInstallation.findMany({ where: { suspendedAt: null }, select: { installationId: true } });
      const order = [known, ...all.map((i) => i.installationId.toString()).filter((x) => x !== known)].filter((x): x is string => !!x);
      for (const inst of order) {
        const token = await deps.github.installationToken(ctx.db, ctx.ring, app, inst);
        let repo: ApiRepo;
        try {
          repo = await deps.github.call<ApiRepo>("GET", `/repositories/${params.id}`, { token });
        } catch (e) {
          if (e instanceof GitHubApiError && (e.upstreamStatus === 404 || e.upstreamStatus === 403)) continue;
          throw e;
        }
        repoInstallation.set(params.id, inst);
        const names: string[] = [];
        for (let page = 1; page <= 10; page++) {
          const rows = await deps.github.call<Array<{ name: string }>>("GET", `/repositories/${params.id}/branches?per_page=100&page=${page}`, { token });
          names.push(...rows.map((b) => b.name));
          if (rows.length < 100) break;
        }
        return names.map((name) => ({ name, default: name === repo.default_branch }));
      }
      throw new HttpError(404, "No installation can see this repository", "NOT_FOUND");
    },

    "git.installations.delete": async ({ params, actor, req, ctx }) => {
      if (!/^\d{1,20}$/.test(params.id)) throw new HttpError(404, "Unknown installation", "NOT_FOUND");
      const row = await ctx.db.gitHubInstallation.findUnique({ where: { installationId: BigInt(params.id) } });
      if (!row) throw new HttpError(404, "Unknown installation", "NOT_FOUND");
      const app = await loadGitHubApp(ctx.db);
      if (app) {
        const jwt = await deps.github.jwt(ctx.db, ctx.ring, app);
        await deps.github.call("DELETE", `/app/installations/${params.id}`, { jwt }).catch((e: unknown) => {
          if (!(e instanceof GitHubApiError && e.upstreamStatus === 404)) throw e;
        });
      }
      deps.github.forget(params.id);
      for (const [repo, inst] of repoInstallation) if (inst === params.id) repoInstallation.delete(repo);
      await ctx.db.$transaction(async (tx) => {
        await tx.gitHubInstallation.delete({ where: { id: row.id } });
        await audit(tx, { category: "config", action: "git.installation.delete", verb: "removed the GitHub App from", targetType: "github_installation", targetId: params.id, targetLabel: row.accountLogin, ...who(actor, req) });
      });
      return { ok: true as const };
    },

    /**
     * Removes the row, every sealed value it owns and its installations. Apps keep their repository URL but lose the
     * installation they cloned through. The App itself stays on GitHub, which has no API to delete one.
     */
    "git.app.delete": async ({ actor, req, ctx }) => {
      const row = await findIntegration(ctx.db, "github_app");
      if (!row) throw new HttpError(404, "No GitHub App is configured", "NOT_FOUND");
      const slug = typeof (row.config as { slug?: unknown } | null)?.slug === "string" ? (row.config as { slug: string }).slug : "default";
      const installations = await ctx.db.gitHubInstallation.count();
      await ctx.db.$transaction(async (tx) => {
        await tx.integration.delete({ where: { id: row.id } });
        const pointed = [row.secretId, row.secondSecretId].filter((x): x is string => !!x);
        await tx.secret.deleteMany({ where: { OR: [{ ownerType: "integration", ownerId: row.id }, ...(pointed.length ? [{ id: { in: pointed } }] : [])] } });
        await tx.gitHubInstallation.deleteMany({});
        await audit(tx, {
          category: "config", action: "git.app.delete", verb: "removed the GitHub App", targetType: "github_app", targetLabel: slug,
          suffix: installations ? `and its ${installations} installation${installations === 1 ? "" : "s"}` : null, ...who(actor, req),
        });
      });
      deps.github.forget();
      repoInstallation.clear();
      return undefined;
    },

    "webhooks.github": async ({ req, reply, ctx }) => {
      const out = await receiveGitHubWebhook(ctx.db, ctx.ring, deps, req, req.body);
      if (out.error) {
        await reply.code(out.status).send(out.error);
        return undefined;
      }
      await reply.code(out.status).send();
      return undefined;
    },
  };
}

export type { Ctx };
