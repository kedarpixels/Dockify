/**
 * The version baked into the image (DOCKIFY_IMAGE_VERSION), which stays right after an in-app update.
 * DOCKIFY_VERSION in .env goes stale then, so only an image with no baked version (local build, test) reads it.
 */
export const DEV_VERSION = "0.0.0-dev";

export function runningVersion(env: Record<string, string | undefined> = process.env): string {
  return env.DOCKIFY_IMAGE_VERSION?.trim() || env.DOCKIFY_VERSION?.trim() || DEV_VERSION;
}
