import type { IconName } from "@/components/icon";
import { cx } from "./cx";
import { Empty } from "./empty";
import { clause } from "@/lib/format";

/** A card of its own: render it where the page's content would start (its title is an h2 under the page's h1). */
export function NoSource({
  error,
  polling = false,
  onRetry,
  icon = "server",
  className,
}: {
  /** Why the API did not answer ("The API took too long to answer"). Without it, no API is set at all. */
  error?: string | null;
  /** The page polls and recovers by itself. */
  polling?: boolean;
  /** Retry in place; without it, Try again reloads the page. Pass it from a client component. */
  onRetry?: () => void;
  icon?: IconName;
  className?: string;
}) {
  if (!error) {
    return (
      <div className={cx("card", className)}>
        <Empty as="h2" icon={icon} title="No data source" body="Set DOCKIFY_API_URL for this dashboard. Nothing is shown until real data arrives." />
      </div>
    );
  }
  return (
    <div className={cx("card", className)}>
      <Empty
        as="h2"
        icon={icon}
        title="Cannot reach the Dockify API"
        body={`${clause(error)}. ${polling ? "This page retries on its own." : "Reload the page to try again."}`}
        action={
          onRetry ? (
            <button type="button" className="btn btn-sm" onClick={onRetry}>
              Try again
            </button>
          ) : (
            // A plain link back to this address reloads the page, with or without the app's scripts.
            <a href="" className="btn btn-sm">
              Try again
            </a>
          )
        }
      />
    </div>
  );
}
