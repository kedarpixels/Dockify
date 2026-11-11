/**
 * Which image an app or a project shows. An app: its upload when chosen, else its favicon. A project: its
 * upload when chosen, else the favicon of the frontend the owner chose, else the folder; it never picks an app itself.
 */
import type { IconChoice, Prisma } from "../generated/client/index.js";

export const ICON_IMAGE = { id: true, source: true, mime: true, sha256: true, width: true, height: true, origin: true, updatedAt: true } as const satisfies Prisma.IconImageSelect;
export type IconImageRow = Prisma.IconImageGetPayload<{ select: typeof ICON_IMAGE }>;

export const SHOWN_APP_ICON = { id: true, iconChoice: true, icons: { select: ICON_IMAGE } } as const satisfies Prisma.AppSelect;

const HOST = { hostname: true, testDomain: true } as const satisfies Prisma.DomainSelect;

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

export function shownAppIcon(a: { iconChoice: IconChoice; icons: IconImageRow[] }): IconImageRow | null {
  return a.icons.find((i) => i.source === (a.iconChoice === "upload" ? "upload" : "favicon")) ?? null;
}

interface RankedHost { hostname: string; testDomain: boolean }

/** Fields past id and icons only order the list. */
export interface FaviconApp {
  id: string;
  name?: string;
  displayName?: string | null;
  createdAt?: Date;
  primaryDomain?: RankedHost | null;
  domains?: RankedHost[];
  icons: IconImageRow[];
}

export interface ProjectIconInput {
  iconChoice: IconChoice;
  iconAppId?: string | null;
  icons: IconImageRow[];
  environments: Array<{ name: string; apps: FaviconApp[] }>;
}

export type FaviconCandidate = FaviconApp & { environment: string; favicon: IconImageRow };

/**
 * A name that spells an address (sslip.io, nip.io, xip.io) is a test domain whatever its row says:
 * not every row has the flag set.
 */
const SPELLED_HOST = /\.(?:sslip|nip|xip)\.io$/i;
export const isCustomHost = (d: RankedHost | null | undefined): boolean => !!d && !d.testDomain && !SPELLED_HOST.test(d.hostname);

/**
 * The order the Icon dropdown lists them: a production frontend whose primary domain is custom, then any
 * frontend with a custom domain (production first), then the rest in the order they were made.
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
  // A total order: the environments come in no set order, and the list must read the same each time.
  return apps
    .map((a) => ({ a, t: tier(a) }))
    .sort((x, y) => x.t - y.t || born(x.a) - born(y.a) || (x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0))
    .map((x) => x.a);
}

/** Null shows the folder: no app chosen, the chosen app deleted, or its favicon gone. */
export function projectFaviconApp(p: Pick<ProjectIconInput, "iconAppId" | "environments">): FaviconCandidate | null {
  if (!p.iconAppId) return null;
  return rankFaviconApps(p).find((a) => a.id === p.iconAppId) ?? null;
}

export function projectFavicon(p: Pick<ProjectIconInput, "iconAppId" | "environments">): IconImageRow | null {
  return projectFaviconApp(p)?.favicon ?? null;
}

export function shownProjectIcon(p: ProjectIconInput): IconImageRow | null {
  return p.iconChoice === "upload" ? (p.icons.find((i) => i.source === "upload") ?? null) : projectFavicon(p);
}

/** A built-in provider shows its own mark instead. */
export const SHOWN_WEBHOOK_ICON = { id: true, provider: true, iconChoice: true, icons: { select: ICON_IMAGE } } as const satisfies Prisma.NotificationWebhookSelect;
export type ShownWebhookIconRow = Prisma.NotificationWebhookGetPayload<{ select: typeof SHOWN_WEBHOOK_ICON }>;

/**
 * Only a generic webhook has a stored image: its logo when chosen, else its site's favicon. Null means the
 * web draws the provider's mark or the generic glyph.
 */
export function shownWebhookIcon(w: Pick<ShownWebhookIconRow, "provider" | "iconChoice" | "icons">): IconImageRow | null {
  if (w.provider !== "generic") return null;
  return w.icons.find((i) => i.source === (w.iconChoice === "upload" ? "upload" : "favicon")) ?? null;
}
