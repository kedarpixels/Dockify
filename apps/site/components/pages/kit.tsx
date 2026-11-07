import { Children, Fragment, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/icon";
import { Corners, Node } from "@/components/ui/rule";
import { cx } from "@/components/ui/cx";

/*
 * Shared blocks for the compare, install, changelog, security and open-source pages. Each block is a
 * direct child of main.page, so it sits between the rails. Every block that draws inner lines ends
 * on a Spacer, which is what makes the nodes below land on real joins.
 */

/** A page section: a pixel title and a lead, then the body. */
export function Section({
  id,
  title,
  lead,
  actions,
  children,
  className,
}: {
  id?: string;
  title: string;
  lead?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={cx("pg-sec", className)} aria-labelledby={id ? `${id}-h` : undefined}>
      <header className="shead">
        <div className="shead-row">
          <div>
            <h2 id={id ? `${id}-h` : undefined} className="shead-title">
              {title}
            </h2>
            {lead ? <p className="shead-lead pg-lead">{lead}</p> : null}
          </div>
          {actions ? <div className="shead-actions">{actions}</div> : null}
        </div>
      </header>
      {children}
    </section>
  );
}

/* The column counts a grid steps through as it narrows (pages.css: 1100 and 760). A three-up grid
   with exactly three cells stays three-up at 1100. */
const STEPS: Record<2 | 3 | 4, number[]> = { 2: [2, 1], 3: [3, 2, 1], 4: [4, 2, 1] };

/**
 * Ruled grid. Cells are split by 1px gaps over the line colour and the grid opens on a top rule,
 * so every cell corner is a join (rail, rule, divider or the Spacer below): each cell carries four
 * nodes. `cols` is the widest count; CSS steps it down at 1100 and 760. The cell count must fill
 * every row at every step, so no grid cell is left empty; outside production a wrong count warns.
 */
export function Grid({ cols, children, className }: { cols: 1 | 2 | 3 | 4; children: ReactNode; className?: string }) {
  if (process.env.NODE_ENV !== "production" && cols > 1) {
    const n = Children.toArray(children).length;
    const bad = STEPS[cols as 2 | 3 | 4].filter((c) => n % c !== 0 && !(cols === 3 && c === 2 && n === 3));
    if (bad.length) console.warn(`Grid: ${n} cells leave an empty cell at ${bad.join(" and ")} columns`);
  }
  return (
    <div className={cx("pg-grid", className)} data-cols={cols}>
      {children}
    </div>
  );
}

export function Cell({
  icon,
  title,
  children,
  foot,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  foot?: ReactNode;
}) {
  return (
    <div className="pg-cell">
      <Corners />
      {icon ? (
        <span className="icon-tile pg-cell-ic" aria-hidden="true">
          <Icon name={icon} />
        </span>
      ) : null}
      <h3 className="pg-cell-h">{title}</h3>
      {children ? <div className="pg-cell-body">{children}</div> : null}
      {foot ? <div className="pg-cell-foot">{foot}</div> : null}
    </div>
  );
}

/**
 * Numbered ruled rows: a number column, a hairline, then the body. Nodes sit where each row rule
 * meets the rails and the divider, and where the divider meets the Spacer under the last row.
 */
export function Steps({ items }: { items: { title: string; body?: ReactNode; changes?: string[] }[] }) {
  return (
    <ol className="pg-steps">
      {items.map((s, i) => (
        <li key={s.title} className="pg-step">
          <Node pos="tl" />
          <Node pos="tr" />
          <span className="pg-step-n pixel" aria-hidden="true">
            {String(i + 1).padStart(2, "0")}
          </span>
          <div className="pg-step-body">
            <Node pos="tl" />
            {i === items.length - 1 ? <Node pos="bl" /> : null}
            <p className="pg-step-h">
              <span className="sr">Step {i + 1}. </span>
              {s.title}
            </p>
            {s.body ? <div className="pg-step-text">{s.body}</div> : null}
            {s.changes?.length ? (
              <ul className="pg-chips" aria-label="What it changes">
                {s.changes.map((c) => (
                  <li key={c}>
                    <code className="pg-path">{c}</code>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * A flag term ("--control-image REF --web-image REF") as pieces that each stay on one line: a flag
 * with its argument never breaks at a hyphen, and two flags wrap between them.
 */
function flagPieces(term: string): ReactNode {
  const pieces: string[] = [];
  for (const word of term.split(" ")) {
    if (word.startsWith("-") || pieces.length === 0) pieces.push(word);
    else pieces[pieces.length - 1] += ` ${word}`;
  }
  return pieces.map((p, i) => (
    <Fragment key={p}>
      {i > 0 ? " " : null}
      <span className="pg-flag">{p}</span>
    </Fragment>
  ));
}

/**
 * Two-column ruled rows: a term and its meaning. Nodes as in Steps. The term column is in the code
 * face when `mono` is set (flags, paths), and a flag term never breaks inside a flag.
 */
export function Rows({ items, mono }: { items: { term: ReactNode; key: string; desc: ReactNode }[]; mono?: boolean }) {
  return (
    <dl className="pg-rows" data-mono={mono || undefined}>
      {items.map((r, i) => (
        <div key={r.key} className="pg-row">
          <Node pos="tl" />
          <Node pos="tr" />
          <dt className="pg-row-term">{mono && typeof r.term === "string" ? flagPieces(r.term) : r.term}</dt>
          <dd className="pg-row-desc">
            <Node pos="tl" />
            {i === items.length - 1 ? <Node pos="bl" /> : null}
            {r.desc}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Plain body copy inside the rails, for a lead paragraph or a short note under a block. */
export function Body({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("pg-body", className)}>{children}</div>;
}

/** An outbound source link: small, muted, with the arrow glyph. */
export function Src({ href, label = "Source" }: { href: string; label?: string }) {
  return (
    <a className="pg-src" href={href} target="_blank" rel="noreferrer noopener">
      {label}
      <Icon name="arrowUpRight" size={12} />
      <span className="sr"> (opens in a new tab)</span>
    </a>
  );
}

export type Tone = "yes" | "part" | "no" | "soon";

export const TONE_WORD: Record<Tone, string> = { yes: "Yes", part: "Partly", no: "No", soon: "Soon" };
const TONE_ICON: Partial<Record<Tone, IconName>> = { yes: "check", part: "minus", no: "close" };

/**
 * The one yes, partly or no mark (here, on /compare and on the landing table), or the Soon chip.
 * Before a sentence it reads "Yes: ..."; `alone` when the mark is the whole cell.
 */
export function ToneDot({ tone, alone }: { tone: Tone; alone?: boolean }) {
  const icon = TONE_ICON[tone];
  return (
    <span className="pg-tone" data-tone={tone}>
      <span className="pg-mark" aria-hidden="true">
        {icon ? <Icon name={icon} size={12} /> : TONE_WORD[tone]}
      </span>
      <span className="sr">{alone ? TONE_WORD[tone] : `${TONE_WORD[tone]}: `}</span>
    </span>
  );
}
