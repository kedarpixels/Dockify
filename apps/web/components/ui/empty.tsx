import { Icon, type IconName } from "@/components/icon";
import { IconTile } from "./icon-tile";

// The title is an h3 under a card or section head; a page made of nothing but this state passes
// `as="h1"`. Titles: "No <things> yet", "No <things> match", "<Thing> is unavailable".
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
