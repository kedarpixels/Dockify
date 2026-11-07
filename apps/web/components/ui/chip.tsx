import Link from "next/link";
import { cx } from "./cx";

/** The status tones a dot can take. */
export type ChipTone = "ok" | "live" | "warn" | "pending" | "bad" | "idle";

type ChipProps = {
  /** Optional leading glyph (muted, ink on hover). */
  icon?: React.ReactNode;
  /** Chosen state: the soft blue tint. Sets aria-pressed on buttons. */
  picked?: boolean;
  /** "md" 32px (default, 14px text), "sm" 28px (13px text), "xs" 20px (12px text, weight 500), the tag inside a row title. */
  size?: "md" | "sm" | "xs";
  /** Round 6px status dot before the label, coloured by tone. */
  tone?: ChipTone;
  className?: string;
  title?: string;
  /** Hover tip on the chip itself, so no wrapper span stretches the row or drops the chip 2px. */
  tip?: string;
  tipAlign?: "end";
  children: React.ReactNode;
};

/**
 * Flat pill: page fill and a hairline ring (the surface-key material).
 * Renders a <Link> with `href`, a <button> with `onClick`, otherwise a plain <span>.
 */
export function Chip({
  icon,
  picked,
  size = "md",
  tone,
  className,
  title,
  tip,
  tipAlign,
  children,
  href,
  onClick,
  disabled,
}: ChipProps & { href?: string; onClick?: React.MouseEventHandler<HTMLButtonElement>; disabled?: boolean }) {
  const cls = cx("chip", picked ? "surface-key-picked" : "surface-key", className);
  const tipProps = tip ? { "data-tip": tip, "data-tip-align": tipAlign } : {};
  const inner = (
    <>
      {tone ? <span className="dot" data-tone={tone} aria-hidden="true" /> : null}
      {icon ? (
        <span className="chip-ic" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span>{children}</span>
    </>
  );
  if (href) {
    return (
      <Link href={href} className={cls} data-size={size} data-picked={picked || undefined} title={title} {...tipProps}>
        {inner}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button
        type="button"
        className={cls}
        data-size={size}
        data-picked={picked || undefined}
        aria-pressed={picked}
        onClick={onClick}
        disabled={disabled}
        title={title}
        {...tipProps}
      >
        {inner}
      </button>
    );
  }
  return (
    <span className={cls} data-size={size} data-picked={picked || undefined} title={title} {...tipProps}>
      {inner}
    </span>
  );
}

/**
 * The one status mark: the state's name in a 28px chip led by its tone dot. Use it for a status
 * column in any list and for the status in a card head or detail lead. Other marks stay in their
 * lanes: an xs Chip is a tag inside a title ("You", "This device", a scope), and a bare dot with
 * text lives only inside Select and Segmented options.
 *
 *   <StatusChip tone="ok">Running</StatusChip>
 *   <StatusChip tone="bad" tip="Exited with code 137">Stopped</StatusChip>
 */
export function StatusChip({
  tone,
  tip,
  tipAlign,
  className,
  children,
}: {
  tone: ChipTone;
  /** More about the state (an exit code, a reason), on hover and focus. */
  tip?: string;
  tipAlign?: "end";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Chip size="sm" tone={tone} tip={tip} tipAlign={tipAlign} className={className}>
      {children}
    </Chip>
  );
}
