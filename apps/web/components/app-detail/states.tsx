"use client";

import { CardTitle } from "@/components/card-title";
import type { IconName } from "@/components/icon";
import { Empty } from "@/components/ui/empty";
import { apiErrorMessage } from "@/lib/http-status";
import { clause } from "@/lib/format";

/** The card is the `at-tab` container its grids measure (app-tabs.css), so a tab lays out by its own width. */
export function TabCard({
  id,
  icon,
  title,
  sub,
  actions,
  className,
  children,
}: {
  id: string;
  icon: IconName;
  title: string;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={className ? `card at-tab ${className}` : "card at-tab"} aria-labelledby={id}>
      <div className="card-hd">
        <CardTitle id={id} icon={icon} title={title} sub={sub} />
        {actions ? <span className="pd-hd-acts">{actions}</span> : null}
      </div>
      {children}
    </section>
  );
}

/* The tab routes keep only the status text, and the worker answers a read of a container that is
   down (or has no address) with 409, so that text is how a tab tells "not running" from a failure. */
const CONFLICT = apiErrorMessage(409);

/** Retry re-reads the tab only. `idle` replaces the bare status text when the container is not running. */
export function TabFailed({ error, onRetry, idle, what = "This tab" }: { error: string | null; onRetry: () => void; idle?: string; what?: string }) {
  if (!error) {
    return <Empty icon="server" title="No data source" body="Set DOCKIFY_API_URL for this dashboard. Nothing is shown until real data arrives." />;
  }
  const retry = (
    <button type="button" className="btn btn-sm" onClick={onRetry}>
      Try again
    </button>
  );
  if (idle && error === CONFLICT) return <Empty icon="database" title="Not running" body={idle} action={retry} />;
  return <Empty icon="alert" title={`${what} is unavailable`} body={`${clause(error)}. The rest of the page still works.`} action={retry} />;
}

/** What an admin-only tab shows a Viewer, in place of a read the API would refuse. */
export function AdminOnly({ body }: { body: string }) {
  return (
    <div className="card">
      <Empty icon="lock" title="Admins only" body={body} />
    </div>
  );
}
