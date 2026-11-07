"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { send } from "@/components/server-backups/use-poll";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Skel } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { callJson } from "@/lib/client-api";
import { errText } from "@/lib/feedback";
import { plural } from "@/lib/format";
import type { AppDetail, ServiceVersionView } from "@/lib/pages/project-detail";
import { TabCard } from "./states";

/*
 * Changing a managed database's version, on its Settings tab, for admins. The API refuses a
 * downgrade, so the list never holds an older version. What each path does is said before the press:
 * a new Postgres major goes through a copy the owner then switches to, and the old service stays until
 * they delete it. While the worker runs it this polls, and nothing stale is shown while it loads.
 */

const POLL_MS = 3_000;
const WORKING = new Set(["backing_up", "upgrading", "copying", "switching"]);
const STEP: Record<string, string> = {
  backing_up: "Taking a backup",
  upgrading: "Starting the new version on the same data",
  copying: "Restoring the backup into the new service",
  switching: "Apps are stopped. Copying the latest data, then switching",
};

type Pending = { type: "change"; version: string; newService: boolean } | { type: "switch" } | { type: "back" };

const counts = (c: { tables: number; rows: number } | null) => (c ? `${plural(c.tables, "table")}, ${plural(c.rows, "row")}` : "unknown");

export function VersionSection({ app }: { app: AppDetail }) {
  const url = `/api/apps/${app.id}/service-version`;
  const [view, setView] = useState<ServiceVersionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  // One read now, and one every few seconds while the worker runs. A read that lands after leaving is dropped.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let left = false;
    void callJson<ServiceVersionView>(url).then((r) => {
      if (left) return;
      if (r.ok) {
        setView(r.data);
        setError(null);
      } else setError(r.error);
    });
    return () => {
      left = true;
    };
  }, [url, tick]);

  const phase = view?.upgrade?.phase;
  const working = !!view && (view.busy || (phase ? WORKING.has(phase) : false));
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => setTick((n) => n + 1), POLL_MS);
    return () => clearInterval(t);
  }, [working]);

  const options = view?.options ?? [];
  const label = view?.kind === "postgres" ? "Postgres" : "Redis";
  const choice = picked ?? options.at(-1)?.version ?? "";
  const option = options.find((o) => o.version === choice);
  const samePatch = choice === view?.version;

  const run = async () => {
    if (!pending) return;
    const path = pending.type === "change" ? url : `${url}/${pending.type}`;
    const body = pending.type === "change" ? { version: pending.version, confirm: app.name } : { confirm: app.name };
    try {
      setView(await send<ServiceVersionView>(path, "POST", body));
    } catch (e) {
      toast.error("Could not change the version", { description: errText(e) });
      throw e;
    }
  };

  if (error && !view) return <TabCard id="at-ver-title" icon="database" title="Version" sub="Could not read it"><Callout tone="warn" icon="alert">{error}</Callout></TabCard>;
  if (!view) return <TabCard id="at-ver-title" icon="database" title="Version" sub="Reading"><Skel w={240} h={36} /></TabCard>;

  const up = view.upgrade;
  const linked = view.linkedApps;
  const linkedLine = linked.length ? `${plural(linked.length, "app")} linked: ${linked.map((a) => a.name).join(", ")}` : "No app links to it";

  return (
    <TabCard id="at-ver-title" icon="database" title="Version" sub={`${label} ${view.version ?? "unknown"}${view.pin ? `, ${view.pin.slice(0, 19)}` : ""}`}>
      <div className="pd-form">
        {working ? (
          <Callout tone="info" icon="info" role="status">
            <b className="pd-strong">{STEP[phase ?? ""] ?? "Working"}.</b> It keeps going if you leave this page.
          </Callout>
        ) : null}

        {!working && view.redirect ? (
          <>
            <Callout tone="info" icon="info" action={<button type="button" className="btn btn-sm" onClick={() => setPending({ type: "back" })}>Switch back</button>}>
              Linked apps now use <Link className="na-link" href={`/apps/${view.redirect.id}`}>{view.redirect.name}</Link>. {app.name} keeps running with its data until you delete it. Deleting it keeps {view.redirect.name} and makes those links its own.
            </Callout>
          </>
        ) : null}

        {!working && !view.redirect && phase === "ready" && up?.target ? (
          <>
            <Callout tone="info" icon="info" action={<button type="button" className="btn btn-sm btn-primary" onClick={() => setPending({ type: "switch" })}>Switch</button>}>
              <b className="pd-strong">The copy in <Link className="na-link" href={`/apps/${up.target.id}`}>{up.target.name}</Link> is ready.</b> {app.name} holds {counts(up.sourceCounts)}, the copy holds {counts(up.targetCounts)}. A small difference is writes made since. {linkedLine}.
            </Callout>
          </>
        ) : null}

        {!working && phase === "failed" && up ? (
          <Callout tone="warn" icon="alert">
            <b className="pd-strong">The change stopped.</b> {up.error ?? "No reason was recorded."} {app.name} still has all its data.
          </Callout>
        ) : null}

        {!working && !view.redirect && phase !== "ready" ? (
          options.length ? (
            <>
              <div className="pd-pair">
                <Field label="Move to" hint={samePatch ? "The newest patch of this version." : "Older versions are not offered: a newer server's data does not open in an older one."}>
                  {(ids) => (
                    <Select
                      ids={ids}
                      label="Version to move to"
                      value={choice}
                      onChange={(v) => setPicked(v)}
                      options={options.map((o) => ({ value: o.version, label: o.version === view.version ? `${label} ${o.version}, newest patch` : `${label} ${o.version}` }))}
                    />
                  )}
                </Field>
              </div>
              <Callout
                tone="info"
                icon="info"
                action={
                  <button type="button" className="btn btn-sm btn-primary" disabled={!option} onClick={() => setPending({ type: "change", version: choice, newService: option?.path === "new_service" })}>
                    {phase === "failed" ? "Try again" : option?.path === "new_service" ? "Copy" : samePatch ? "Update" : "Upgrade"}
                  </button>
                }
              >
                {option?.path === "new_service"
                  ? `A major version cannot open the old data. Dockify takes a backup, restores it into a new service at ${label} ${choice} and checks it. Nothing changes for your apps until you confirm the switch, and ${app.name} stays until you delete it.`
                  : `Dockify takes a backup, then restarts ${app.name} on the new image with the same data, so it is down for a moment. If it does not come up healthy, the old container runs again.${view.kind === "redis" && !samePatch ? " Going back later means restoring that backup, since an older Redis cannot read a newer snapshot." : ""}`}
              </Callout>
            </>
          ) : (
            <Callout tone="info" icon="info">This image is not one Dockify can change the version of.</Callout>
          )
        ) : null}
      </div>

      <ConfirmDialog
        open={pending?.type === "change"}
        onClose={() => setPending(null)}
        onConfirm={run}
        title={pending?.type === "change" && pending.newService ? `Copy to ${label} ${pending.version}` : "Change the version"}
        confirmText={app.name}
        confirmLabel="Start"
        body={pending?.type === "change" && pending.newService
          ? `This takes a backup and creates a second service, using more disk and memory while both run. Your apps keep using ${app.name}.`
          : `This takes a backup, then restarts ${app.name}. ${linkedLine}, and connections drop for a moment.`}
      />
      <ConfirmDialog
        open={pending?.type === "switch"}
        onClose={() => setPending(null)}
        onConfirm={run}
        tone="danger"
        title={`Switch to ${up?.target?.name ?? "the new service"}`}
        confirmText={app.name}
        confirmLabel="Stop apps and switch"
        body={`Every app in this environment stops while the latest data is copied, then ${linked.length ? "the linked apps redeploy on the new service" : "they start again"}. The size of the database decides how long. Counts must match exactly or nothing switches. A connection string typed by hand is not a link: change those yourself.`}
      />
      <ConfirmDialog
        open={pending?.type === "back"}
        onClose={() => setPending(null)}
        onConfirm={run}
        tone="danger"
        title={`Switch back to ${app.name}`}
        confirmText={app.name}
        confirmLabel="Switch back"
        body={`Linked apps redeploy on ${app.name}. Anything written to ${view.redirect?.name ?? "the new service"} since the switch stays there and is not in ${app.name}.`}
      />
    </TabCard>
  );
}
