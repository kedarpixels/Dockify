import Link from "next/link";
import { isValidElement, type ReactNode } from "react";
import { compileMDX } from "next-mdx-remote/rsc";
import { Icon } from "@/components/icon";
import { Corners } from "@/components/ui/rule";
import { slugify } from "@/lib/docs";
import { repoHref } from "@/lib/site";
import { CodeBlock } from "./code-block";
import { remarkPipeTables } from "./remark-tables";

/* Content is ours (content/docs), compiled on the server at build time. JS expressions stay blocked, so every
   block takes string props and children only. */

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function heading(Tag: "h2" | "h3") {
  return function Heading({ children }: { children?: ReactNode }) {
    const id = slugify(textOf(children));
    return (
      <Tag id={id} className="doc-h">
        <a href={`#${id}`} className="doc-anchor" aria-label="Link to this section">
          #
        </a>
        {children}
      </Tag>
    );
  };
}

function DocLinkTo({ href, children, className }: { href: string; children?: ReactNode; className?: string }) {
  if (href.startsWith("/") || href.startsWith("#"))
    return (
      <Link href={href} className={className}>
        {children}
      </Link>
    );
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={className}>
      {children}
    </a>
  );
}

/** A plain callout. tone: info (default), warn, or bad for "this can lose data". */
function Note({ tone = "info", title, children }: { tone?: "info" | "warn" | "bad"; title?: string; children?: ReactNode }) {
  return (
    <aside className="dnote" data-tone={tone}>
      <span className="dnote-ic" aria-hidden="true">
        <Icon name={tone === "info" ? "info" : "alert"} size={16} />
      </span>
      <div className="dnote-body">
        {title ? <p className="dnote-title">{title}</p> : null}
        {children}
      </div>
    </aside>
  );
}

/** An unreleased feature, said plainly. Inline as a chip, or as a block with a sentence. */
function Soon({ children }: { children?: ReactNode }) {
  if (!children)
    return (
      <span className="dsoon">Soon</span>
    );
  return (
    <aside className="dnote dnote-soon" data-tone="soon">
      <span className="dsoon">Soon</span>
      <div className="dnote-body">{children}</div>
    </aside>
  );
}

/** A link into the repository (lib/site.ts REPO). While the repository is not set it renders the words alone. */
function RepoLink({ path, children }: { path?: string; children?: ReactNode }) {
  const href = repoHref(path);
  if (!href) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

function Steps({ children }: { children?: ReactNode }) {
  return <div className="dsteps">{children}</div>;
}

function DocGrid({ children }: { children?: ReactNode }) {
  return (
    <div className="dgrid">
      <Corners />
      {children}
    </div>
  );
}

function DocCard({ href, title, children }: { href: string; title: string; children?: ReactNode }) {
  return (
    <DocLinkTo href={href} className="dgrid-cell">
      <span className="dgrid-title">
        {title}
        <Icon name="arrowRight" size={14} />
      </span>
      <span className="dgrid-text">{children}</span>
    </DocLinkTo>
  );
}

const components = {
  h2: heading("h2"),
  h3: heading("h3"),
  pre({ children }: { children?: ReactNode }) {
    if (isValidElement<{ className?: string; children?: ReactNode }>(children)) {
      const lang = /language-(\S+)/.exec(children.props.className ?? "")?.[1];
      return <CodeBlock code={textOf(children.props.children)} lang={lang} />;
    }
    return <pre>{children}</pre>;
  },
  a({ href = "", children }: { href?: string; children?: ReactNode }) {
    return <DocLinkTo href={href}>{children}</DocLinkTo>;
  },
  table({ children }: { children?: ReactNode }) {
    return (
      <div className="dtable">
        <table>{children}</table>
      </div>
    );
  },
  Note,
  Soon,
  Steps,
  DocGrid,
  DocCard,
  RepoLink,
};

export type DocMeta = { title: string; description?: string };

type Compiled = Awaited<ReturnType<typeof compileMDX<DocMeta>>>;
const compiled = new Map<string, Promise<Compiled>>();

/** The page compiled once per process (pages are prerendered, so once per build). */
export function renderDoc(slug: string, source: string): Promise<Compiled> {
  let c = compiled.get(slug);
  if (!c) {
    c = compileMDX<DocMeta>({
      source,
      components,
      options: { parseFrontmatter: true, mdxOptions: { remarkPlugins: [remarkPipeTables] } },
    });
    compiled.set(slug, c);
  }
  return c;
}
