import type { FastifyRequest } from "fastify";
import type { TokenGrant } from "@dockify/contracts";
import { hashToken, safeEqual } from "@dockify/crypto";
import type { Db, Role, TokenScope } from "@dockify/db";
import { readCookie, type WebOrigin } from "./cookies.ts";
import { forbidden, HttpError, stepUpRequired, unauthenticated } from "./errors.ts";
import { ROLE_RANK, SCOPE_RANK, SCOPE_ROLE, type Policy } from "./policy.ts";

/** The signed-in caller, or a 401. */
export function requireActor(actor: Actor | null): Actor {
  if (!actor) throw unauthenticated();
  return actor;
}

/** The caller through a browser session, or a 401: an API token never reaches these. */
export function requireSession(actor: Actor | null): SessionActor {
  if (!actor || actor.kind !== "session") throw unauthenticated();
  return actor;
}

/** The request facts an audit row keeps. */
export const meta = (req: FastifyRequest) => ({ ip: req.clientIp, userAgent: req.headers["user-agent"] ?? null });

/** Who did it, as an audit row and a deployment row both spell it. */
export const actorFields = (a: Actor) => ({
  actorType: a.kind === "token" ? ("token" as const) : ("user" as const),
  actorId: a.kind === "token" ? a.tokenId : a.userId,
  actorName: a.name,
});

/** A browser session. */
export interface SessionActor {
  kind: "session";
  userId: string;
  name: string;
  role: Role;
  sessionId: string;
  elevated: boolean;
}

/** An API token. Never elevated; acts with min(owner's role, scope's role). */
export interface TokenActor {
  kind: "token";
  userId: string;
  name: string;
  role: Role;
  tokenId: string;
  scope: TokenScope;
  /** Chosen at creation. When false the token reaches only `projectIds`, and no ids means no project. */
  allProjects: boolean;
  projectIds: string[];
  /** Explicit powers on top of the scope; see TokenGrant. */
  grants: TokenGrant[];
  elevated: false;
}

export type Actor = SessionActor | TokenActor;

/** What authenticates the worker on the internal routes: the channel token, and optionally a pinned peer list. */
export interface InternalAuth {
  token: string;
  /** Socket peer addresses allowed to call; empty means any peer that knows the token. */
  peers: string[];
}

/** Session lifetimes: idle at most 24 h, absolute at most 30 days. */
export const SESSION_IDLE_MS = 24 * 3600_000;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 3600_000;
export const ELEVATION_MS = 5 * 60_000;
const REFRESH_AFTER_MS = 5 * 60_000;

/**
 * A value the rank tables do not know (a migration ahead of this build, a manual edit) ranks below
 * everything. Comparing the raw lookups would pass it: undefined < n is false.
 */
const roleRank = (r: Role): number => ROLE_RANK[r] ?? -1;
const scopeRank = (s: TokenScope): number => SCOPE_RANK[s] ?? -1;
/** At least `need`: written so an unknown value can never pass. */
export const roleAtLeast = (have: Role, need: Role): boolean => roleRank(have) >= roleRank(need) && roleRank(have) >= 0;
export const scopeAtLeast = (have: TokenScope, need: TokenScope): boolean => scopeRank(have) >= scopeRank(need) && scopeRank(have) >= 0;

/**
 * Whether this caller may read a command's text: an app's build, start and release commands and a
 * scheduled job's. They can hold a token someone pasted inline, so a Viewer and a read token (which
 * acts as a Viewer) get them blank.
 */
export const readsCommands = (a: Actor): boolean => roleAtLeast(a.role, "admin");

const minRole = (a: Role, b: Role): Role => (roleRank(a) <= roleRank(b) ? a : b);

export function readBearer(req: FastifyRequest): string | null {
  const raw = req.headers.authorization;
  if (typeof raw !== "string") return null;
  const m = /^Bearer[ \t]+(\S+)$/i.exec(raw.trim());
  return m?.[1] ?? null;
}

/** Resolves the browser session in the cookie, or null. Refreshes idle expiry at most every 5 min. */
export async function sessionFromCookie(db: Db, req: FastifyRequest, web: WebOrigin, now = new Date()): Promise<SessionActor | null> {
  const token = readCookie(req, web, "session");
  if (!token) return null;
  const s = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: { member: true } } },
  });
  if (!s || s.revokedAt || s.expiresAt <= now || s.absoluteExpiresAt <= now) return null;
  if (s.user.disabledAt || !s.user.member) return null;

  if (now.getTime() - s.lastSeenAt.getTime() > REFRESH_AFTER_MS) {
    const expiresAt = new Date(Math.min(now.getTime() + SESSION_IDLE_MS, s.absoluteExpiresAt.getTime()));
    await db.session.update({ where: { id: s.id }, data: { lastSeenAt: now, expiresAt } });
  }
  return {
    kind: "session",
    userId: s.userId,
    name: s.user.name,
    role: s.user.member.role,
    sessionId: s.id,
    elevated: !!s.elevatedUntil && s.elevatedUntil > now,
  };
}

async function tokenActor(db: Db, raw: string, now: Date): Promise<TokenActor> {
  const t = await db.apiToken.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: { user: { include: { member: true } }, projects: true },
  });
  if (!t || t.revokedAt || t.user.disabledAt || !t.user.member) throw unauthenticated("Unknown or revoked API token");
  if (t.expiresAt && t.expiresAt <= now) throw new HttpError(401, "API token has expired", "TOKEN_EXPIRED");
  if (!Object.hasOwn(SCOPE_ROLE, t.scope)) throw unauthenticated("Unknown or revoked API token");
  return {
    kind: "token",
    userId: t.userId,
    name: t.name,
    role: minRole(t.user.member.role, SCOPE_ROLE[t.scope]),
    tokenId: t.id,
    scope: t.scope,
    allProjects: t.allProjects,
    projectIds: t.projects.map((p) => p.projectId),
    grants: t.grants.filter((g): g is TokenGrant => g === "env:write"),
    elevated: false,
  };
}

/** The peer address as the compose network names it (IPv4-mapped form stripped). */
export const peerAddress = (remote: string | undefined): string => (remote ?? "").replace(/^::ffff:/i, "");

/** Internal routes: the bearer must equal the channel token, and the peer must be a listed one. */
export function checkInternal(req: FastifyRequest, internal: InternalAuth | undefined): void {
  const bearer = readBearer(req);
  if (!internal || !bearer || !safeEqual(bearer, internal.token)) throw unauthenticated("Internal routes need the channel token");
  if (internal.peers.length && !internal.peers.includes(peerAddress(req.socket?.remoteAddress))) throw forbidden("Internal routes are not reachable from this peer");
}

/**
 * Applies a route's policy to a request: resolves the caller and checks access, role and scope.
 * Returns null only for anonymous routes. A present bearer selects the token path outright: an
 * invalid one is a 401, never a silent fall back to the cookie.
 */
export async function enforce(db: Db, req: FastifyRequest, web: WebOrigin, policy: Policy, now = new Date(), internal?: InternalAuth): Promise<Actor | null> {
  if (policy.access === "anonymous") return null;
  if (policy.access === "internal") {
    checkInternal(req, internal);
    return null;
  }

  const bearer = readBearer(req);
  if (bearer) {
    if (!policy.token) throw forbidden("API tokens cannot use this route");
    const actor = await tokenActor(db, bearer, now);
    if (!scopeAtLeast(actor.scope, policy.token)) {
      throw new HttpError(403, `This route needs a token with the ${policy.token} scope`, "TOKEN_SCOPE");
    }
    if (policy.grant && !actor.grants.includes(policy.grant)) {
      throw new HttpError(403, `This route needs a token with the ${policy.grant} grant`, "TOKEN_GRANT");
    }
    if (!roleAtLeast(actor.role, policy.role)) throw forbidden();
    return actor;
  }

  const actor = await sessionFromCookie(db, req, web, now);
  if (!actor) throw unauthenticated();
  if (!roleAtLeast(actor.role, policy.role)) throw forbidden();
  if (policy.access === "elevated" && !actor.elevated) throw stepUpRequired();
  return actor;
}

/**
 * The projects a token may touch, or null for no limit (a session, or a token minted for every
 * project). An empty list is a token that reaches nothing: the scope is never implied.
 */
export function tokenProjectLimit(actor: Actor | null): string[] | null {
  if (!actor || actor.kind !== "token" || actor.allProjects) return null;
  return actor.projectIds;
}

/** Handlers call this once they know which project a request touches. */
export function assertProjectScope(actor: Actor, projectId: string): void {
  const limit = tokenProjectLimit(actor);
  if (limit && !limit.includes(projectId)) throw forbidden("This API token is limited to other projects");
}

/**
 * Tokens limited to only this project. Deleting the project cascades their rows away, which
 * leaves them able to reach nothing (never everything: `allProjects` is a column, not an empty
 * list). They are revoked with the project so the token list does not keep dead entries.
 */
export function tokensLimitedOnlyTo(tokens: Array<{ id: string; allProjects: boolean; projects: Array<{ projectId: string }> }>, projectId: string): string[] {
  return tokens
    .filter((t) => !t.allProjects && t.projects.every((p) => p.projectId === projectId))
    .map((t) => t.id);
}
