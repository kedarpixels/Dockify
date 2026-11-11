import { cx } from "./cx";

/** "sm" 24px, "md" 32px, "lg" 40px. Hovering a parent with `.tile-host` lifts the glyph to ink; `soft` tints the tile too. */
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
