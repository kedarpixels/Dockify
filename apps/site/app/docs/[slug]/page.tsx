import { DocPage, docMetadata } from "@/components/docs/doc-page";
import { DOC_PAGES } from "@/lib/docs-nav";

/* Only the pages in the sidebar exist; anything else is a 404 at build time. */
export const dynamicParams = false;

export function generateStaticParams() {
  return DOC_PAGES.map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return docMetadata((await params).slug);
}

export default async function Doc({ params }: { params: Promise<{ slug: string }> }) {
  return <DocPage slug={(await params).slug} />;
}
