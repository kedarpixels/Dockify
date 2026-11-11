"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { CardTitle } from "@/components/card-title";
import { DeployRow } from "@/components/overview/deploy-row";
import { StatusChip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Empty } from "@/components/ui/empty";
import { EnvTag } from "@/components/ui/env-tag";
import { GroupHead } from "@/components/ui/group-head";
import { NO_APPS, notRunning, PROJECT_STATE_LABEL, projectTone, type Tone } from "@/lib/derive";
import { bytes } from "@/lib/format";
import type { AppUsage } from "@/lib/pages/project-detail";
import { useDayHeading } from "@/lib/time-prefs";
import type { AppStatus, RecentDeployment } from "@/lib/types";
import { useCan } from "@/lib/viewer";

export { KIND_LABEL } from "@/lib/app-role";

/** The same project state rule as the projects page (projectTone): worst app wins. */
export function projectState(apps: Array<{ status: AppStatus }>): { tone: Tone; label: string } {
  const tone = projectTone(new Set(apps.map((a) => a.status)));
  return { tone, label: apps.length ? PROJECT_STATE_LABEL[tone] : NO_APPS };
}


export { isManaged } from "@/lib/app-source";

/** A URL without its scheme and trailing slash: "https://horseai.example/" reads "horseai.example". */
export const hostOf = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

/** A CPU amount: "0.5 vCPU", "2 vCPU". The one unit for CPU everywhere an app's limit is named. */
export const cores = (n: number) => `${n.toLocaleString("en-US")} vCPU`;

/** The URL stays the source of truth; the first tab is the bare URL and an unknown value falls back to it. */
export function useUrlTab<T extends string>(tabs: readonly T[]) {
  const param = useSearchParams().get("tab");
  const fromUrl = tabs.find((t) => t === param) ?? tabs[0]!;
  const [tab, setTab] = useState<T>(fromUrl);
  const [seen, setSeen] = useState(param);
  // The local state answers a click at once; a URL change from elsewhere overrides it.
  if (param !== seen) {
    setSeen(param);
    setTab(fromUrl);
  }

  const change = useCallback(
    (next: T) => {
      setTab(next);
      const url = new URL(window.location.href);
      if (next === tabs[0]) url.searchParams.delete("tab");
      else url.searchParams.set("tab", next);
      window.history.replaceState(null, "", url);
    },
    [tabs],
  );

  return [tab, change] as const;
}

/** One order on both pages: the state, the environments when the project shows them, then the quiet facts as children. */
export function DetailLead({ tone, state, envs, children }: { tone: Tone; state: string; envs: string[]; children?: React.ReactNode }) {
  return (
    <span className="pd-lead">
      <StatusChip tone={tone}>{state}</StatusChip>
      {envs.length ? (
        <span className="pj-envs">
          {envs.map((e) => (
            <EnvTag key={e} env={e} />
          ))}
        </span>
      ) : null}
      {children}
    </span>
  );
}

const PIPS = 8;

/** A pip meter: 8 app pips, lit up to the share used, toned by load; the exact share is its tip. */
function UsagePips({ label, pct, detail }: { label: string; pct: number; detail: string }) {
  const lit = pct <= 0 ? 0 : Math.max(1, Math.round((Math.min(pct, 100) / 100) * PIPS));
  const tone = pct > 85 ? "bad" : pct > 70 ? "warn" : "ok";
  return (
    <span className="pd-res" role="img" aria-label={`${label} ${Math.round(pct)} percent, ${detail}`} data-tip={`${label} ${Math.round(pct)}%, ${detail}`}>
      <span className="pd-res-label">{label}</span>
      <span className="pips pd-pips" aria-hidden="true">
        {Array.from({ length: PIPS }, (_, i) => (
          <i key={i} data-tone={i < lit ? tone : undefined} data-off={i >= lit || undefined} />
        ))}
      </span>
    </span>
  );
}

export function ResourcePips({ usage, status }: { usage?: AppUsage; status: AppStatus }) {
  if (!usage) return <span className="pd-res-none">No usage data yet</span>;
  if (notRunning(status)) return <span className="pd-res-none">Not running</span>;
  const memPct = usage.memoryLimitBytes ? (usage.memoryBytes / usage.memoryLimitBytes) * 100 : 0;
  return (
    <span className="pd-res-row">
      <UsagePips label="CPU" pct={usage.cpuPct} detail="of its limit" />
      <UsagePips label="Memory" pct={memPct} detail={`${bytes(usage.memoryBytes)} of ${bytes(usage.memoryLimitBytes)}`} />
    </span>
  );
}

export function DeployCard({
  deployments,
  now,
  sub,
  emptyBody,
  scope,
}: {
  deployments: RecentDeployment[];
  now: number;
  sub: string;
  emptyBody: string;
  /** What the page already names, so rows do not repeat it (see DeployRow). */
  scope: "project" | "app";
}) {
  const heading = useDayHeading();
  const groups: Array<{ label: string; rows: RecentDeployment[] }> = [];
  for (const d of deployments) {
    const label = heading(d.createdAt, now);
    if (groups.at(-1)?.label === label) groups.at(-1)!.rows.push(d);
    else groups.push({ label, rows: [d] });
  }
  return (
    <section className="card dep-card" aria-labelledby="pd-dep-title">
      <div className="card-hd">
        <CardTitle id="pd-dep-title" icon="deploy" title="Deployments" sub={sub} />
        <Link href="/deployments" className="btn btn-sm">
          View all deployments
        </Link>
      </div>
      {deployments.length === 0 ? (
        <Empty icon="deploy" title="No deployments yet" body={emptyBody} />
      ) : (
        <div className="dep-list">
          {groups.map((g) => (
            <section key={g.label} aria-label={g.label}>
              <GroupHead label={g.label} count={g.rows.length} noun="deployment" />
              <ul className="soft-list">
                {g.rows.map((d) => (
                  <li key={d.id}>
                    <DeployRow d={d} now={now} scope={scope} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

export function Optional({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <span className="pd-opt">Optional</span>
    </>
  );
}

/** Only the action key carries red. A Viewer can take none of these actions, so gets no danger zone at all. */
export function DangerZone({ rows }: { rows: Array<{ title: string; body: string; action: string; onAction: () => void }> }) {
  const can = useCan();
  if (!can.manage) return null;
  return (
    <section className="card" aria-labelledby="pd-danger-title">
      <div className="card-hd">
        <CardTitle id="pd-danger-title" icon="alert" title="Danger zone" sub="Actions that cannot be undone" />
      </div>
      <div className="pd-danger">
        <ul className="pd-danger-box">
          {rows.map((r) => (
            <li key={r.title} className="pd-danger-row">
              <span className="two">
                <span className="two-main">{r.title}</span>
                <span className="two-sub">{r.body}</span>
              </span>
              <button type="button" className="btn btn-quiet-danger" onClick={r.onAction}>
                {r.action}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// `onConfirm` toasts its own result and resolves to whether it worked. On success the dialog stays
// open and pending while the page navigates away, so a second press cannot send a second delete.
export function DeleteDialog({
  open,
  onClose,
  name,
  title,
  body,
  action,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  name: string;
  title: string;
  body: string;
  action: string;
  onConfirm: () => Promise<boolean>;
}) {
  const [leaving, setLeaving] = useState(false);
  // The dialog closes itself right after onConfirm resolves, from a closure made before this
  // render; the ref lets that close see the navigation already under way.
  const gone = useRef(false);
  return (
    <ConfirmDialog
      open={open}
      onClose={() => {
        if (!gone.current) onClose();
      }}
      tone="danger"
      title={title}
      body={body}
      confirmLabel={action}
      confirmIcon="trash"
      confirmText={name}
      busy={leaving || undefined}
      onConfirm={async () => {
        if (!(await onConfirm())) throw new Error("Delete failed");
        gone.current = true;
        setLeaving(true);
      }}
    />
  );
}
