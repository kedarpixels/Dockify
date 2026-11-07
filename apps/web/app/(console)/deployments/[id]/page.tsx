import type { Metadata } from "next";
import { cache } from "react";
import { DeploymentView } from "@/components/deployments/deployment-view";
import { getOverview } from "@/lib/data";
import { appTitle } from "@/lib/format";
import { getDeployment } from "@/lib/pages/deployments";

type Props = { params: Promise<{ id: string }> };

/** One read per request, shared by the title and the page. */
const load = cache((id: string) => getDeployment(id));

/** "horseai / web, 9c0d4e2": the app and the build, so two deployments of one app never share a tab title. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const result = await load(id);
  const d = result.data;
  if (d) return { title: `${d.projectSlug} / ${appTitle(d.app)}, ${d.commit?.slice(0, 7) ?? d.id}` };
  return { title: result.notFound ? "Deployment not found" : "Deployment" };
}

export default async function DeploymentPage({ params }: Props) {
  const { id } = await params;
  const [initial, overview] = await Promise.all([load(id), getOverview()]);
  // Keyed on the id, so moving to another deployment (the View action after a redeploy) starts
  // its state, poll and log viewer fresh.
  return <DeploymentView key={id} id={id} initial={initial} overview={overview} />;
}
