import type { ActivityLog, Prisma } from "@dockify/db";
import { HttpError } from "../../errors.ts";
import type { Handlers } from "../../app.ts";
import { actorKind, avatarOf, peopleOf, pushAuthor, type People } from "../../actor-view.ts";

export const ACTIVITY_PAGE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keyset cursor "<epoch ms>~<id>": stable under inserts, unlike an offset. */
export function encodeCursor(row: { at: Date; id: string }): string {
  return `${row.at.getTime()}~${row.id}`;
}

export function decodeCursor(raw: string): { at: Date; id: string } {
  const [ms, id, extra] = raw.split("~");
  const n = Number(ms);
  if (extra !== undefined || !ms || !/^\d{1,15}$/.test(ms) || !Number.isSafeInteger(n) || !id || !UUID.test(id)) {
    throw new HttpError(400, "Invalid cursor", "INVALID_CURSOR");
  }
  return { at: new Date(n), id };
}

/** Rows strictly older than the cursor in (at desc, id desc) order. */
export function afterCursor(c: { at: Date; id: string }): Prisma.ActivityLogWhereInput {
  return { OR: [{ at: { lt: c.at } }, { at: c.at, id: { lt: c.id } }] };
}

interface Change {
  key: string;
  before: string | null;
  after: string | null;
}
export function parseChanges(raw: unknown): Change[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Change[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    if (typeof o.key !== "string") continue;
    const v = (x: unknown) => (x === null || x === undefined ? null : String(x));
    out.push({ key: o.key, before: v(o.before), after: v(o.after) });
  }
  return out.length ? out : undefined;
}

export function toEvent(r: ActivityLog, people: People) {
  const changes = parseChanges(r.changes);
  // System rows, and webhook rows nobody linked, have no person behind them; the web shows "Dockify".
  const author = pushAuthor(r, people);
  const actor = author
    ? { ...author, kind: "user" as const }
    : r.actorType === "user" || r.actorType === "token"
      ? { id: r.actorId ?? "", name: r.actorName ?? "Unknown", avatarUrl: avatarOf(r, people), kind: actorKind(r.actorType) }
      : null;
  return {
    id: r.id,
    at: r.at.toISOString(),
    category: r.category,
    action: r.action,
    actor,
    verb: r.verb,
    target: r.targetLabel ? { label: r.targetLabel, href: r.targetHref ?? null } : null,
    suffix: r.suffix ?? null,
    tone: r.failed ? ("bad" as const) : null,
    ip: r.ip,
    location: null,
    ...(changes ? { changes } : {}),
  };
}

export const activityHandlers: Handlers = {
  "activity.list": async ({ query, ctx }) => {
    const where: Prisma.ActivityLogWhereInput[] = [];
    if (query.category) where.push({ category: query.category });
    if (query.actor) {
      // A member's pushes count as theirs once their linked GitHub login is verified.
      const user = UUID.test(query.actor) ? await ctx.db.user.findUnique({ where: { id: query.actor }, select: { githubLogin: true, githubVerifiedAt: true } }) : null;
      const linked = user?.githubVerifiedAt ? user.githubLogin : null;
      where.push(linked ? { OR: [{ actorId: query.actor }, { actorType: "webhook", gitAuthor: linked }] } : { actorId: query.actor });
    }
    if (query.q) {
      const q = query.q.trim();
      if (q) {
        where.push({
          OR: ["verb", "action", "targetLabel", "actorName", "suffix"].map((f) => ({ [f]: { contains: q, mode: "insensitive" as const } })),
        });
      }
    }
    if (query.cursor) where.push(afterCursor(decodeCursor(query.cursor)));

    const [rows, members] = await Promise.all([
      ctx.db.activityLog.findMany({ where: { AND: where }, orderBy: [{ at: "desc" }, { id: "desc" }], take: ACTIVITY_PAGE + 1 }),
      ctx.db.member.findMany({ include: { user: { select: { id: true, name: true, avatarUrl: true, githubLogin: true, githubVerifiedAt: true } } }, orderBy: { joinedAt: "asc" } }),
    ]);
    const people = peopleOf(members.map((m) => m.user));
    const more = rows.length > ACTIVITY_PAGE;
    const page = more ? rows.slice(0, ACTIVITY_PAGE) : rows;
    const last = page.at(-1);
    return {
      items: page.map((r) => toEvent(r, people)),
      nextCursor: more && last ? encodeCursor(last) : null,
      // The actor filter lists the people on the team; former members still match by id.
      actors: members.map((m) => ({ id: m.user.id, name: m.user.name, avatarUrl: m.user.avatarUrl, kind: "user" as const })),
    };
  },
};
