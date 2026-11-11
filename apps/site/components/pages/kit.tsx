import { Children, Fragment, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/icon";
import { Corners, Node } from "@/components/ui/rule";
import { cx } from "@/components/ui/cx";

/* Every block that draws inner lines ends on a Spacer, which is what makes the nodes below land on real joins. */

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

/** `cols` is the widest count; CSS steps it down at 1100 and 760. The cell count must fill every row at
 *  every step; outside production a wrong count warns. */
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

/** Splits a flag term so a flag never breaks at a hyphen or from its argument, and two flags wrap between them. */
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

/** `mono` sets the term column in the code face (flags, paths). */
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

export function Body({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("pg-body", className)}>{children}</div>;
}

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

/** Before a sentence it reads "Yes: ..."; `alone` when the mark is the whole cell. */
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
