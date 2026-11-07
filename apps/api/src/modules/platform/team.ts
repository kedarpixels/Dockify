import { hashToken, newToken } from "@dockify/crypto";
import { auth as A } from "@dockify/contracts";
import type { Invite, Role, Tx } from "@dockify/db";
import { invite as inviteEmail } from "@dockify/email";
import { audit } from "../../audit.ts";
import { allowRecipient, emailEnabled, instanceName, queueEmailTx } from "../../mailer.ts";
import { HttpError, forbidden, isUniqueViolation } from "../../errors.ts";
import { ROLE_RANK } from "../../policy.ts";
import type { Ctx, Handlers } from "../../app.ts";
import { actorAudit, lockArea, reqMeta, requireActor } from "./shared.ts";

export const INVITE_TTL_MS = 7 * 24 * 3600_000;
/** Pending invites at once; a runaway script cannot fill the table. */
export const MAX_PENDING_INVITES = 50;

export interface MemberRef {
  userId: string;
  name: string;
  role: Role;
  githubLogin?: string | null;
  githubVerified?: boolean;
}
export type TeamChange =
  | { id: string; role: Role }
  | { id: string; remove: true }
  | { id: string; githubVerified: boolean }
  | { id: string; githubLogin: null };
export interface TeamPlan {
  roles: Array<{ userId: string; name: string; from: Role; to: Role }>;
  removals: Array<{ userId: string; name: string; role: Role }>;
  github: Array<{ userId: string; name: string; login: string; from: boolean; verified: boolean }>;
  unlinks: Array<{ userId: string; name: string; login: string; verified: boolean }>;
}

/**
 * Validates a batch of team changes against the current members, as one unit:
 * ids are user ids, each at most once; nobody removes themselves; and at least one admin remains, so the last admin can be neither
 * removed nor demoted (themselves included). Only admins reach this (team.change is elevated:admin).
 */
export function planTeamChanges(members: MemberRef[], changes: TeamChange[], actorUserId: string): TeamPlan {
  const byId = new Map(members.map((m) => [m.userId, m]));
  const seen = new Set<string>();
  const plan: TeamPlan = { roles: [], removals: [], github: [], unlinks: [] };
  const finalRole = new Map(members.map((m) => [m.userId, m.role as Role | null]));

  for (const c of changes) {
    if (seen.has(c.id)) throw new HttpError(400, "Each member can appear once per change", "DUPLICATE_MEMBER");
    seen.add(c.id);
    const m = byId.get(c.id);
    if (!m) throw new HttpError(404, "That member is not on the team", "MEMBER_NOT_FOUND");
    if ("remove" in c) {
      if (c.id === actorUserId) throw new HttpError(400, "You cannot remove yourself", "SELF_REMOVE");
      plan.removals.push({ userId: m.userId, name: m.name, role: m.role });
      finalRole.set(m.userId, null);
    } else if ("githubLogin" in c) {
      if (m.githubLogin) plan.unlinks.push({ userId: m.userId, name: m.name, login: m.githubLogin, verified: !!m.githubVerified });
    } else if ("githubVerified" in c) {
      if (!m.githubLogin) throw new HttpError(409, "That member has not linked a GitHub login", "NO_GITHUB_LOGIN");
      if (c.githubVerified !== !!m.githubVerified) plan.github.push({ userId: m.userId, name: m.name, login: m.githubLogin, from: !!m.githubVerified, verified: c.githubVerified });
    } else if (c.role !== m.role) {
      plan.roles.push({ userId: m.userId, name: m.name, from: m.role, to: c.role });
      finalRole.set(m.userId, c.role);
    }
  }
  if (![...finalRole.values()].some((r) => r === "admin")) {
    throw new HttpError(409, "At least one admin is required", "LAST_ADMIN");
  }
  return plan;
}

/** Whether an actor of `actorRole` may hand out `role` in an invite: never above their own. */
export function canInvite(actorRole: Role, role: Role): boolean {
  return ROLE_RANK[role] <= ROLE_RANK[actorRole];
}

export const inviteUrl = (publicOrigin: string, token: string) => `${publicOrigin.replace(/\/+$/, "")}/invite/${token}`;

const inviteView = (i: Invite) => ({
  id: i.id,
  email: i.email,
  role: i.role,
  createdAt: i.createdAt.toISOString(),
  expiresAt: i.expiresAt.toISOString(),
  emailStatus: A.InviteEmailStatus.safeParse(i.emailStatus).data ?? null,
  emailError: i.emailError,
});

async function loadTeam(ctx: Ctx, now = new Date()) {
  const [members, invites] = await Promise.all([
    ctx.db.member.findMany({ include: { user: true }, orderBy: { joinedAt: "asc" } }),
    ctx.db.invite.findMany({ where: { usedAt: null, revokedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: "desc" } }),
  ]);
  return {
    members: members.map((m) => ({
      id: m.userId,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      avatarUrl: m.user.avatarUrl,
      joinedAt: m.joinedAt.toISOString(),
      githubLogin: m.user.githubLogin,
      githubVerified: !!m.user.githubLogin && !!m.user.githubVerifiedAt,
    })),
    invites: invites.map(inviteView),
  };
}

/**
 * Queues the invite email when email is set. Best effort: the copy link is already in the answer,
 * so a missing integration, a busy recipient or a queue failure only turns `emailed` false. True
 * means queued, not delivered: the worker writes what became of it on the invite row.
 */
async function sendInvite(ctx: Ctx, inviteId: string, to: string, v: { invitedBy: string; role: string; url: string }): Promise<boolean> {
  if (!(await emailEnabled(ctx.db)) || !allowRecipient(ctx.limits, to)) return false;
  const message = inviteEmail({ instanceName: await instanceName(ctx.db), origin: ctx.config.publicUrl.origin, ...v, days: Math.round(INVITE_TTL_MS / 86_400_000) });
  try {
    await ctx.db.$transaction(async (tx) => {
      await tx.invite.update({ where: { id: inviteId }, data: { emailStatus: "queued", emailError: null } });
      await queueEmailTx(tx, ctx.ring, to, message, { inviteId });
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ends the open invites someone made, when they lose the power to make them. An invite outlives its
 * maker (invitedById goes null with the user), so a removed admin could otherwise come back through a
 * link they kept. Runs before the user row goes, while the rows still name them.
 */
async function revokeInvitesFrom(tx: Tx, userId: string, name: string, a: ReturnType<typeof requireActor>, req: Parameters<typeof reqMeta>[0]): Promise<void> {
  const { count } = await tx.invite.updateMany({ where: { invitedById: userId, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  if (!count) return;
  await audit(tx, {
    category: "access", action: "team.invite.revoke", verb: "revoked the open invites from", targetType: "user", targetId: userId,
    targetLabel: name, suffix: `(${count})`, ...actorAudit(a), ...reqMeta(req),
  });
}

export const teamHandlers: Handlers = {
  "team.get": async ({ ctx }) => loadTeam(ctx),

  "team.change": async ({ body, actor, req, ctx }) => {
    const a = requireActor(actor);
    await ctx.db.$transaction(async (tx) => {
      await lockArea(tx, "team");
      const rows = await tx.member.findMany({ include: { user: { select: { name: true, githubLogin: true, githubVerifiedAt: true } } } });
      const plan = planTeamChanges(
        rows.map((r) => ({ userId: r.userId, name: r.user.name, role: r.role, githubLogin: r.user.githubLogin, githubVerified: !!r.user.githubVerifiedAt })),
        body.changes,
        a.userId,
      );
      for (const r of plan.roles) {
        await tx.member.update({ where: { userId: r.userId }, data: { role: r.to } });
        // A demotion must not leave a step-up window open at the old privilege.
        if (ROLE_RANK[r.to] < ROLE_RANK[r.from]) {
          await tx.session.updateMany({ where: { userId: r.userId }, data: { elevatedUntil: null } });
          await revokeInvitesFrom(tx, r.userId, r.name, a, req);
        }
        await audit(tx, {
          category: "access", action: "team.role", verb: "changed the role of", targetType: "user", targetId: r.userId,
          targetLabel: r.name, suffix: `to ${r.to}`, changes: [{ key: "role", before: r.from, after: r.to }],
          ...actorAudit(a), ...reqMeta(req),
        });
      }
      for (const g of plan.github) {
        await tx.user.update({ where: { id: g.userId }, data: { githubVerifiedAt: g.verified ? new Date() : null } });
        await audit(tx, {
          category: "access", action: g.verified ? "team.github.verify" : "team.github.unverify",
          verb: g.verified ? "approved the GitHub login of" : "withdrew approval of the GitHub login of",
          targetType: "user", targetId: g.userId, targetLabel: g.name, suffix: `(${g.login})`,
          changes: [{ key: "githubVerified", before: g.from, after: g.verified }], ...actorAudit(a), ...reqMeta(req),
        });
      }
      for (const u of plan.unlinks) {
        await tx.user.update({ where: { id: u.userId }, data: { githubLogin: null, githubVerifiedAt: null } });
        await audit(tx, {
          category: "access", action: "team.github.unlink", verb: "removed the GitHub link of",
          targetType: "user", targetId: u.userId, targetLabel: u.name, suffix: `(${u.login}${u.verified ? "" : ", unverified"})`,
          changes: [{ key: "githubLogin", before: u.login, after: null }], ...actorAudit(a), ...reqMeta(req),
        });
      }
      for (const r of plan.removals) {
        await revokeInvitesFrom(tx, r.userId, r.name, a, req);
        // Deleting the user cascades its member row, sessions, trusted devices and API tokens.
        await tx.user.delete({ where: { id: r.userId } });
        await audit(tx, {
          category: "access", action: "team.remove", verb: "removed", targetType: "user", targetId: r.userId,
          targetLabel: r.name, suffix: `(${r.role}) from the team`, ...actorAudit(a), ...reqMeta(req),
        });
      }
    });
    return loadTeam(ctx);
  },

  "team.invites.create": async ({ body, actor, req, ctx }) => {
    const a = requireActor(actor);
    if (!canInvite(a.role, body.role)) throw forbidden("You cannot invite someone above your own role");
    const email = body.email.toLowerCase();
    const token = newToken();
    const now = new Date();
    const invite = await ctx.db.$transaction(async (tx) => {
      await lockArea(tx, "team");
      if (await tx.user.findUnique({ where: { email }, select: { id: true } })) {
        throw new HttpError(409, "Someone with that email is already on the team", "ALREADY_MEMBER", { field: "email" });
      }
      // One live link per email: a new invite revokes the previous one.
      await tx.invite.updateMany({ where: { email, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
      const pending = await tx.invite.count({ where: { usedAt: null, revokedAt: null, expiresAt: { gt: now } } });
      if (pending >= MAX_PENDING_INVITES) throw new HttpError(409, "Too many open invites. Revoke some first.", "TOO_MANY_INVITES");
      const team = await tx.team.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
      if (!team) throw new HttpError(409, "Finish setup first", "NO_TEAM");
      const row = await tx.invite.create({
        data: { teamId: team.id, email, role: body.role, tokenHash: hashToken(token), invitedById: a.userId, expiresAt: new Date(now.getTime() + INVITE_TTL_MS) },
      });
      await audit(tx, {
        category: "access", action: "team.invite", verb: "invited", targetType: "invite", targetId: row.id,
        targetLabel: email, suffix: `as ${body.role}`, ...actorAudit(a), ...reqMeta(req),
      });
      return row;
    }).catch((e: unknown) => {
      if (isUniqueViolation(e)) throw new HttpError(409, "Try again", "CONFLICT");
      throw e;
    });
    const url = inviteUrl(ctx.config.publicUrl.origin, token);
    const emailed = body.send === true ? await sendInvite(ctx, invite.id, email, { invitedBy: a.name, role: body.role, url }) : false;
    return {
      // The raw token exists only in this response and, when asked, in the sealed invite email.
      url,
      invite: inviteView({ ...invite, emailStatus: emailed ? "queued" : null }),
      emailed,
    };
  },

  "team.invites.delete": async ({ params, actor, req, ctx }) => {
    const a = requireActor(actor);
    const row = await ctx.db.invite.findUnique({ where: { id: params.id } });
    if (!row || row.revokedAt || row.usedAt) throw new HttpError(404, "That invite is not open", "INVITE_NOT_FOUND");
    if (!canInvite(a.role, row.role)) throw forbidden();
    await ctx.db.invite.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    await audit(ctx.db, {
      category: "access", action: "team.invite.revoke", verb: "revoked the invite for", targetType: "invite", targetId: row.id,
      targetLabel: row.email, ...actorAudit(a), ...reqMeta(req),
    });
    return undefined;
  },
};
