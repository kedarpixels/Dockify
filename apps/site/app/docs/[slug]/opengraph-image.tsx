import { ogVariants, renderOg } from "@/components/seo/og";
import { readDoc } from "@/lib/docs";
import { DOC_PAGES } from "@/lib/docs-nav";

/* Social card for each docs page: the sidebar title in the pixel face, the frontmatter description under it. */

function titleOf(slug: string) {
  return DOC_PAGES.find((d) => d.slug === slug)?.title ?? "Dockify docs";
}

export function generateImageMetadata({ params }: { params: { slug: string } }) {
  return ogVariants(`${titleOf(params.slug)} | Dockify docs`);
}

export default async function Image({ params, id }: { params: Promise<{ slug: string }>; id: Promise<string | number> }) {
  const { slug } = await params;
  const source = (await readDoc(slug)) ?? "";
  const description = /^description:\s*"(.*)"\s*$/m.exec(source)?.[1] ?? "Run Dockify on one server, from install to restore.";
  return renderOg({ title: titleOf(slug), kicker: "Docs", line: description, tag: `/docs/${slug}` }, await id);
}
