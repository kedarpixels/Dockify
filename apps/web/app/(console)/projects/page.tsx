import type { Metadata } from "next";
import { ProjectsView } from "@/components/projects/projects-view";
import { getOverview } from "@/lib/data";

export const metadata: Metadata = { title: "Projects" };

export default async function ProjectsPage() {
  return <ProjectsView initial={await getOverview()} />;
}
