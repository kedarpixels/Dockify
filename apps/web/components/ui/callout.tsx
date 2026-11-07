import { Icon, type IconName } from "@/components/icon";
import { cx } from "./cx";

/*
 * The one boxed note: an icon, the text, and optionally one button on the right. Every note with an
 * icon is this, never a local box. A neutral grey box by default; `tone` tints it for success, a
 * warning or a problem, and "info" keeps the neutral box with a blue glyph (a hint, not a state).
 *
 *   <Callout icon="info">Backups stay on this server until storage is set up.</Callout>
 *   <Callout tone="info">The code expires in 10 minutes.</Callout>
 *   <Callout tone="warn" icon="alert" action={<button className="btn btn-sm">Set up</button>}>…</Callout>
 *   <Callout tone="bad" icon="alert" role="alert">The build failed at Install.</Callout>
 */
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
  /** One button, placed on the right and vertically centred. */
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
