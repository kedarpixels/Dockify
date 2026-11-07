/**
 * What the worker has to know about a build without having a builder: whose cache it uses, whether a
 * checkout has a Dockerfile, and what port a detected framework serves on. The worker reads these
 * before it asks a server's Builder for anything (server/runtime.ts), and the builder reads them too.
 */
import { PermanentDeployError } from "./errors.ts";
import { insideCheckout } from "./checkout.ts";

/**
 * The namespace of a build's cache. Per app, so one app cannot seed another's package cache. Every
 * preview gets its own, per pull request: a package a PR put in the shared cache would run in the next
 * production build, and pushing to a branch must not be enough for that. A scope that is not the app's
 * also keys the build's RUN layers apart (planBuild, planRailpackBuild), and teardown reclaims it by
 * name. App ids and preview ids are uuids, so no scope can read as another.
 */
export const buildCacheScope = (appId: string, preview: { envId: string; fromFork: boolean } | null): string =>
  !preview ? `dockify-app-${appId}` : `${preview.fromFork ? "dockify-fork" : "dockify-preview"}-${preview.envId}`;

const DEFAULT_DOCKERFILE = "Dockerfile";

/** Where a Dockerfile may be, first hit wins: the path under the root directory, then from the top of the repository. */
export function dockerfileCandidates(rootDir: string, dockerfilePath: string): string[] {
  const name = dockerfilePath || DEFAULT_DOCKERFILE;
  const under = [rootDir, name].filter(Boolean).join("/");
  return under === name ? [name] : [under, name];
}

/** The repository-relative path of the Dockerfile to use, or null when there is none. Refuses one that is a symlink or leaves the checkout. */
export async function findDockerfile(checkoutDir: string, rootDir: string, dockerfilePath: string): Promise<string | null> {
  for (const rel of dockerfileCandidates(rootDir, dockerfilePath)) {
    try {
      await insideCheckout(checkoutDir, rel);
      return rel;
    } catch (e) {
      if (e instanceof PermanentDeployError && /does not exist/.test(e.message)) continue;
      throw e;
    }
  }
  return null;
}

/**
 * The port a repository probably serves on. Dockify passes it as PORT, which Railpack's servers and
 * most frameworks read, so this mainly matters to an app that picks a fixed port of its own.
 */
export function plannedPort(o: { framework: string | null; provider: string | null }): number | null {
  if (o.framework === "Django" || o.framework === "Flask" || o.framework === "FastAPI" || o.provider === "python") return 8000;
  if (o.provider === "golang" || o.provider === "java" || o.provider === "dotnet" || o.provider === "rust") return 8080;
  if (o.provider === "elixir") return 4000;
  if (o.provider === "php") return 80;
  return o.provider ? 3000 : null;
}
