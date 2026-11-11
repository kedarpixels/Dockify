"use client";

import { usePathname, useRouter } from "next/navigation";
import type { OverviewSource } from "@/lib/types";
import { NewProjectDialog } from "./new-project-dialog";

// The intercepted /projects/new route opens the popup over the current page. The slot keeps its
// last content on later soft navigations, so it only renders on its own path.
export function NewProjectModal({ source, taken }: { source: OverviewSource; taken: string[] }) {
  const router = useRouter();
  if (usePathname() !== "/projects/new") return null;
  return <NewProjectDialog source={source} taken={taken} onClose={() => router.back()} />;
}

/** A direct visit or reload has no page behind it, so closing lands on /projects. */
export function NewProjectDirect({ source, taken }: { source: OverviewSource; taken: string[] }) {
  const router = useRouter();
  return <NewProjectDialog source={source} taken={taken} onClose={() => router.replace("/projects")} />;
}
