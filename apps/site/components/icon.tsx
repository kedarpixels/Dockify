import { createElement, type ReactNode } from "react";
import { GLYPHS, type GlyphNode } from "./icon-glyphs";

/* Glyphs are copied into icon-glyphs.ts by scripts/gen-icons.mjs, so only the icons in use reach the browser.
   They are filled 16px drawings, so `.ic` sets fill to currentColor and no stroke. */

export type IconName = keyof typeof GLYPHS;

type IconSize = 12 | 14 | 16 | 20;

function draw(nodes: GlyphNode[]): ReactNode[] {
  return nodes.map(([tag, props, kids], i) => createElement(tag, { key: i, ...props }, kids ? draw(kids) : undefined));
}

/** Decorative by default; pass `label` when the icon carries meaning alone. */
export function Icon({
  name,
  size = 16,
  className,
  label,
}: {
  name: IconName;
  size?: IconSize;
  className?: string;
  label?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable="false"
      className={`ic${size === 12 ? " ic-12" : size === 14 ? " ic-14" : size === 20 ? " ic-20" : ""}${className ? ` ${className}` : ""}`}
    >
      {draw(GLYPHS[name])}
    </svg>
  );
}
