import { Icon, type IconName } from "@/components/icon";
import type { Tone } from "@/lib/derive";

/**
 * The one status mark for a run (a deployment, a backup, an update step, a preview): a 24px tile
 * tinted by tone holding a 14px glyph, or a spinning loader while it is in flight (no `icon`). Its
 * label is its accessible name.
 *
 *   <StatusMark tone="ok" label="Ready" icon="check" />
 *   <StatusMark tone="live" label="Building" />
 */
export function StatusMark({ tone, label, icon }: { tone: Tone; label: string; icon?: IconName | null }) {
  return (
    <span className="st-app" data-tone={tone} role="img" aria-label={label}>
      <span className="st-mark">
        <Icon name={icon ?? "loader"} size={14} className={icon ? undefined : "spin"} />
      </span>
    </span>
  );
}
