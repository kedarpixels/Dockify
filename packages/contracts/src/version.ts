/**
 * The version of Dockify this process runs: the one baked into its image (DOCKIFY_IMAGE_VERSION, set
 * by deploy/Dockerfile from the release tag). Nothing at runtime can change it, so it is right after
 * an in-app update, which swaps the image and rewrites only release/release.env. DOCKIFY_VERSION in
 * .env is what the installer last installed by hand and goes stale after such an update, so it is
 * read only by an image that has no baked version (a local build or a test).
 */
export const DEV_VERSION = "0.0.0-dev";

export function runningVersion(env: Record<string, string | undefined> = process.env): string {
  return env.DOCKIFY_IMAGE_VERSION?.trim() || env.DOCKIFY_VERSION?.trim() || DEV_VERSION;
}
