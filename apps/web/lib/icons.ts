import type { AppKind, OverviewSource } from "./types";

/* The default icons and the icon state the API answers (contracts icons.ts), with the same names. */

/** The six default icons. Every kind maps to the nearest one; a frontend's favicon wins over Web. */
export type IconPreset = "web" | "api" | "bot" | "postgres" | "redis" | "minio";

export const KIND_PRESET: Record<AppKind, IconPreset> = {
  frontend: "web",
  backend: "api",
  bot: "bot",
  postgres: "postgres",
  redis: "redis",
  s3: "minio",
};

export type IconChoice = "auto" | "upload";

export interface IconImageRef {
  version: string;
  source: "favicon" | "upload";
  width: number;
  height: number;
}

/** A frontend a project can borrow its favicon from. */
export interface FaviconApp {
  id: string;
  /** Its display name, else its name. */
  name: string;
  environment: string;
  /** Where its favicon came from. */
  host: string | null;
}

/** Projects only: the frontends it can borrow a favicon from, and which one it does. */
export interface ProjectFavicon {
  /** The app the owner picked, or null for the automatic pick. */
  pick: string | null;
  /** The app the automatic pick lands on today. */
  auto: string | null;
  /** The app the shown favicon comes from now. */
  from: string | null;
  /** The most public first. */
  apps: FaviconApp[];
}

export interface IconState {
  choice: IconChoice;
  image: IconImageRef | null;
  favicon: { origin: string | null; fetchedAt: string | null; checkedAt: string | null; error: string | null } | null;
  /** Projects only. */
  borrow?: ProjectFavicon;
}

export interface IconMap {
  apps: Record<string, IconState>;
  projects: Record<string, IconState>;
}

export const EMPTY_ICONS: IconMap = { apps: {}, projects: {} };

/**
 * The write the Icon control sends: automatic, or an upload as base64. A project's automatic may
 * name the frontend whose favicon to show; null goes back to the automatic pick.
 */
export type IconBody = { choice: "auto"; appId?: string | null } | { choice: "upload"; image: string };

/** The answer of one icon write, through app/api/icons. */
export interface IconResult {
  ok: boolean;
  source: OverviewSource;
  error?: string;
  /** The API's status for a refusal (0 when it never answered), which the route answers with. */
  status?: number;
  data?: IconState;
}

export type IconTarget = { target: "app"; id: string } | { target: "project"; slug: string };

export const UPLOAD_MAX_BYTES = 128 * 1024;
export const UPLOAD_MIN_PX = 32;

/** The same-origin URL of an icon image, versioned so the browser may keep it for good. */
export function iconUrl(t: IconTarget, version: string): string {
  const key = t.target === "app" ? `apps/${encodeURIComponent(t.id)}` : `projects/${encodeURIComponent(t.slug)}`;
  return `/api/icons/${key}?v=${version}`;
}

/** The Icon dropdown's value for a project: the upload, the automatic pick, or the id of the frontend picked. */
export const PROJECT_UPLOAD = "upload";
export const PROJECT_AUTO = "auto";

/**
 * What a project's Icon dropdown shows: the current value (a pick whose app lost its favicon reads
 * as Automatic, as the API then borrows the automatic one), the app the automatic pick lands on,
 * and the frontends to pick from.
 */
export function projectIconPick(state: IconState | undefined): { value: string; auto: FaviconApp | null; apps: FaviconApp[] } {
  const apps = state?.borrow?.apps ?? [];
  const pick = state?.borrow?.pick;
  const value = state?.choice === "upload" ? PROJECT_UPLOAD : pick && apps.some((a) => a.id === pick) ? pick : PROJECT_AUTO;
  return { value, auto: apps.find((a) => a.id === state?.borrow?.auto) ?? null, apps };
}

/** The line under a project's icon: where it comes from, naming the app ("Favicon of frontend, at brand.example"). */
export function projectIconLine(state: IconState | undefined): string {
  if (state?.choice === "upload") return state.image ? `Uploaded image, ${state.image.width} by ${state.image.height}` : "Uploaded image";
  if (!state?.image) return "The project folder, until a frontend has a favicon";
  const from = state.borrow?.apps.find((a) => a.id === state.borrow?.from);
  let host = from?.host ?? null;
  if (!host && state.favicon?.origin) {
    try {
      host = new URL(state.favicon.origin).hostname;
    } catch {
      host = null;
    }
  }
  if (from) return host ? `Favicon of ${from.name}, at ${host}` : `Favicon of ${from.name}`;
  return host ? `Favicon from ${host}` : "A frontend’s favicon";
}
