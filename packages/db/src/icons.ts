/**
 * Which image an app or a project shows as its icon. The api serves and lists icons by this rule
 * and the worker signs mail icon links by it, so it lives here, next to the client both import:
 * an app shows its upload when chosen, else its favicon; a project shows its upload when chosen,
 * else the favicon of its production frontend, then of any frontend on a primary domain. The
 * served URL is versioned by the image's sha256 prefix, so it can be cached for good.
 */
import type { IconChoice, Prisma } from "../generated/client/index.js";

export const ICON_IMAGE = { id: true, source: true, sha256: true, width: true, height: true, origin: true, updatedAt: true } as const satisfies Prisma.IconImageSelect;
export type IconImageRow = Prisma.IconImageGetPayload<{ select: typeof ICON_IMAGE }>;

/** What decides an app's shown icon. */
export const SHOWN_APP_ICON = { id: true, iconChoice: true, icons: { select: ICON_IMAGE } } as const satisfies Prisma.AppSelect;

/** What decides a project's shown icon: its own upload, and its frontends' favicons to borrow while automatic. */
export const SHOWN_PROJECT_ICON = {
  id: true, iconChoice: true,
  icons: { select: ICON_IMAGE },
  environments: {
    select: {
      name: true,
      apps: { where: { kind: "frontend" as const }, orderBy: { createdAt: "asc" as const }, select: { id: true, primaryDomainId: true, icons: { where: { source: "favicon" as const }, select: ICON_IMAGE } } },
    },
  },
} as const satisfies Prisma.ProjectSelect;

export type ShownAppIconRow = Prisma.AppGetPayload<{ select: typeof SHOWN_APP_ICON }>;
export type ShownProjectIconRow = Prisma.ProjectGetPayload<{ select: typeof SHOWN_PROJECT_ICON }>;

/** The served URL's version: a sha256 prefix, so it changes whenever the bytes do. */
export const iconVersion = (sha256: string): string => sha256.slice(0, 12);

/** The image an app shows: its upload when chosen, its favicon while automatic. */
export function shownAppIcon(a: { iconChoice: IconChoice; icons: IconImageRow[] }): IconImageRow | null {
  return a.icons.find((i) => i.source === (a.iconChoice === "upload" ? "upload" : "favicon")) ?? null;
}

/** The favicon a project borrows while automatic: production frontends first, then one on a primary domain. */
export function projectFavicon(p: Pick<ShownProjectIconRow, "environments">): IconImageRow | null {
  const apps = p.environments.flatMap((e) => e.apps.map((a) => ({ ...a, production: e.name === "production" })));
  const rank = (a: (typeof apps)[number]) => (a.production ? 0 : 2) + (a.primaryDomainId ? 0 : 1);
  for (const a of [...apps].sort((x, y) => rank(x) - rank(y))) {
    const fav = a.icons[0];
    if (fav) return fav;
  }
  return null;
}

/** The image a project shows: its upload when chosen, else a borrowed favicon. */
export function shownProjectIcon(p: Pick<ShownProjectIconRow, "iconChoice" | "icons" | "environments">): IconImageRow | null {
  return p.iconChoice === "upload" ? (p.icons.find((i) => i.source === "upload") ?? null) : projectFavicon(p);
}

/** What decides a notification webhook's shown image. A built-in provider shows its own mark instead. */
export const SHOWN_WEBHOOK_ICON = { id: true, provider: true, iconChoice: true, icons: { select: ICON_IMAGE } } as const satisfies Prisma.NotificationWebhookSelect;
export type ShownWebhookIconRow = Prisma.NotificationWebhookGetPayload<{ select: typeof SHOWN_WEBHOOK_ICON }>;

/**
 * The stored image a webhook shows: only a generic webhook has one, its logo (uploaded or
 * downloaded from the owner's link) when chosen, else its site's favicon. Null means the web draws
 * the provider's mark, or the generic webhook glyph.
 */
export function shownWebhookIcon(w: Pick<ShownWebhookIconRow, "provider" | "iconChoice" | "icons">): IconImageRow | null {
  if (w.provider !== "generic") return null;
  return w.icons.find((i) => i.source === (w.iconChoice === "upload" ? "upload" : "favicon")) ?? null;
}
