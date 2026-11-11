/** Image apps: the worker tells the server's Docker to pull, and pins what came. */
import type { Db, SecretVault } from "@dockify/db";
import { DockerError, isNotFound, type DockerApi, type ImageInfo } from "@dockify/engine";
import { PermanentDeployError } from "@dockify/engine";
import { repoDigestFor, repositoryOf } from "../data/images.ts";
import { registryAuthFor, RegistryAuthError, xRegistryAuth } from "../integrations/registry-auth.ts";
import type { DeployLog } from "./log.ts";

/** The X-Registry-Auth of an image app's pull, or null for a public one. Credentials that cannot apply fail the deploy with their reason. */
export async function pullAuth(db: Db, vault: SecretVault, registryId: string | null, image: string): Promise<string | null> {
  try {
    const auth = await registryAuthFor(db, vault, registryId, image);
    return auth ? xRegistryAuth(auth) : null;
  } catch (e) {
    throw e instanceof RegistryAuthError ? new PermanentDeployError(e.message) : e;
  }
}

/** A pull that can never succeed as asked (no such image, or a refusal). Permanent: a retry gets the same answer. */
export function pullFailure(ref: string, e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  if (/manifest unknown|manifest for \S+ not found|not found: manifest|name unknown|no such image|repository name not known/i.test(msg)) {
    return new PermanentDeployError(`The image ${ref} was not found. Check the image name and tag.`);
  }
  if (/pull access denied|repository does not exist|requested access to the resource is denied|unauthorized|authentication required|access forbidden/i.test(msg)) {
    return new PermanentDeployError(`The registry refused to send ${ref}: the image does not exist, or it is private and needs registry credentials.`);
  }
  // The agent's gate (apps/agent/src/registry-host.ts): asking again gets the same answer, in these words.
  if (/Dockify does not pull from|is not a registry host/.test(msg)) return new PermanentDeployError(`${ref} cannot be pulled. ${msg}`);
  if (/invalid reference format/i.test(msg)) {
    return new PermanentDeployError(`${ref} is not a valid image reference.`);
  }
  if (e instanceof DockerError && e.status === 404) {
    return new PermanentDeployError(`The image ${ref} was not found. Check the image name and tag.`);
  }
  return e instanceof Error ? e : new Error(msg);
}

async function localCopy(docker: DockerApi, ref: string): Promise<ImageInfo | null> {
  try {
    return await docker.inspectImage(ref);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

function pinnedOf(info: ImageInfo, ref: string, log: DeployLog): { imageId: string; imageRef: string } {
  const digest = repoDigestFor(info.RepoDigests ?? [], ref);
  const imageRef = digest ? `${repositoryOf(ref)}@${digest}` : ref;
  log.system(`pinned ${info.Id.slice(0, 19)}${digest ? ` (${imageRef})` : ""}`);
  return { imageId: info.Id, imageRef };
}

/**
 * `localFirst`: a recorded digest already here runs without asking a registry. A pull that fails for a reason
 * other than the registry's answer about the image (a rate limit, an outage) runs the local copy; a refusal never does.
 */
export async function pullImage(
  docker: DockerApi,
  ref: string,
  auth: string | null,
  log: DeployLog,
  signal: AbortSignal,
  opts: { localFirst?: boolean } = {},
): Promise<{ imageId: string; imageRef: string }> {
  if (opts.localFirst) {
    const have = await localCopy(docker, ref);
    if (have) {
      log.system(`${ref} is already on this server; no pull`);
      return pinnedOf(have, ref, log);
    }
  }
  log.system(`pulling ${ref}`);
  let last = "";
  try {
    await docker.pullImage(ref, auth, (t) => {
      // Layer progress repeats a lot; keep only changes.
      if (t !== last) log.add("stdout", t);
      last = t;
    }, signal);
  } catch (e) {
    if (signal.aborted) throw e;
    const failure = pullFailure(ref, e);
    if (!(failure instanceof PermanentDeployError)) {
      const have = await localCopy(docker, ref).catch(() => null);
      if (have) {
        log.system(`could not pull ${ref} (${failure.message.replace(/\s+/g, " ").slice(0, 160)}); running the copy already on this server`);
        return pinnedOf(have, ref, log);
      }
    }
    throw failure;
  }
  return pinnedOf(await docker.inspectImage(ref), ref, log);
}
