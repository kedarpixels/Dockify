import { Icon, type IconName } from "@/components/icon";
import { cx } from "./cx";

/*
 * The small header row above a group in a list: a 32px line of 13px muted text, an optional glyph
 * or a 20px AppIcon or ProjectIcon (`lead`) before it and a count after it. Always a heading (h3 by default) so the groups
 * read as an outline. It lines up with soft-list rows (8px inset).
 *
 *   <GroupHead label="Today" count={6} noun="deployment" />
 *   <GroupHead label="horseai" lead={<ProjectIcon slug="horseai" />} count={3} noun="app" />
 *   <GroupHead label="Databases" icon="database" count={2} noun="database" actions={<button className="btn btn-xs">Back up all</button>} />
 *
 * A day group always carries its count. The count is read as its own phrase ("Today, 6
 * deployments", "Today, 1 deployment"), never run into the name ("Today 6"); `noun` names one of
 * what is counted, and the head says it in the plural when the count is not 1.
 */
export function GroupHead({
  label,
  count,
  noun,
  icon,
  lead,
  as: H = "h3",
  id,
  actions,
  className,
}: {
  label: string;
  count?: number;
  /** What the count counts, one of it ("deployment"), for screen readers; an "s" is added for any other count. */
  noun?: string;
  icon?: IconName;
  /** An app or project icon instead of a glyph. */
  lead?: React.ReactNode;
  as?: "h2" | "h3" | "h4";
  id?: string;
  /** Keys at the right end of the row. */
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("ghead", className)}>
      <H id={id} className="ghead-h">
        {lead ?? (icon ? <Icon name={icon} size={14} /> : null)}
        <span className="ellipsis" title={label}>
          {label}
        </span>
        {count !== undefined ? (
          <span className="ghead-count num">
            <span className="sr">, </span>
            {/* In brackets, so a count after a date ("Sat 7 Nov (19)") never reads as part of it. */}
            <span aria-hidden="true">(</span>
            {count.toLocaleString("en-US")}
            <span aria-hidden="true">)</span>
            {noun ? <span className="sr"> {count === 1 ? noun : `${noun}s`}</span> : null}
          </span>
        ) : null}
      </H>
      {actions ? <div className="ghead-actions">{actions}</div> : null}
    </div>
  );
}
