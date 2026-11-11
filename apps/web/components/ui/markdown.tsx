import type { MdBlock, MdInline } from "@/lib/markdown";

/* Untrusted Markdown as React elements only, never innerHTML. Links render only when lib/markdown.ts judged them safe. */

function Inline({ nodes }: { nodes: MdInline[] }) {
  return (
    <>
      {nodes.map((n, i) =>
        n.t === "text" ? (
          n.v
        ) : n.t === "code" ? (
          <code key={i} className="md-code">
            {n.v}
          </code>
        ) : n.t === "strong" ? (
          <strong key={i}>
            <Inline nodes={n.c} />
          </strong>
        ) : (
          <a key={i} className="md-link" href={n.href} target="_blank" rel="noopener noreferrer">
            <Inline nodes={n.c} />
          </a>
        ),
      )}
    </>
  );
}

export function Block({ block }: { block: MdBlock }) {
  switch (block.t) {
    case "heading":
      // Small headings at one size; the first level only weighs more.
      return (
        <p className="md-h" data-level={block.level} role="heading" aria-level={Math.min(6, block.level + 2)}>
          <Inline nodes={block.c} />
        </p>
      );
    case "p":
      return (
        <p className="md-p">
          <Inline nodes={block.c} />
        </p>
      );
    case "ul":
    case "ol": {
      const List = block.t;
      return (
        <List className="md-list">
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline nodes={item} />
            </li>
          ))}
        </List>
      );
    }
  }
}
