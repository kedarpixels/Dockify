/**
 * Which image a managed service runs. A service stores the tag the owner picked (App.image, for
 * example "postgres:16-alpine"). Its first deploy pulls that tag once, or takes the copy of that tag
 * already on this server, and records the digest it resolved to (App.pinnedImage,
 * "postgres:16-alpine@sha256:..."); every later deploy, restore and
 * restore test runs that exact digest, so a moving tag never changes what runs under the data.
 * Only a change of App.image (the owner picking another version) resolves a new digest.
 *
 * No digest is written by hand anywhere: each one is what the registry served for the tag, read
 * back from the daemon after the pull (or from the copy a pull left here earlier). An owner who sets App.image to image@sha256:... chose the
 * digest themselves, and that is used as it is.
 */
import type { DockerPort } from "./docker-port.ts";

const DIGEST = /@(sha256:[0-9a-f]{64})$/;

export class ImageResolveError extends Error {
  readonly permanent: boolean;
  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = "ImageResolveError";
    this.permanent = permanent;
  }
}

/** "postgres:16-alpine" is "postgres"; "ghcr.io/a/b:1@sha256:..." is "ghcr.io/a/b". */
export function repositoryOf(ref: string): string {
  const bare = ref.trim().split("@")[0]!;
  const colon = bare.lastIndexOf(":");
  return colon > bare.lastIndexOf("/") ? bare.slice(0, colon) : bare;
}

/** Docker reports Docker Hub images by their short name: compare repositories in that form. */
export const familiar = (repo: string) => repo.replace(/^(?:docker\.io|index\.docker\.io)\//, "").replace(/^library\//, "");

export const digestOf = (ref: string): string | null => DIGEST.exec(ref.trim())?.[1] ?? null;

/** The digest a local image carries for ref's own repository: an image can hold names from several. */
export function repoDigestFor(repoDigests: readonly string[], ref: string): string | null {
  const repo = familiar(repositoryOf(ref));
  return repoDigests.map((d) => ({ repo: familiar(repositoryOf(d)), digest: digestOf(d) })).find((d) => d.repo === repo && d.digest)?.digest ?? null;
}

/** The pin recorded for a configured reference: the reference with the digest it resolved to. */
export const pinOf = (configured: string, digest: string): string => `${configured.trim().split("@")[0]}@${digest}`;

/** What is pulled and inspected for a pin: repository@digest, the form every registry serves. */
export function digestRef(pin: string): string {
  const d = digestOf(pin);
  if (!d) throw new ImageResolveError(`${pin} is not a digest reference`, true);
  return `${repositoryOf(pin)}@${d}`;
}

/** A recorded pin still belongs to the configured reference: the same reference, a digest added. */
export function pinFits(pin: string | null | undefined, configured: string): pin is string {
  if (!pin) return false;
  const d = digestOf(pin);
  return !!d && pin === pinOf(configured, d);
}

/** What a registry answers when the image or tag does not exist, or is not ours to pull: retrying cannot help. */
const NOT_THERE = /manifest unknown|not found|pull access denied|repository does not exist|unauthorized|denied|invalid reference format/i;

/** The two daemon calls resolving needs; the data module's port has them, and the preview adapts the deploy client. */
export type ImagePort = Pick<DockerPort, "inspectImage" | "pullImage">;

async function pull(docker: ImagePort, ref: string, log: (line: string) => void): Promise<void> {
  let last = "";
  try {
    await docker.pullImage(ref, (t) => {
      // Layer progress repeats a lot; keep only changes.
      if (t !== last && !/^[0-9a-f]{12}: (Downloading|Extracting|Waiting|Verifying)/.test(t)) log(t);
      last = t;
    });
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    throw new ImageResolveError(`Could not pull ${ref}: ${msg}`, NOT_THERE.test(msg));
  }
}

export interface ResolvedImage {
  /** The local image id the container is created from. */
  imageId: string;
  /** The reference with its digest, for App.pinnedImage. */
  pin: string;
  /** False when the pinned digest was already on this server. */
  pulled: boolean;
}

/**
 * The image to run for a configured reference and its recorded pin. A managed service never asks a
 * registry for what is already on this server, so a registry limit (Docker Hub's) or outage cannot
 * fail a redeploy:
 *
 *   pin fits      run the pinned digest; pull by digest only when it is not on this server any more
 *   no pin yet    the exact tag already here is pinned as it is (its digest, read from the daemon);
 *                 only a tag that is not here is pulled. The owner picks a version, not "latest", so
 *                 the tag on this server is that version, and the pin then holds it the same way.
 */
export async function resolveServiceImage(docker: ImagePort, configured: string, pin: string | null | undefined, log: (line: string) => void): Promise<ResolvedImage> {
  const ref = configured.trim();
  const chosen = digestOf(ref) ? ref : pinFits(pin, ref) ? pin : null;
  if (chosen) {
    const target = digestRef(chosen);
    const have = await docker.inspectImage(target);
    if (have) return { imageId: have.id, pin: chosen, pulled: false };
    log(`pulling ${target}, the digest this service is pinned to`);
    await pull(docker, target, log);
    const got = await docker.inspectImage(target);
    if (!got) throw new ImageResolveError(`${target} was pulled, but the server does not list it`, false);
    return { imageId: got.id, pin: chosen, pulled: true };
  }
  const local = await docker.inspectImage(ref);
  const localDigest = local ? repoDigestFor(local.repoDigests, ref) : null;
  if (local && localDigest) {
    log(`${ref} is already on this server; pinning it without a pull`);
    return { imageId: local.id, pin: pinOf(ref, localDigest), pulled: false };
  }
  log(`pulling ${ref} once to pin the digest it resolves to`);
  await pull(docker, ref, log);
  const got = await docker.inspectImage(ref);
  if (!got) throw new ImageResolveError(`${ref} was pulled, but the server does not list it`, false);
  const digest = repoDigestFor(got.repoDigests, ref);
  if (!digest) throw new ImageResolveError(`The registry gave ${ref} no digest, so it cannot be pinned`, true);
  return { imageId: got.id, pin: pinOf(ref, digest), pulled: true };
}
