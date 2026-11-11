// Name rules checked before a request leaves. They mirror packages/contracts/src/common.ts, which
// the web cannot import (apps/web is not a workspace member); the API checks them again.

/** A project slug, as the contracts' Slug: lowercase letters, digits and inner hyphens, 1 to 40 characters. */
export const PROJECT_SLUG = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/** As the contracts' EnvName. The Add environment form asks for a leading letter on top (environments.tsx). */
export const ENV_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** A git branch, as the contracts' Branch: no leading, trailing or double slash and no "..", up to 200 characters. */
export const BRANCH_NAME = /^(?!\/|.*\/\/|.*\.\.|.*\/$)[A-Za-z0-9._/-]{1,200}$/;
export const BRANCH_MESSAGE = "Not a valid branch name";

/** "new" is the New project popup's address (/projects/new), which wins over /projects/[slug]. */
const RESERVED_PROJECT_SLUGS: readonly string[] = ["new"];

export const isReservedProjectSlug = (name: string) => RESERVED_PROJECT_SLUGS.includes(name.trim().toLowerCase());

/** As UNSAFE_TEXT_RANGES in contracts: controls, direction marks and overrides, zero-width and
 * invisible characters. Inclusive code point ranges. */
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

/** As APP_DISPLAY_NAME_MAX in packages/contracts. */
export const APP_DISPLAY_NAME_MAX = 60;

/** The first problem with a display name (a person, a project, a token, the instance, a label), or null. */
export function displayNameProblem(name: string, { max = 100, empty = "Enter a name" }: { max?: number; empty?: string } = {}): string | null {
  const v = name.trim();
  if (!v) return empty;
  if (v.length > max) return `Use ${max} characters or fewer`;
  if (hasUnsafeText(v)) return UNSAFE_TEXT_MESSAGE;
  return null;
}

/** Dockify's own container names and DNS aliases start with this (dk-<app id>, dk-route-<id>), so no app may. */
const RESERVED_NAME_PREFIX = "dk-";
export const RESERVED_NAME_MESSAGE = `Names starting with ${RESERVED_NAME_PREFIX} are reserved for Dockify`;
export const hasReservedPrefix = (name: string): boolean => name.trim().toLowerCase().startsWith(RESERVED_NAME_PREFIX);
/** A managed service's name is its address on the project network, so these are refused. An app called "web" is fine. */
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
