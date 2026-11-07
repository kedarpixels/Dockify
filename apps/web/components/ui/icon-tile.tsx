import { cx } from "./cx";

/**
 * Flat key framing a leading icon: the one glyph tile, always a rounded square.
 * size: "sm" 24px (info rows, toasts, notifications), "md" 32px (reach rows, card heads), "lg" 40px.
 * Pass any glyph as children, usually <Icon />. Hovering a parent with `.tile-host` lifts the glyph to ink.
 *
 * `tone` colours the glyph (an activity row that failed, a setting that is on); with `soft` the tile
 * is tinted too, the look of toast and notification icons.
 *
 *   <IconTile><Icon name="deploy" /></IconTile>
 *   <IconTile tone="bad"><Icon name="alert" /></IconTile>
 *   <IconTile tone="ok" soft><Icon name="checkCircle" /></IconTile>
 */
export function IconTile({
  size = "sm",
  tone,
  soft,
  className,
  children,
  ...rest
}: {
  size?: "sm" | "md" | "lg";
  tone?: "ok" | "warn" | "bad" | "info" | "live";
  soft?: boolean;
} & React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      data-tone={tone}
      {...rest}
      data-size={size}
      data-soft={(soft && tone) || undefined}
      className={cx("icon-tile surface-key", className)}
    >
      {children}
    </span>
  );
}
