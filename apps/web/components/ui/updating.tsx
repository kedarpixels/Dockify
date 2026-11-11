import { Icon } from "@/components/icon";
import { cx } from "./cx";

/** Shown only while a poll is in flight. */
export function Updating({ label = "Updating", className }: { label?: string; className?: string }) {
  return (
    <span className={cx("updating", className)} role="status">
      <Icon name="refresh" size={14} className="spin" />
      {label}
    </span>
  );
}
