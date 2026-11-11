import "server-only";
import { cookies } from "next/headers";
import type { Overview } from "./types";

// Design preview only: the cookie dockify-preview-role=viewer shows the console as a Viewer.
// It only ever lowers the role, and only the preview fixture path reads it (lib/data.ts).
const PREVIEW_ROLE_COOKIE = "dockify-preview-role";

export async function asPreviewRole(o: Overview): Promise<Overview> {
  const role = (await cookies()).get(PREVIEW_ROLE_COOKIE)?.value;
  return role === "viewer" && o.viewer ? { ...o, viewer: { ...o.viewer, role: "Viewer" } } : o;
}
