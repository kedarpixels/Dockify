import { Icon } from "@/components/icon";
import { cx } from "./cx";

/**
 * The one "this page is refreshing" mark: muted "Updating" with the turning loader, in a page head's
 * actions before its keys, shown only while a poll is in flight. Every page that polls uses it the
 * same way, or none does.
 *
 *   <SectionHead level={1} title="Server" actions={<>{refreshing ? <Updating /> : null}<button ...>Back up now</button></>} />
 */
export function Updating({ label = "Updating", className }: { label?: string; className?: string }) {
  return (
    <span className={cx("updating", className)} role="status">
      <Icon name="refresh" size={14} className="spin" />
      {label}
    </span>
  );
}
