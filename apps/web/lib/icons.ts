import type { OverviewSource } from "./types";

/* The default icons and the icon state the API answers (contracts icons.ts), with the same names. */

/** The default icons: one per kind, then what a published image is (lib/app-role.ts). An upload or a favicon wins over any of them. */
export type IconPreset =
  | "web" | "api" | "bot" | "postgres" | "redis" | "minio"
  | "storage" | "monitor" | "uptimekuma" | "notify" | "ntfy" | "notes" | "reader" | "service";

export type IconChoice = "auto" | "upload";

export interface IconImageRef {
  version: string;
  source: "favicon" | "upload";
  width: number;
  height: number;
}

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

export interface ProjectFavicon {
  mode: ProjectIconMode;
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
  /** The published image of every app that runs one, by app id, so a row that carries only a kind can still say what the app is. */
  stock: Record<string, string>;
}

export const EMPTY_ICONS: IconMap = { apps: {}, projects: {}, stock: {} };

/** An upload travels as base64. */
export type IconBody = { choice: "auto" } | { choice: "folder" } | { choice: "app"; appId: string } | { choice: "upload"; image: string };

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

/** A chosen app that lost its favicon reads as the folder, which is what the project shows then. */
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
