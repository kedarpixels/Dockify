import { lstat, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { PermanentDeployError } from "./errors.ts";

/**
 * Resolves a repository-relative path and proves it stays inside the checkout. Symlinks at the
 * path itself are refused, and the realpath must sit under the root.
 */
export async function insideCheckout(checkoutDir: string, rel: string): Promise<string> {
  if (rel.startsWith("/") || rel.includes("\\") || rel.split("/").includes("..")) {
    throw new PermanentDeployError(`${rel} must be a relative path inside the repository`);
  }
  const base = await realpath(checkoutDir);
  const target = join(base, rel || ".");
  let st;
  try {
    st = await lstat(target);
  } catch {
    throw new PermanentDeployError(`${rel || "."} does not exist in the repository`);
  }
  if (st.isSymbolicLink()) throw new PermanentDeployError(`${rel} is a symlink, which Dockify refuses as a build path`);
  const real = await realpath(target);
  if (real !== base && !real.startsWith(base + sep)) throw new PermanentDeployError(`${rel} resolves outside the repository`);
  return real;
}
