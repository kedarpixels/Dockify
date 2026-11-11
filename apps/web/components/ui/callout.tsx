import { Icon, type IconName } from "@/components/icon";
import { cx } from "./cx";

// Every note with an icon is this, never a local box. "info" keeps the neutral box with a blue
// glyph: a hint, not a state.
export function Callout({
  tone,
  icon = "info",
  action,
  role = "note",
  className,
  children,
}: {
  tone?: "ok" | "warn" | "bad" | "info";
  /** "alert" for an error the reader must hear at once, "status" for a quiet update. */
  role?: "note" | "alert" | "status";
  icon?: IconName | null;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cx("callout", className)} data-tone={tone} role={role}>
      {icon ? <Icon name={icon} size={16} /> : null}
      <div className="callout-text">{children}</div>
      {action}
    </div>
  );
}
