/*
 * Name rules the web checks before a request leaves the browser or this server. They mirror
 * packages/contracts/src/common.ts (the web cannot import it, apps/web is not a workspace member),
 * and the API checks the same rules again.
 */

/** A project slug, as the contracts' Slug: lowercase letters, digits and inner hyphens, 1 to 40 characters. */
export const PROJECT_SLUG = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * An environment name, as the contracts' EnvName: lowercase letters, digits and hyphens, starting
 * with a letter or a digit, up to 32 characters. Every environment the API holds passes it; the Add
 * environment form asks for a leading letter on top (environments.tsx).
 */
export const ENV_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** A git branch, as the contracts' Branch: no leading, trailing or double slash and no "..", up to 200 characters. */
export const BRANCH_NAME = /^(?!\/|.*\/\/|.*\.\.|.*\/$)[A-Za-z0-9._/-]{1,200}$/;
export const BRANCH_MESSAGE = "Not a valid branch name";

/**
 * Project names that can never be taken, as RESERVED_SLUGS in packages/contracts. "new" is the New
 * project popup's own address (/projects/new), which always wins over /projects/[slug], so a project
 * called "new" could never be opened.
 */
const RESERVED_PROJECT_SLUGS: readonly string[] = ["new"];

export const isReservedProjectSlug = (name: string) => RESERVED_PROJECT_SLUGS.includes(name.trim().toLowerCase());

/**
 * Characters no name or label may hold, as UNSAFE_TEXT_RANGES in packages/contracts: C0 and C1
 * controls (a NUL made the API fail), direction marks, embeddings, overrides and isolates (a name
 * that reads in another order than it is stored), and zero-width and invisible characters (two
 * names that look alike). Code point ranges, inclusive.
 */
const UNSAFE_TEXT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], [0x7f, 0x9f], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], [0xfeff, 0xfeff],
];

export function hasUnsafeText(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    for (const [lo, hi] of UNSAFE_TEXT_RANGES) if (c >= lo && c <= hi) return true;
  }
  return false;
}

export const UNSAFE_TEXT_MESSAGE = "Remove control characters, direction marks and invisible characters";

/**
 * The longest display name an app may have, as APP_DISPLAY_NAME_MAX in packages/contracts. An app's
 * display name is what people read; its name stays its identity for links, the CLI and preview addresses.
 */
export const APP_DISPLAY_NAME_MAX = 60;

/** The first problem with a display name (a person, a project, a token, the instance, a label), or null. */
export function displayNameProblem(name: string, { max = 100, empty = "Enter a name" }: { max?: number; empty?: string } = {}): string | null {
  const v = name.trim();
  if (!v) return empty;
  if (v.length > max) return `Use ${max} characters or fewer`;
  if (hasUnsafeText(v)) return UNSAFE_TEXT_MESSAGE;
  return null;
}

/**
 * Dockify's own container names and DNS aliases start with this (dk-<app id>, dk-route-<id>), as
 * RESERVED_NAME_PREFIX in packages/contracts. No app and no database restored as a new service may
 * take a name with it, and the API refuses one with this same message.
 */
const RESERVED_NAME_PREFIX = "dk-";
export const RESERVED_NAME_MESSAGE = `Names starting with ${RESERVED_NAME_PREFIX} are reserved for Dockify`;
export const hasReservedPrefix = (name: string): boolean => name.trim().toLowerCase().startsWith(RESERVED_NAME_PREFIX);
/**
 * Names a managed service may not take, as RESERVED_SERVICE_NAMES in packages/contracts, since its
 * name is its address on the project's network. Only services: an app called "web" is fine.
 */
const RESERVED_SERVICE_NAMES = ["api", "buildkit", "cloudflared", "dockify-proxy", "dockify-worker", "migrate", "postgres", "proxy", "proxy-direct", "socket-proxy", "updater", "web", "worker"];
export const RESERVED_SERVICE_MESSAGE = "Dockify's own services use this name. Try another, such as main-db";
export const isReservedServiceName = (name: string): boolean => RESERVED_SERVICE_NAMES.includes(name.trim().toLowerCase());
export const unreservedServiceName = (name: string): string => (isReservedServiceName(name) ? `${name}-db` : name);

/** The first problem with a new project's name, or null. `taken` lists the slugs already in use. */
export function projectNameProblem(name: string, taken: readonly string[] = []): string | null {
  if (!name) return "Enter a name";
  if (!PROJECT_SLUG.test(name)) return "Lowercase letters, numbers and hyphens, up to 40 characters, not starting or ending with a hyphen";
  if (isReservedProjectSlug(name)) return "That name is reserved";
  if (taken.includes(name)) return `A project called ${name} already exists`;
  return null;
}

/** A plain JSON object: not null and not an array. */
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
