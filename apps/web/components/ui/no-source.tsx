import type { IconName } from "@/components/icon";
import { cx } from "./cx";
import { Empty } from "./empty";
import { clause } from "@/lib/format";

/** An error as the start of a sentence: no trailing full stop, so ". Reload..." never doubles it. */

/**
 * The page's state when its data cannot come from the API, the same card and the same sentences on
 * every page:
 *   - no API configured (no `error`): "No data source" / "Set DOCKIFY_API_URL for this dashboard.
 *     Nothing is shown until real data arrives."
 *   - the API did not answer (`error`): "Cannot reach the Dockify API" / "{error}. This page retries
 *     on its own." on a page that polls, else "{error}. Reload the page to try again.", with a
 *     Try again key (`onRetry`, or a plain reload).
 *
 *   {source === "none" ? <NoSource /> : null}
 *   {result.error ? <NoSource error={result.error} polling /> : null}
 *
 * It is a card, a block of its own: render it where the page's content would start, under the page
 * head (its title is an h2 under the page's h1).
 */
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
