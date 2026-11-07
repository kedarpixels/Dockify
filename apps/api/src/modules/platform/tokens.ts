import type { TokenGrant } from "@dockify/contracts";
import { hashToken, newToken } from "@dockify/crypto";
import type { Role, TokenScope } from "@dockify/db";
import { audit } from "../../audit.ts";
import { HttpError, forbidden } from "../../errors.ts";
import { ROLE_RANK, SCOPE_ROLE } from "../../policy.ts";
import type { Handlers } from "../../app.ts";
import { actorAudit, lockArea, reqMeta, requireActor } from "./shared.ts";

export const TOKEN_PREFIX = "dk_";
/** "dk_" plus four characters of the secret: enough to tell tokens apart, never enough to use one. */
export const SHOWN_PREFIX_LEN = TOKEN_PREFIX.length + 4;
export const MAX_ACTIVE_TOKENS = 25;
const DAY_MS = 86_400_000;

export interface MintedToken {
  secret: string;
  hash: string;
  prefix: string;
}

/** A fresh 256-bit secret. Only the hash is stored; the secret is shown once. */
export function mintApiToken(): MintedToken {
  const secret = `${TOKEN_PREFIX}${newToken()}`;
  return { secret, hash: hashToken(secret), prefix: secret.slice(0, SHOWN_PREFIX_LEN) };
}

/** A user may mint a scope only when the scope's role does not exceed their own. */
export function scopeAllowed(role: Role, scope: TokenScope): boolean {
  return ROLE_RANK[SCOPE_ROLE[scope]] <= ROLE_RANK[role];
}

export function expiryFrom(now: Date, days: number | null): Date | null {
  return days === null ? null : new Date(now.getTime() + days * DAY_MS);
}

interface TokenRowIn {
  id: string;
  name: string;
  scope: TokenScope;
  prefix: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  allProjects: boolean;
  grants: string[];
  projects: Array<{ project: { slug: string } }>;
}
const knownGrants = (g: string[]): TokenGrant[] => g.filter((x): x is TokenGrant => x === "env:write");
const toRow = (t: TokenRowIn) => ({
  id: t.id,
  name: t.name,
  scope: t.scope,
  prefix: t.prefix,
  createdAt: t.createdAt.toISOString(),
  expiresAt: t.expiresAt?.toISOString() ?? null,
  lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
  allProjects: t.allProjects,
  projects: t.projects.map((p) => p.project.slug),
  grants: knownGrants(t.grants),
});
const withProjects = { projects: { include: { project: { select: { slug: true } } } } } as const;

export const tokenHandlers: Handlers = {
  /** Your own live tokens. An admin sees everyone's, so a leaked one can be found and revoked. */
  "tokens.list": async ({ actor, ctx }) => {
    const a = requireActor(actor);
    const rows = await ctx.db.apiToken.findMany({
      where: { revokedAt: null, ...(a.role === "admin" ? {} : { userId: a.userId }) },
      include: withProjects,
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toRow);
  },

  "tokens.create": async ({ body, actor, req, ctx }) => {
    const a = requireActor(actor);
    // The policy has no token scope, so a token can never reach this; the check is belt and braces.
    if (a.kind !== "session") throw forbidden("API tokens cannot mint tokens");
    if (!scopeAllowed(a.role, body.scope)) throw forbidden(`Your role cannot create ${body.scope === "admin" ? "an" : "a"} ${body.scope} token`);
    // The project scope is a deliberate choice: "all", or named projects. There is no default.
    const all = body.projects === "all";
    const slugs = all ? [] : [...new Set(body.projects)];
    const grants = [...new Set(body.grants ?? [])];
    if (grants.length && body.scope !== "admin") throw new HttpError(400, "A grant needs the admin scope", "GRANT_NEEDS_ADMIN", { field: "grants" });
    const now = new Date();
    const minted = mintApiToken();

    const row = await ctx.db.$transaction(async (tx) => {
      await lockArea(tx, `tokens:${a.userId}`);
      const live = await tx.apiToken.count({
        where: { userId: a.userId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      });
      if (live >= MAX_ACTIVE_TOKENS) throw new HttpError(409, `At most ${MAX_ACTIVE_TOKENS} active tokens. Revoke one first.`, "TOO_MANY_TOKENS");
      const projects = slugs.length ? await tx.project.findMany({ where: { slug: { in: slugs } }, select: { id: true, slug: true } }) : [];
      const missing = slugs.filter((s) => !projects.some((p) => p.slug === s));
      if (missing.length) throw new HttpError(400, `Unknown project: ${missing.join(", ")}`, "UNKNOWN_PROJECT", { field: "projects" });
      const t = await tx.apiToken.create({
        data: {
          userId: a.userId,
          name: body.name,
          tokenHash: minted.hash,
          prefix: minted.prefix,
          scope: body.scope,
          expiresAt: expiryFrom(now, body.expiresInDays),
          allProjects: all,
          grants,
          projects: { create: projects.map((p) => ({ projectId: p.id })) },
        },
        include: withProjects,
      });
      await audit(tx, {
        category: "access", action: "token.create", verb: "created API token", targetType: "token", targetId: t.id,
        targetLabel: body.name,
        suffix: `${body.scope} scope, ${body.expiresInDays === null ? "no expiry" : `expires in ${body.expiresInDays} days`}, ${all ? "every project" : `limited to ${slugs.join(", ")}`}${grants.length ? `, grants ${grants.join(", ")}` : ""}`,
        ...actorAudit(a), ...reqMeta(req),
      });
      return t;
    });
    return { token: toRow(row), secret: minted.secret };
  },

  "tokens.delete": async ({ params, actor, req, ctx }) => {
    const a = requireActor(actor);
    const t = await ctx.db.apiToken.findUnique({ where: { id: params.id } });
    if (!t || t.revokedAt || (t.userId !== a.userId && a.role !== "admin")) throw new HttpError(404, "Unknown token", "TOKEN_NOT_FOUND");
    await ctx.db.apiToken.update({ where: { id: t.id }, data: { revokedAt: new Date() } });
    await audit(ctx.db, {
      category: "access", action: "token.revoke", verb: "revoked API token", targetType: "token", targetId: t.id,
      targetLabel: t.name, ...actorAudit(a), ...reqMeta(req),
    });
    return undefined;
  },
};
