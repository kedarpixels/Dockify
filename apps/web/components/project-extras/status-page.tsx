"use client";

import Link from "next/link";
import { useState } from "react";
import { CardTitle } from "@/components/card-title";
import { Icon } from "@/components/icon";
import { ToggleRow } from "@/components/project-detail/controls";
import { CopyButton } from "@/components/ui/copy-button";
import { Empty } from "@/components/ui/empty";
import { SkelRows } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { describe } from "@/lib/feedback";
import { plural } from "@/lib/format";
import { useHydrated } from "@/lib/hooks";
import type { StatusPageState } from "@/lib/pages/project-detail";
import { useCan } from "@/lib/viewer";
import { send } from "./api";

/* The public status page switch. It flips at once and rolls back with an error toast when the
   write fails; while the write runs the switch keeps the focus and ignores presses. The page lists
   only apps with a public domain, with their health and uptime; it never shows logs, variables or
   internal services. A Viewer sees the setting and the link, not the switch's power. */

export function StatusPageCard({
  slug,
  state,
  error,
  loading,
  onChange,
}: {
  slug: string;
  state: StatusPageState | null;
  error?: string;
  loading: boolean;
  onChange: (s: StatusPageState) => void;
}) {
  const can = useCan();
  const [pending, setPending] = useState(false);
  // The host is only known in the browser: the bare path until hydrated, so both renders agree.
  const origin = useHydrated() ? window.location.origin : "";

  const flip = async (enabled: boolean) => {
    if (!state || pending || !can.manage) return;
    const before = state;
    onChange({ ...state, enabled });
    setPending(true);
    const r = await send({ type: "statusPage.set", slug, enabled });
    setPending(false);
    if (!r.ok) {
      onChange(before);
      toast.error(enabled ? "Could not publish the status page" : "Could not unpublish the status page", { description: describe([slug, r.error]) });
      return;
    }
    toast.success(enabled ? "Status page published" : "Status page unpublished", { description: describe([`${slug}, ${state.path}`], { preview: r.source === "preview" }) });
  };

  return (
    <section className="card" aria-labelledby="px-status-title">
      <div className="card-hd">
        <CardTitle id="px-status-title" icon="activity" title="Status page" sub="A public, read-only page with the health of this project’s public apps" />
      </div>
      {loading ? (
        <div className="px-status-body">
          <SkelRows rows={1} height={56} template="minmax(0,1fr) 36px" cols={[{ w: "50%", lines: 2 }, 36]} />
        </div>
      ) : !state ? (
        <Empty
          icon="activity"
          title="Status page setting is unavailable"
          body={error ? `${describe([error, "Reload the page to try again"])}.` : "The Dockify API did not return this setting."}
        />
      ) : (
        <div className="px-status-body">
          <ToggleRow
            title="Publish a status page"
            body={
              state.publicApps
                ? `Lists ${plural(state.publicApps, "app")} with a public domain, with uptime and incidents. Logs, variables and internal services never appear.`
                : "No app has a public domain yet, so the page would be empty until one does."
            }
            checked={state.enabled}
            disabled={!can.manage}
            onChange={(on) => void flip(on)}
          />
          {can.manage ? null : <p className="fld-note">Only an admin can publish or unpublish it.</p>}
          {state.enabled && /^\/status\/[a-z0-9_-]+$/i.test(state.path) ? (
            <div className="px-status-link">
              <Icon name="globe" size={14} />
              <Link href={state.path} target="_blank" rel="noreferrer" className="px-status-url">
                <span className="ellipsis">{origin ? `${origin.replace(/^https?:\/\//, "")}${state.path}` : state.path}</span>
                <Icon name="arrowUpRight" size={14} />
              </Link>
              <CopyButton value={`${origin}${state.path}`} what="status page link" align="end" />
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
