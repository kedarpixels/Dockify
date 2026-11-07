import type { Metadata } from "next";
import { NewProjectModal } from "@/components/projects/new-project-modal";
import { getNewProjectContext } from "@/lib/pages/project-detail";

/* The tab reads "New project" while the popup is open over another page, as on a direct visit. */
export const metadata: Metadata = { title: "New project" };

/* A link to /projects/new inside the app opens the popup over the current page; a direct visit or
   a reload shows the same popup over the projects list (app/(console)/projects/new). */
export default async function NewProjectModalPage() {
  const { source, taken } = await getNewProjectContext();
  return <NewProjectModal source={source} taken={taken} />;
}
