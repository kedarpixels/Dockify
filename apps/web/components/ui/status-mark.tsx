import { Icon, type IconName } from "@/components/icon";
import type { Tone } from "@/lib/derive";

/** Without `icon` it is a spinning loader. Its label is its accessible name. */
export function StatusMark({ tone, label, icon }: { tone: Tone; label: string; icon?: IconName | null }) {
  return (
    <span className="st-app" data-tone={tone} role="img" aria-label={label}>
      <span className="st-mark">
        <Icon name={icon ?? "loader"} size={14} className={icon ? undefined : "spin"} />
      </span>
    </span>
  );
}
