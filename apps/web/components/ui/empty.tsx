import { Icon, type IconName } from "@/components/icon";
import { IconTile } from "./icon-tile";

/**
 * Centred empty state: an IconTile, an ink title and one muted line. `action` (usually
 * `<button className="btn btn-sm">Clear filters</button>`) sits 16px under the line. "sm" is the
 * compact one for a small card or a dialog: 24px of padding and a 32px tile instead of 40px and 40px.
 * The title is an h3 under a card or section head; a page made of nothing but this state (a dead
 * link) passes `as="h1"` so the page still has its one top heading.
 *
 *   <Empty icon="deploy" title="No deployments yet" body="Push to an environment's branch." />
 *
 * Titles follow one pattern: "No <things> yet" for an empty collection, "No <things> match" for an
 * empty filter, "<Thing> is unavailable" for a failed read. A missing or unreachable API is NoSource.
 */
export function Empty({
  title,
  body,
  icon = "box",
  action,
  size = "md",
  as: H = "h3",
}: {
  title: string;
  body: React.ReactNode;
  icon?: IconName;
  action?: React.ReactNode;
  size?: "md" | "sm";
  /** The title's heading level: h3 inside a section (default), h2 directly under the page title, h1 alone on a page. */
  as?: "h1" | "h2" | "h3";
}) {
  return (
    <div className="empty-panel" data-size={size === "sm" ? "sm" : undefined}>
      <IconTile size={size === "sm" ? "md" : "lg"}>
        <Icon name={icon} />
      </IconTile>
      <H className="empty-title">{title}</H>
      <p>{body}</p>
      {action ? <div className="empty-act">{action}</div> : null}
    </div>
  );
}
