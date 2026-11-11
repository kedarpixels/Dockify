"use client";

import { createContext, useContext } from "react";

// `useCan` only shapes the UI, so a Viewer sees disabled keys instead of a 403 toast.
// The API enforces every role on its own.

export interface Viewer {
  name: string;
  role: string;
  email?: string;
  avatarUrl?: string;
}

/** The two team roles (packages/contracts Role). */
export type Role = "admin" | "viewer";

export const NO_ACCESS_TIP = "Viewers cannot change this";

/** The role a viewer payload names, or null when it names none this dashboard knows. */
function roleOf(viewer: Pick<Viewer, "role"> | null | undefined): Role | null {
  const r = viewer?.role?.trim().toLowerCase();
  return r === "admin" || r === "viewer" ? r : null;
}

/** `manage`: every admin write. `account`: the person's own profile, password and sessions.
 * An unknown role allows both: the API refuses what it must, and a key is never hidden by mistake. */
function capabilities(role: Role | null): { role: Role | null; manage: boolean; account: boolean } {
  return { role, manage: role !== "viewer", account: true };
}

const ViewerContext = createContext<Viewer | null>(null);

export function ViewerProvider({ viewer, children }: { viewer: Viewer | null; children: React.ReactNode }) {
  return <ViewerContext.Provider value={viewer}>{children}</ViewerContext.Provider>;
}

/** The signed-in person, or null outside the console or before the API sent one. */
export const useViewer = () => useContext(ViewerContext);

export function useCan() {
  return capabilities(roleOf(useContext(ViewerContext)));
}
