"use client";

import { usePathname, useRouter } from "next/navigation";
import type { OverviewSource } from "@/lib/types";
import { NewProjectDialog } from "./new-project-dialog";

/**
 * New project is always a popup. From a link inside the app the /projects/new route is
 * intercepted and the popup opens over the current page; the slot keeps its last content on later
 * soft navigations, so it only renders on its own path, and closing goes back to that page.
 */
export function NewProjectModal({ source, taken }: { source: OverviewSource; taken: string[] }) {
  const router = useRouter();
  if (usePathname() !== "/projects/new") return null;
  return <NewProjectDialog source={source} taken={taken} onClose={() => router.back()} />;
}

/**
 * The same popup for a direct visit or a reload of /projects/new, drawn over the projects list.
 * There is no page behind it to go back to, so closing lands on /projects.
 */
export function NewProjectDirect({ source, taken }: { source: OverviewSource; taken: string[] }) {
  const router = useRouter();
  return <NewProjectDialog source={source} taken={taken} onClose={() => router.replace("/projects")} />;
}
