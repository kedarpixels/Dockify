/**
 * Which image an app or a project shows as its icon. The api serves and lists icons by this rule
 * and the worker signs mail icon links by it, so it lives here, next to the client both import:
 * an app shows its upload when chosen, else its favicon; a project shows its upload when chosen,
 * else the favicon of the frontend the owner picked, else of its most public frontend (see
 * rankFaviconApps). The served URL is versioned by the image's sha256 prefix, so it can be cached
 * for good.
 */
import type { IconChoice, Prisma } from "../generated/client/index.js";

export const ICON_IMAGE = { id: true, source: true, sha256: true, width: true, height: true, origin: true, updatedAt: true } as const satisfies Prisma.IconImageSelect;
export type IconImageRow = Prisma.IconImageGetPayload<{ select: typeof ICON_IMAGE }>;

/** What decides an app's shown icon. */
export const SHOWN_APP_ICON = { id: true, iconChoice: true, icons: { select: ICON_IMAGE } } as const satisfies Prisma.AppSelect;

const HOST = { hostname: true, testDomain: true } as const satisfies Prisma.DomainSelect;

/**
 * What decides a project's shown icon: its own upload, the frontend the owner picked, and its
 * frontends' favicons to borrow while automatic, with the domains that rank them.
 */
export const SHOWN_PROJECT_ICON = {
  id: true, iconChoice: true, iconAppId: true,
  icons: { select: ICON_IMAGE },
  environments: {
    select: {
      name: true,
      apps: {
        where: { kind: "frontend" as const },
        orderBy: { createdAt: "asc" as const },
        select: {
          id: true, name: true, displayName: true, createdAt: true,
          primaryDomain: { select: HOST },
          domains: { select: HOST },
          icons: { where: { source: "favicon" as const }, select: ICON_IMAGE },
        },
      },
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

/** A domain as the favicon ranking reads it. */
interface RankedHost { hostname: string; testDomain: boolean }

/** A frontend a project may borrow its favicon from. Fields past id and icons only rank it. */
export interface FaviconApp {
  id: string;
  name?: string;
  displayName?: string | null;
  createdAt?: Date;
  primaryDomain?: RankedHost | null;
  domains?: RankedHost[];
  icons: IconImageRow[];
}

/** What the project rules read: the choice, the picked app, the upload, and every frontend by environment. */
export interface ProjectIconInput {
  iconChoice: IconChoice;
  iconAppId?: string | null;
  icons: IconImageRow[];
  environments: Array<{ name: string; apps: FaviconApp[] }>;
}

/** A frontend with its favicon and its environment, as the project rules hand it out. */
export type FaviconCandidate = FaviconApp & { environment: string; favicon: IconImageRow };

/**
 * A free name that spells an address (sslip.io, nip.io, xip.io) is a test domain whatever its row
 * says: older rows and hand-added ones never had the flag set.
 */
const SPELLED_HOST = /\.(?:sslip|nip|xip)\.io$/i;
export const isCustomHost = (d: RankedHost | null | undefined): boolean => !!d && !d.testDomain && !SPELLED_HOST.test(d.hostname);

/**
 * Every frontend of the project that has a fetched favicon, the most public first: a production
 * frontend whose primary domain is a custom one (the site people visit), then any frontend with a
 * custom domain (production first), then the rest in the order they were made. An admin panel on a test domain so
 * never wins over the public site.
 */
export function rankFaviconApps(p: Pick<ProjectIconInput, "environments">): FaviconCandidate[] {
  const apps = p.environments.flatMap((e) =>
    e.apps.flatMap((a) => (a.icons[0] ? [{ ...a, environment: e.name, favicon: a.icons[0] }] : [])),
  );
  const tier = (a: FaviconCandidate) => {
    const production = a.environment === "production";
    if (production && isCustomHost(a.primaryDomain)) return 0;
    if (isCustomHost(a.primaryDomain) || (a.domains ?? []).some(isCustomHost)) return production ? 1 : 2;
    return 3;
  };
  const born = (a: FaviconCandidate) => a.createdAt?.getTime() ?? 0;
  // A total order: the environments come in no set order, and the icon map and the image route
  // must land on the same app, or the map's version names one image while the route serves another.
  return apps
    .map((a) => ({ a, t: tier(a) }))
    .sort((x, y) => x.t - y.t || born(x.a) - born(y.a) || (x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0))
    .map((x) => x.a);
}

/**
 * The frontend whose favicon a project shows while automatic: the one the owner picked while it
 * still has a favicon, else the most public one (rankFaviconApps). Null when no frontend has one.
 */
export function projectFaviconApp(p: Pick<ProjectIconInput, "iconAppId" | "environments">): FaviconCandidate | null {
  const ranked = rankFaviconApps(p);
  return (p.iconAppId ? ranked.find((a) => a.id === p.iconAppId) : undefined) ?? ranked[0] ?? null;
}

/** The favicon a project borrows while automatic (projectFaviconApp's). */
export function projectFavicon(p: Pick<ProjectIconInput, "iconAppId" | "environments">): IconImageRow | null {
  return projectFaviconApp(p)?.favicon ?? null;
}

/** The image a project shows: its upload when chosen, else a borrowed favicon. */
export function shownProjectIcon(p: ProjectIconInput): IconImageRow | null {
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
