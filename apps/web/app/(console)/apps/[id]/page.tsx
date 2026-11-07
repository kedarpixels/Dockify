import type { Metadata } from "next";
import { AppView } from "@/components/project-detail/app-view";
import { getOverview } from "@/lib/data";
import { getAppPage } from "@/lib/pages/project-detail";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await getAppPage(decodeURIComponent((await params).id));
  const app = page.data?.app;
  return { title: app ? `${app.projectSlug} / ${app.name}` : "App" };
}

/* The open tab lives in ?tab=, read on the client by useUrlTab. */
export default async function AppPage({ params }: Props) {
  const id = decodeURIComponent((await params).id);
  const [overview, page] = await Promise.all([getOverview(), getAppPage(id)]);
  return <AppView key={id} overview={overview} page={page} id={id} />;
}
