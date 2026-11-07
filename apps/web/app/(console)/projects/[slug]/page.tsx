import type { Metadata } from "next";
import { ProjectView } from "@/components/project-detail/project-view";
import { getOverview } from "@/lib/data";
import { getProjectPage } from "@/lib/pages/project-detail";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: decodeURIComponent((await params).slug) };
}

/* The open tab lives in ?tab=, read on the client by useUrlTab. */
export default async function ProjectPage({ params }: Props) {
  const slug = decodeURIComponent((await params).slug);
  const [overview, page] = await Promise.all([getOverview(), getProjectPage(slug)]);
  return <ProjectView key={slug} overview={overview} page={page} slug={slug} />;
}
