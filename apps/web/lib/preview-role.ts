import "server-only";
import { cookies } from "next/headers";
import type { Overview } from "./types";

/*
 * Design preview only (DOCKIFY_PREVIEW=1, no API): view the console as a Viewer. A browser that
 * carries the cookie dockify-preview-role=viewer gets the fixture's signed-in person with the Viewer
 * role, so the keys a Viewer may not use, and the security banner's "Ask an admin to update", can be
 * checked without restarting the shared preview. It only ever lowers the role, and only the preview
 * fixture path reads it (lib/data.ts).
 */
const PREVIEW_ROLE_COOKIE = "dockify-preview-role";

export async function asPreviewRole(o: Overview): Promise<Overview> {
  const role = (await cookies()).get(PREVIEW_ROLE_COOKIE)?.value;
  return role === "viewer" && o.viewer ? { ...o, viewer: { ...o.viewer, role: "Viewer" } } : o;
}
