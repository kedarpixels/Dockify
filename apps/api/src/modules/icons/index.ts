/**
 * App and project icons: the map the console reads once, the image routes, and the one write per
 * owner (automatic or an upload). Automatic is a frontend's own favicon; for a project it is the
 * favicon of its production frontend, then of any frontend on a primary domain. Uploads are checked
 * by magic bytes and header size before they are stored, and every image is served only with the
 * type that check found.
 */
import { actorFields, meta } from "../../actor.ts";
import { requireActor } from "../../actor.ts";
import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { checkIconUpload, type EndpointId, type IconState, type SetIconBody } from "@dockify/contracts";
import { internalChannelToken, mailIconKey, verifyMailIcon } from "@dockify/crypto";
import {
  enqueue, iconVersion, projectFavicon, shownAppIcon, shownProjectIcon, SHOWN_APP_ICON, SHOWN_PROJECT_ICON, type IconImageRow, type Prisma,
} from "@dockify/db";
import { assertProjectScope, tokenProjectLimit, type Actor } from "../../actor.ts";
import type { Ctx, Handlers } from "../../app.ts";
import { audit } from "../../audit.ts";
import { HttpError } from "../../errors.ts";

export const ICON_ENDPOINTS = [
  "icons.list", "icons.mail.get", "apps.icon.get", "apps.icon.put", "projects.icon.get", "projects.icon.put",
] as const satisfies readonly EndpointId[];

const APP_ICON = {
  ...SHOWN_APP_ICON,
  name: true, kind: true, faviconCheckedAt: true, faviconError: true,
  environment: { select: { name: true, projectId: true, project: { select: { slug: true } } } },
} as const satisfies Prisma.AppSelect;

/** A project's own upload, and its frontends' favicons to derive Automatic from. */
const PROJECT_ICON = { ...SHOWN_PROJECT_ICON, slug: true } as const satisfies Prisma.ProjectSelect;

type ImageRow = IconImageRow;
type AppRow = Prisma.AppGetPayload<{ select: typeof APP_ICON }>;
type ProjectRow = Prisma.ProjectGetPayload<{ select: typeof PROJECT_ICON }>;

const version = iconVersion;
const refOf = (i: ImageRow | null) => (i ? { version: version(i.sha256), source: i.source, width: i.width, height: i.height } : null);
const appImage = shownAppIcon;
const projectImage = shownProjectIcon;
export { projectFavicon };

export function appStateOf(a: Pick<AppRow, "kind" | "iconChoice" | "icons" | "faviconCheckedAt" | "faviconError">): IconState {
  const fav = a.icons.find((i) => i.source === "favicon") ?? null;
  return {
    choice: a.iconChoice,
    image: refOf(appImage(a)),
    favicon: a.kind === "frontend"
      ? { origin: fav?.origin ?? null, fetchedAt: fav?.updatedAt.toISOString() ?? null, checkedAt: a.faviconCheckedAt?.toISOString() ?? null, error: a.faviconError }
      : null,
  };
}

export function projectStateOf(p: ProjectRow): IconState {
  const fav = projectFavicon(p);
  return {
    choice: p.iconChoice,
    image: refOf(projectImage(p)),
    favicon: fav ? { origin: fav.origin, fetchedAt: fav.updatedAt.toISOString(), checkedAt: null, error: null } : null,
  };
}


async function loadApp(ctx: Ctx, actor: Actor, id: string): Promise<AppRow> {
  const app = await ctx.db.app.findUnique({ where: { id }, select: APP_ICON });
  if (!app) throw new HttpError(404, "App not found", "NOT_FOUND");
  assertProjectScope(actor, app.environment.projectId);
  return app;
}

async function loadProject(ctx: Ctx, actor: Actor, slug: string): Promise<ProjectRow> {
  const project = await ctx.db.project.findUnique({ where: { slug }, select: PROJECT_ICON });
  if (!project) throw new HttpError(404, "Project not found", "NOT_FOUND");
  assertProjectScope(actor, project.id);
  return project;
}

/** Decodes and checks an upload; the base64 must round-trip, so no stray bytes slip past the sniff. */
export function decodeUpload(image: string) {
  const bytes = Buffer.from(image, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== image.replace(/=+$/, "")) {
    throw new HttpError(400, "Send the image as base64", "INVALID_IMAGE", { field: "image" });
  }
  const check = checkIconUpload(bytes);
  if (!check.ok) throw new HttpError(400, check.reason, "INVALID_IMAGE", { field: "image" });
  return { bytes, ...check.image, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Answers with the stored bytes, or a 304 when the browser holds the same ones. */
async function sendRow(row: { mime: string; data: Uint8Array; sha256: string }, cacheControl: string, req: FastifyRequest, reply: FastifyReply) {
  const etag = `"${row.sha256}"`;
  reply.header("Cache-Control", cacheControl);
  reply.header("ETag", etag);
  reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
  if (req.headers["if-none-match"] === etag) {
    await reply.code(304).send();
    return undefined;
  }
  reply.header("Content-Type", row.mime);
  reply.header("Content-Disposition", "inline");
  await reply.code(200).send(Buffer.from(row.data));
  return undefined;
}

/**
 * Sends the shown image, or 404 so the web falls back to the tile, folder or mark. Only with the
 * type the upload check found, inline, sandboxed, never sniffed (the api sets nosniff on every
 * answer), and cached for good only under the version the bytes have now. A webhook's SVG logo
 * goes out this way too, as the document sanitizeSvg rebuilt.
 */
export async function sendImage(ctx: Ctx, shown: ImageRow | null, v: string | undefined, req: FastifyRequest, reply: FastifyReply) {
  const row = shown ? await ctx.db.iconImage.findUnique({ where: { id: shown.id }, select: { mime: true, data: true, sha256: true } }) : null;
  if (!row) throw new HttpError(404, "This icon has no image", "NOT_FOUND");
  return sendRow(row, v === version(row.sha256) ? "private, max-age=31536000, immutable" : "private, no-cache", req, reply);
}

const gone = () => new HttpError(404, "Not found", "NOT_FOUND");

/**
 * The image behind a signed mail icon link (the worker mints them for the emails it sends, see
 * crypto's signMailIcon). Anything but a token this instance signed is a plain 404, never a hint;
 * a good token serves the owner's shown image only while it is still the one the token names, so
 * a link dies the moment the icon changes. Public caching is right here: the URL is unguessable
 * and versioned, so a mail provider's image proxy may keep it for good.
 */
async function sendMailIcon(ctx: Ctx, token: string, req: FastifyRequest, reply: FastifyReply) {
  const ref = verifyMailIcon(mailIconKey(internalChannelToken(ctx.ring)), token);
  if (!ref) throw gone();
  const shown = ref.target === "app"
    ? await ctx.db.app.findUnique({ where: { id: ref.id }, select: SHOWN_APP_ICON }).then((a) => (a ? appImage(a) : null))
    : await ctx.db.project.findUnique({ where: { id: ref.id }, select: SHOWN_PROJECT_ICON }).then((p) => (p ? projectImage(p) : null));
  if (!shown || version(shown.sha256) !== ref.version) throw gone();
  const row = await ctx.db.iconImage.findUnique({ where: { id: shown.id }, select: { mime: true, data: true, sha256: true } });
  if (!row) throw gone();
  return sendRow(row, "public, max-age=31536000, immutable", req, reply);
}

/** Writes the choice for one owner. Automatic drops the stored upload. */
async function writeChoice(ctx: Ctx, body: SetIconBody, owner: { appId: string } | { projectId: string }) {
  const key = "appId" in owner ? { appId: owner.appId } : { projectId: owner.projectId };
  const upload = body.choice === "upload" ? decodeUpload(body.image) : null;
  await ctx.db.$transaction(async (tx) => {
    if (upload) {
      const image = { mime: upload.mime, data: upload.bytes, sha256: upload.sha256, width: upload.width, height: upload.height, origin: null };
      const unique = "appId" in owner ? { appId_source: { appId: owner.appId, source: "upload" as const } } : { projectId_source: { projectId: owner.projectId, source: "upload" as const } };
      await tx.iconImage.upsert({ where: unique, create: { ...key, source: "upload", ...image }, update: image });
    } else {
      await tx.iconImage.deleteMany({ where: { ...key, source: "upload" } });
    }
    const data = { iconChoice: body.choice };
    if ("appId" in owner) await tx.app.update({ where: { id: owner.appId }, data });
    else await tx.project.update({ where: { id: owner.projectId }, data });
  });
  return upload;
}

const changesOf = (upload: ReturnType<typeof decodeUpload> | null) =>
  upload ? { choice: "upload", mime: upload.mime, bytes: upload.bytes.length, width: upload.width, height: upload.height, sha256: upload.sha256 } : { choice: "auto" };

export const iconHandlers: Handlers = {
  "icons.list": async ({ ctx, actor }) => {
    const limit = tokenProjectLimit(requireActor(actor));
    const inScope = limit ? { id: { in: limit } } : {};
    const [apps, projects] = await Promise.all([
      ctx.db.app.findMany({
        where: { environment: { project: inScope }, OR: [{ iconChoice: { not: "auto" } }, { icons: { some: {} } }, { faviconCheckedAt: { not: null } }] },
        select: APP_ICON,
      }),
      ctx.db.project.findMany({
        where: { ...inScope, OR: [{ iconChoice: { not: "auto" } }, { icons: { some: {} } }, { environments: { some: { apps: { some: { kind: "frontend", icons: { some: { source: "favicon" } } } } } } }] },
        select: PROJECT_ICON,
      }),
    ]);
    return {
      apps: Object.fromEntries(apps.map((a) => [a.id, appStateOf(a)])),
      projects: Object.fromEntries(projects.map((p) => [p.slug, projectStateOf(p)])),
    };
  },

  "icons.mail.get": async ({ ctx, params, req, reply }) => sendMailIcon(ctx, params.token, req, reply),

  "apps.icon.get": async ({ ctx, actor, params, query, req, reply }) => {
    const app = await loadApp(ctx, requireActor(actor), params.id);
    return sendImage(ctx, appImage(app), query.v, req, reply);
  },

  "projects.icon.get": async ({ ctx, actor, params, query, req, reply }) => {
    const project = await loadProject(ctx, requireActor(actor), params.slug);
    return sendImage(ctx, projectImage(project), query.v, req, reply);
  },

  "apps.icon.put": async ({ ctx, actor, params, body, req }) => {
    const a = requireActor(actor);
    const app = await loadApp(ctx, a, params.id);
    const upload = await writeChoice(ctx, body, { appId: app.id });
    // Automatic on a frontend means its favicon: fetch it now rather than at the next deploy.
    if (body.choice === "auto" && app.kind === "frontend") {
      await enqueue(ctx.db, { kind: "icon_fetch", lane: "maintenance", payload: { appId: app.id }, dedupeKey: `icon_fetch:${app.id}`, maxAttempts: 1 });
    }
    await audit(ctx.db, {
      category: "config", action: "app.icon", verb: "changed the icon of", ...actorFields(a),
      targetType: "app", targetId: app.id, targetLabel: `${app.environment.project.slug}/${app.environment.name}/${app.name}`,
      changes: changesOf(upload), ...meta(req),
    });
    return appStateOf(await loadApp(ctx, a, app.id));
  },

  "projects.icon.put": async ({ ctx, actor, params, body, req }) => {
    const a = requireActor(actor);
    const project = await loadProject(ctx, a, params.slug);
    const upload = await writeChoice(ctx, body, { projectId: project.id });
    await audit(ctx.db, {
      category: "config", action: "project.icon", verb: "changed the icon of", ...actorFields(a),
      targetType: "project", targetId: project.id, targetLabel: project.slug, changes: changesOf(upload), ...meta(req),
    });
    return projectStateOf(await loadProject(ctx, a, project.slug));
  },
};
