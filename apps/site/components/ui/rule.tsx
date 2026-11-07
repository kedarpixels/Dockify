import { cx } from "./cx";

/**
 * 5px square node marking where a line meets another.
 * pos: corner of the positioned parent ("tl" top left, "tr", "bl", "br").
 * The default offset (-3px) centres it on the parent's own 1px border; pass `onLine` when the parent
 * is itself a 1px line (offset -2px). The parent must be position: relative.
 */
export function Node({ pos, onLine, className }: { pos: "tl" | "tr" | "bl" | "br"; onLine?: boolean; className?: string }) {
  return <span aria-hidden="true" className={cx("node", onLine && "node-line", className)} data-pos={pos} />;
}

/**
 * Four nodes, one on each corner of a ruled cell (KPI cells, project blocks, grid cells). The
 * parent must be position: relative. `onLine` as on Node.
 */
export function Corners({ onLine }: { onLine?: boolean }) {
  return (
    <>
      <Node pos="tl" onLine={onLine} />
      <Node pos="tr" onLine={onLine} />
      <Node pos="bl" onLine={onLine} />
      <Node pos="br" onLine={onLine} />
    </>
  );
}

/**
 * Hairline rule with a node at each end. As a direct child of `main.page` it runs full bleed and
 * the nodes sit where it crosses the rails; elsewhere it spans its parent.
 */
export function Rule({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx("rule", className)} />;
}

/**
 * Spacer between sections: a 40px band of 50% Bayer dither framed by two rules with nodes on the
 * rails (same as `<div className="sep" />`). `end` lets the last band grow to fill the page.
 */
export function Spacer({ end, className }: { end?: boolean; className?: string }) {
  return <div aria-hidden="true" className={cx("sep", end && "sep-end", className)} />;
}
