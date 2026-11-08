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

/** A frontend a project can show the favicon of. */
export interface FaviconApp {
  id: string;
  /** Its display name, else its name. */
  name: string;
  environment: string;
  /** Where its favicon came from. */
  host: string | null;
}

/** What a project's icon is: the folder (the default), the favicon of an app the owner chose, or an upload. */
export type ProjectIconMode = "folder" | "app" | "upload";

/** Projects only: the icon's mode, the app chosen, and the frontends to choose from. */
export interface ProjectFavicon {
  mode: ProjectIconMode;
  /** The app the owner chose, or null. */
  pick: string | null;
  /** The app the shown favicon comes from: the chosen one while it has a favicon, else null. */
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
 * The write the Icon control sends. An app: automatic (its favicon or its kind's default) or an
 * upload as base64. A project: the folder, the favicon of one of its frontends, or an upload.
 */
export type IconBody = { choice: "auto" } | { choice: "folder" } | { choice: "app"; appId: string } | { choice: "upload"; image: string };

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

/** The Icon dropdown's value for a project: the folder, the upload, or the id of the frontend chosen. */
export const PROJECT_FOLDER = "folder";
export const PROJECT_UPLOAD = "upload";

/**
 * What a project's Icon dropdown shows: the current value, and the frontends to choose from. A
 * chosen app that lost its favicon reads as the folder, which is what the project shows then.
 */
export function projectIconPick(state: IconState | undefined): { value: string; apps: FaviconApp[] } {
  const apps = state?.borrow?.apps ?? [];
  const pick = state?.borrow?.pick;
  const value = state?.choice === "upload" ? PROJECT_UPLOAD : pick && apps.some((a) => a.id === pick) ? pick : PROJECT_FOLDER;
  return { value, apps };
}

/** The line under a project's icon: what it is, naming the app ("Favicon of frontend, at brand.example"). */
export function projectIconLine(state: IconState | undefined): string {
  if (state?.choice === "upload") return state.image ? `Uploaded image, ${state.image.width} by ${state.image.height}` : "Uploaded image";
  const from = state?.image ? state.borrow?.apps.find((a) => a.id === state.borrow?.from) : undefined;
  if (!from) return state?.borrow?.pick ? "The folder, while the app chosen has no favicon" : "The folder";
  let host = from.host;
  if (!host && state?.favicon?.origin) {
    try {
      host = new URL(state.favicon.origin).hostname;
    } catch {
      host = null;
    }
  }
  return host ? `Favicon of ${from.name}, at ${host}` : `Favicon of ${from.name}`;
}
