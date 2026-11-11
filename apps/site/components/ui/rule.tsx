import { cx } from "./cx";

/** The default offset centres the node on the parent's 1px border; pass `onLine` when the parent is itself a 1px line. The parent must be position: relative. */
export function Node({ pos, onLine, className }: { pos: "tl" | "tr" | "bl" | "br"; onLine?: boolean; className?: string }) {
  return <span aria-hidden="true" className={cx("node", onLine && "node-line", className)} data-pos={pos} />;
}

/** The parent must be position: relative. `onLine` as on Node. */
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

/** As a direct child of `main.page` it runs full bleed and the nodes sit where it crosses the rails. */
export function Rule({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx("rule", className)} />;
}

/** Same as `<div className="sep" />`. `end` lets the last band grow to fill the page. */
export function Spacer({ end, className }: { end?: boolean; className?: string }) {
  return <div aria-hidden="true" className={cx("sep", end && "sep-end", className)} />;
}
