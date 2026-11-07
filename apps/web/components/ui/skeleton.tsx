import { cx } from "./cx";

/*
 * Loading shapes. Bars only, never placeholder words, sized like the content that replaces them so
 * nothing jumps when data lands. The pulse stops under reduced motion.
 *
 *   <Skel w={120} />                                                  one 8px bar
 *   <SkelRows rows={6} template="24px minmax(0,1fr) 120px 56px" cols={[16, "60%", 80, 40]} />
 *   <SkelRows rows={4} height={56} template="24px minmax(0,1fr) 96px" cols={[24, { w: "50%", lines: 2 }, 64]} />
 *
 * Copy the real row's `grid-template-columns` and height (44 single line, 56 two line).
 */

type Size = number | string;
const px = (v: Size | undefined) => (typeof v === "number" ? `${v}px` : v);

/** One bar. Default 8px tall and full width; `r` is the radius (6, or 999 for a dot). */
export function Skel({ w, h = 8, r, className }: { w?: Size; h?: Size; r?: number; className?: string }) {
  return <span aria-hidden="true" className={cx("skel", className)} style={{ width: px(w), height: px(h), borderRadius: r }} />;
}

/** A column of a skeleton row: a width, or a two-line stack (a 10px bar over a shorter 8px one). */
export type SkelCol = Size | { w: Size; lines?: 1 | 2 };

/**
 * `rows` rows at the real row height. Each column draws one bar; a number column of 16 or 24 is
 * drawn square (an icon or a row tile). The block is announced once as loading.
 */
export function SkelRows({
  rows = 5,
  height = 44,
  template,
  cols,
  label = "Loading",
  className,
}: {
  rows?: number;
  height?: 44 | 56 | number;
  /** The real row's grid-template-columns. */
  template: string;
  cols: SkelCol[];
  label?: string;
  className?: string;
}) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className={cx("skel-rows", className)}>
      {Array.from({ length: rows }, (_, r) => (
        // The template rides in --skel-cols, not an inline grid-template-columns, so an area's own
        // rule can change the columns at a breakpoint without !important.
        <div key={r} className="skel-row" style={{ ["--skel-cols" as string]: template, height }}>
          {cols.map((c, i) => {
            const col = typeof c === "object" ? c : { w: c };
            if (col.lines === 2) {
              return (
                <span key={i} className="skel-two" style={{ width: px(col.w) }}>
                  <Skel h={10} />
                  <Skel w="60%" h={8} />
                </span>
              );
            }
            const square = col.w === 16 || col.w === 24;
            return <Skel key={i} w={col.w} h={square ? col.w : 8} r={square ? (col.w === 24 ? 8 : 4) : undefined} />;
          })}
        </div>
      ))}
    </div>
  );
}
