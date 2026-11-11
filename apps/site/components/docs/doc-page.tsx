import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { frontmatterField, headingsOf, readDoc } from "@/lib/docs";
import { neighbours } from "@/lib/docs-nav";
import { repoHref } from "@/lib/site";
import { JsonLd, breadcrumbs } from "@/components/seo/json-ld";
import { pageMetadata } from "@/components/seo/metadata";
import { Corners } from "@/components/ui/rule";
import { renderDoc } from "./mdx";
import { Pager } from "./pager";
import { Toc } from "./toc";

export async function DocPage({ slug }: { slug: string }) {
  const source = await readDoc(slug);
  if (source === null) notFound();
  const { content, frontmatter } = await renderDoc(slug, source);
  const { prev, next } = neighbours(slug === "index" ? null : slug);
  return (
    <>
      {slug === "index" ? null : (
        <JsonLd
          data={breadcrumbs([
            { name: "Docs", path: "/docs" },
            { name: frontmatter.title, path: `/docs/${slug}` },
          ])}
        />
      )}
      <article className="doc">
        <header className="doc-head">
          <h1 className="doc-title">{frontmatter.title}</h1>
          {frontmatter.description ? <p className="doc-lead">{frontmatter.description}</p> : null}
        </header>
        <div className="doc-band" aria-hidden="true">
          <Corners />
        </div>
        <div className="prose">{content}</div>
        <Pager prev={prev} next={next} />
      </article>
      <Toc headings={headingsOf(source)} editHref={repoHref(`edit/main/apps/site/content/docs/${slug}.mdx`) ?? undefined} />
    </>
  );
}

/** Title and description straight from the frontmatter, so metadata never compiles the page. */
export async function docMetadata(slug: string): Promise<Metadata> {
  const source = await readDoc(slug);
  if (source === null) return {};
  const title = frontmatterField(source, "title");
  const description = frontmatterField(source, "description") || undefined;
  const home = slug === "index";
  return pageMetadata({
    path: home ? "/docs" : `/docs/${slug}`,
    absolute: home ? "Dockify docs" : `${title} | Dockify docs`,
    description,
    type: home ? "website" : "article",
  });
}
