import { readFile } from "node:fs/promises";
import path from "node:path";

/* One MDX file per page in content/docs. Pages are prerendered, so each file is read once, at build time. */

const DIR = path.join(process.cwd(), "content", "docs");

export type Heading = { id: string; text: string; depth: 2 | 3 };

/** URL-safe id for a heading. The same function names the anchors and the TOC links. */
export function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** h2 and h3 headings, skipping fenced code, for the on-page TOC and the search index. */
export function headingsOf(source: string): Heading[] {
  const out: Heading[] = [];
  let fenced = false;
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^(##|###)\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      const text = m[2]!.replace(/`/g, "");
      out.push({ id: slugify(text), text, depth: m[1] === "##" ? 2 : 3 });
    }
  }
  return out;
}

/** One frontmatter field, read without compiling the page: `title: "..."`. */
export function frontmatterField(source: string, key: string): string {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? "";
  const m = new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`, "m").exec(head);
  return m?.[1] ?? "";
}

const reads = new Map<string, Promise<string | null>>();

/** Raw MDX for a page, or null when there is no such file. `index` is the docs home. */
export function readDoc(slug: string): Promise<string | null> {
  if (!/^[a-z0-9-]+$/.test(slug)) return Promise.resolve(null);
  let r = reads.get(slug);
  if (!r) {
    r = readFile(path.join(DIR, `${slug}.mdx`), "utf8").catch(() => null);
    reads.set(slug, r);
  }
  return r;
}
