"use client";

import { createContext, useContext } from "react";

/*
 * Who is signed in, for the console's client components: the overview `viewer` (name, role, email,
 * picture), provided once by the console layout. `useCan` is the one role check write keys use, so
 * a Viewer sees disabled or hidden keys instead of learning from a 403 toast. It only shapes the UI:
 * the API enforces every role on its own.
 *
 *   <ViewerProvider viewer={overview.data?.viewer ?? null}>...console...</ViewerProvider>
 *   const can = useCan();
 *   <button disabled={!can.manage} data-tip={can.manage ? undefined : NO_ACCESS_TIP}>Deploy</button>
 */

export interface Viewer {
  name: string;
  role: string;
  email?: string;
  avatarUrl?: string;
}

/** The two team roles (packages/contracts Role). */
export type Role = "admin" | "viewer";

/** The tip on a key a Viewer cannot use. */
export const NO_ACCESS_TIP = "Viewers cannot change this";

/** The role a viewer payload names, or null when it names none this dashboard knows. */
function roleOf(viewer: Pick<Viewer, "role"> | null | undefined): Role | null {
  const r = viewer?.role?.trim().toLowerCase();
  return r === "admin" || r === "viewer" ? r : null;
}

/**
 * What a role may change. `manage` covers every admin write (deploys, apps, variables, domains,
 * backups, the server, the team and the instance). `account` covers the signed-in person's own
 * profile, password, two-factor, sessions and tokens, which every member may change. An unknown
 * role allows both: the API refuses what it must, and a key is never hidden by mistake.
 */
function capabilities(role: Role | null): { role: Role | null; manage: boolean; account: boolean } {
  return { role, manage: role !== "viewer", account: true };
}

const ViewerContext = createContext<Viewer | null>(null);

export function ViewerProvider({ viewer, children }: { viewer: Viewer | null; children: React.ReactNode }) {
  return <ViewerContext.Provider value={viewer}>{children}</ViewerContext.Provider>;
}

/** The signed-in person, or null outside the console or before the API sent one. */
export const useViewer = () => useContext(ViewerContext);

/** The signed-in person's role and what it may change. */
export function useCan() {
  return capabilities(roleOf(useContext(ViewerContext)));
}
