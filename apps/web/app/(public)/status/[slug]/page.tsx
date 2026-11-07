import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StatusUnavailable } from "@/components/status-page/status-missing";
import { StatusView } from "@/components/status-page/status-view";
import { getStatusPage, headlineOf } from "@/lib/pages/status-page";

/* The data is shared by every visitor and kept a minute; the page renders per request, for its CSP nonce. */
export const revalidate = 60;

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const result = await getStatusPage((await params).slug);
  if (result.kind !== "ok") return { title: "Status", robots: { index: false } };
  const { name, slug } = result.data;
  return {
    title: `${name} status`,
    description: `${headlineOf(result.data)}. Live uptime and incidents for ${name}.`,
    alternates: { types: { "application/rss+xml": `/api/status/${slug}/rss` } },
    robots: { index: true, follow: true },
  };
}

export default async function StatusPage({ params }: Props) {
  const result = await getStatusPage((await params).slug);
  if (result.kind === "missing") notFound();
  if (result.kind === "error") return <StatusUnavailable />;
  return <StatusView data={result.data} />;
}
