import { frontmatterField, headingsOf, readDoc } from "@/lib/docs";
import { DOC_PAGES } from "@/lib/docs-nav";

/* The docs search index: every page's title, lead and h2 and h3 headings. app/search.json/route.ts
   writes it once at build time as a static file, and the search dialog fetches it on first use. */

export type SearchEntry = {
  /** Where the result goes: the page, or the page plus a heading anchor. */
  href: string;
  page: string;
  /** The heading text, absent for the page entry itself. */
  heading?: string;
  /** The page lead, on the page entry only. */
  lead?: string;
};

export async function buildSearchIndex(): Promise<SearchEntry[]> {
  const pages = [{ slug: "index", href: "/docs" }, ...DOC_PAGES.map((d) => ({ slug: d.slug, href: `/docs/${d.slug}` }))];
  const out: SearchEntry[] = [];
  for (const p of pages) {
    const src = await readDoc(p.slug);
    if (src === null) continue;
    const page = frontmatterField(src, "title") || p.slug;
    out.push({ href: p.href, page, lead: frontmatterField(src, "description") || undefined });
    for (const h of headingsOf(src)) out.push({ href: `${p.href}#${h.id}`, page, heading: h.text });
  }
  return out;
}
