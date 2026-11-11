"use client";

import { useState } from "react";
import { CardTitle } from "@/components/card-title";
import { Icon } from "@/components/icon";
import { ActorAvatar } from "@/components/ui/actor-avatar";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Empty } from "@/components/ui/empty";
import { EnvTag } from "@/components/ui/env-tag";
import { SkelRows } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { When } from "@/components/ui/when";
import { describe } from "@/lib/feedback";
import { plural } from "@/lib/format";
import type { EnvVersion } from "@/lib/pages/project-detail";
import { summarize, TARGET_LABEL } from "./env-model";

/* Keys only: history never holds a value. A rollback writes a new version and redeploys what it reaches. */

const FIRST = 8;
const OP_SIGN = { add: "+", change: "~", remove: "-" } as const;
const OP_LABEL = { add: "Added", change: "Changed", remove: "Removed" } as const;
const SOURCE_LABEL: Record<EnvVersion["source"], string> = { dashboard: "Dashboard", api: "API token", rollback: "Rollback" };

function VersionRow({ v, current, many, now, onRollback }: { v: EnvVersion; current: boolean; many: boolean; now: number; onRollback: () => void }) {
  const [open, setOpen] = useState(false);
  const id = `px-ver-${v.version}`;
  const what = v.source === "rollback" && v.restoredFrom ? `Restored version ${v.restoredFrom.toLocaleString("en-US")}` : summarize(v.changes);
  return (
    <li className="px-ver" data-open={open || undefined}>
      <div className="px-ver-row">
        {/* The change list is only in the page while open, so it is only pointed at then. */}
        <button type="button" className="px-ver-toggle" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((o) => !o)}>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={14} className="px-ver-chev" />
          <span className="px-ver-num num">v{v.version.toLocaleString("en-US")}</span>
          <ActorAvatar kind={v.actorKind} url={v.actorAvatarUrl} name={v.actor} size={24} />
          <span className="two">
            <span className="two-main px-ver-main">
              <span className="ellipsis">{what}</span>
              {current ? <Chip size="xs" tone="ok">Current</Chip> : null}
            </span>
            <span className="two-sub ellipsis">
              {v.actor}, {SOURCE_LABEL[v.source].toLowerCase()}
              {v.redeployed ? `, redeployed ${plural(v.redeployed, "app")}` : ""}
            </span>
          </span>
        </button>
        <span className="px-ver-when num">
          <When iso={v.at} now={now} tipAlign="end" />
        </span>
        <span className="px-ver-act">
          {current ? null : (
            <button type="button" className="btn btn-xs" onClick={onRollback}>
              Roll back
            </button>
          )}
        </span>
      </div>
      {open ? (
        <ul id={id} className="px-ver-changes" aria-label={`Changes in version ${v.version}`}>
          {v.changes.map((c, i) => (
            <li key={`${c.environment}-${c.appId ?? ""}-${c.key}-${i}`} className="px-ver-change">
              <span className="px-ver-sign" data-op={c.op}>
                <span aria-hidden="true">{OP_SIGN[c.op]}</span>
                <span className="sr">{OP_LABEL[c.op]}</span>
              </span>
              <span className="px-ver-key">
                {c.key}
                {c.secret ? <Icon name="lock" size={14} className="ev-var-lock" label="Secret" /> : null}
              </span>
              <span className="px-ver-scope">
                {many ? <EnvTag env={c.environment} quiet compact /> : null}
                {c.appName ? <span className="px-ver-app">{c.appName}</span> : <span className="px-ver-app">Shared</span>}
              </span>
              <span className="px-ver-target">{TARGET_LABEL[c.target]}</span>
            </li>
          ))}
          {v.changes.length === 0 ? <li className="px-ver-change none">No variable changed</li> : null}
        </ul>
      ) : null}
    </li>
  );
}

export function HistoryCard({
  versions,
  error,
  loading,
  current,
  now,
  pending,
  many = true,
  onRollback,
}: {
  versions: EnvVersion[] | null;
  error?: string;
  loading: boolean;
  /** The stored version number, so the right row reads Current. */
  current: number;
  now: number;
  /** Staged edits block a rollback, which would throw them away. */
  pending: number;
  /** Whether the project shows its environments (lib/environments.ts). */
  many?: boolean;
  onRollback: (version: number, redeploy: boolean) => Promise<boolean>;
}) {
  const [all, setAll] = useState(false);
  const [target, setTarget] = useState<EnvVersion | null>(null);
  const [redeploy, setRedeploy] = useState(true);
  const list = versions ?? [];
  const shown = all ? list : list.slice(0, FIRST);

  return (
    <section className="card" aria-labelledby="px-hist-title">
      <div className="card-hd">
        <CardTitle id="px-hist-title" icon="history" title="Version history" sub="Who changed what, and when. History keeps keys, never values." />
      </div>
      {loading ? (
        <div className="px-ver-wrap">
          <SkelRows rows={4} height={56} template="14px 40px 24px minmax(0,1fr) 72px 88px" cols={[14, 32, 24, { w: "50%", lines: 2 }, 48, 72]} />
        </div>
      ) : !versions ? (
        <Empty
          icon="history"
          title="History is unavailable"
          body={error ? `${describe([error, "Reload the page to try again"])}.` : "The Dockify API did not return this project’s variable history."}
        />
      ) : list.length === 0 ? (
        <Empty icon="history" title="No versions yet" body="The first change you apply becomes version 1. Every later one is kept here and can be rolled back to." />
      ) : (
        <div className="px-ver-wrap">
          <ul className="px-vers" aria-label="Variable versions">
            {shown.map((v) => (
              <VersionRow
                key={v.version}
                v={v}
                current={v.version === current}
                many={many}
                now={now}
                onRollback={() => {
                  setRedeploy(true);
                  setTarget(v);
                }}
              />
            ))}
          </ul>
          {list.length > FIRST ? (
            <div className="px-more">
              <button type="button" className="btn btn-sm" onClick={() => setAll((a) => !a)}>
                {all ? "Show fewer" : `Show all ${list.length.toLocaleString("en-US")}`}
              </button>
            </div>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        open={target !== null}
        onClose={() => setTarget(null)}
        title={`Roll back to v${target?.version.toLocaleString("en-US") ?? ""}`}
        confirmLabel="Roll back variables"
        confirmIcon="rollback"
        body={
          <>
            <p className="px-confirm-p">
              Every variable goes back to how it was in version {target?.version.toLocaleString("en-US")}. This writes version {(current + 1).toLocaleString("en-US")}; nothing in history is lost.
            </p>
            {pending ? <p className="px-confirm-p tone-warn">Your {plural(pending, "pending change")} will be discarded.</p> : null}
            <label className="px-inline-switch px-confirm-switch">
              <Switch checked={redeploy} onChange={setRedeploy} label="Redeploy affected apps now" />
              <span aria-hidden="true">Redeploy affected apps now</span>
            </label>
          </>
        }
        onConfirm={async () => {
          if (!target) return;
          if (!(await onRollback(target.version, redeploy))) throw new Error("Rollback failed");
        }}
      />
    </section>
  );
}
