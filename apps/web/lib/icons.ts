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

export interface IconState {
  choice: IconChoice;
  image: IconImageRef | null;
  favicon: { origin: string | null; fetchedAt: string | null; checkedAt: string | null; error: string | null } | null;
}

export interface IconMap {
  apps: Record<string, IconState>;
  projects: Record<string, IconState>;
}

export const EMPTY_ICONS: IconMap = { apps: {}, projects: {} };

/** The write the Icon control sends: automatic, or an upload as base64. */
export type IconBody = { choice: "auto" } | { choice: "upload"; image: string };

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
