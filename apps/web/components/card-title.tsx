import { Icon, type IconName } from "@/components/icon";
import { IconTile } from "@/components/ui/icon-tile";

/** Card head title: a 32px IconTile, then a 15px ink title over a 13px muted sub line. */
export function CardTitle({ id, icon, title, sub }: { id: string; icon: IconName; title: string; sub?: React.ReactNode }) {
  return (
    <div className="ctitle">
      <IconTile size="md">
        <Icon name={icon} />
      </IconTile>
      <span className="ctitle-text">
        <h2 id={id} className="ctitle-h">{title}</h2>
        {/* A plain sub cuts off with its full text in title. A rich sub (one holding a <When> or
            another tipped node) wraps instead: an ellipsis box clips the tip it holds. */}
        {typeof sub === "string" ? (
          <span className="ctitle-sub ellipsis" title={sub}>
            {sub}
          </span>
        ) : sub ? (
          <span className="ctitle-sub">{sub}</span>
        ) : null}
      </span>
    </div>
  );
}
