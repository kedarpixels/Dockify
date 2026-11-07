import type { Metadata } from "next";
import { NewProjectDirect } from "@/components/projects/new-project-modal";
import { ProjectsView } from "@/components/projects/projects-view";
import { getOverview } from "@/lib/data";
import { getNewProjectContext } from "@/lib/pages/project-detail";

export const metadata: Metadata = { title: "New project" };

/* A direct visit or a reload of /projects/new: the projects list with the New project popup over
   it, the same popup a link inside the app opens (app/(console)/@modal). There is no separate page. */
export default async function NewProjectPage() {
  const [overview, ctx] = await Promise.all([getOverview(), getNewProjectContext()]);
  return (
    <>
      <ProjectsView initial={overview} />
      <NewProjectDirect source={ctx.source} taken={ctx.taken} />
    </>
  );
}
