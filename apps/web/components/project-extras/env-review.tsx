"use client";

import { useMemo, useState } from "react";
import { AppIcon } from "@/components/icons/app-icon";
import { Chip } from "@/components/ui/chip";
import { Dialog } from "@/components/ui/dialog";
import { EnvTag, envName } from "@/components/ui/env-tag";
import { GroupHead } from "@/components/ui/group-head";
import { PendingButton } from "@/components/ui/pending";
import { MaskDots } from "@/components/ui/secret";
import { Switch } from "@/components/ui/switch";
import { appTitle, plural } from "@/lib/format";
import type { AppSummary, EnvChange, EnvState } from "@/lib/pages/project-detail";
import { affectedApps, refViewOf, scopeId, summarize, TARGET_LABEL, varsOf } from "./env-model";
import { fieldLabel } from "./env-refs";

/* Review before apply: every staged change as a coloured diff line, grouped by where it lives,
   then the apps it reaches and whether each rebuilds or only restarts. Values are masked; the
   "Show values" switch reveals plain ones, and a secret only ever reads "new value". */

function Line({ sign, k, value, secret, plain, extra }: { sign: "+" | "-"; k: string; value: string | null | undefined; secret: boolean; plain: boolean; extra?: string }) {
  return (
    <li className="px-diff-line" data-sign={sign === "+" ? "add" : "remove"}>
      <span className="px-diff-sign" aria-hidden="true">
        {sign}
      </span>
      <span className="px-diff-key">{k}</span>
      <span className="px-diff-val">
        {value === undefined ? null : secret || !plain || value === null ? <MaskDots /> : value === "" ? <span className="none">Empty</span> : value}
      </span>
      {extra ? <span className="px-diff-extra">{extra}</span> : null}
      <span className="sr">{sign === "+" ? "after" : "before"}</span>
    </li>
  );
}

function ChangeLines({ c, state, apps, plain }: { c: EnvChange; state: EnvState; apps: AppSummary[]; plain: boolean }) {
  const base = varsOf(state, c).find((v) => v.key === c.key);
  // A link has no value to diff: it names the service it will read at deploy time.
  if (c.ref && c.op !== "remove") {
    const view = refViewOf(c.ref, apps);
    const links = `Links ${view.resourceName}, ${fieldLabel(view.kind, c.ref.field)}`;
    return (
      <>
        {base ? <Line sign="-" k={c.key} value={base.value} secret={base.secret} plain={plain} /> : null}
        <Line sign="+" k={c.key} value={null} secret plain={plain} extra={c.op === "add" ? `${links}, ${TARGET_LABEL[c.target ?? "runtime"].toLowerCase()}` : links} />
      </>
    );
  }
  if (c.op === "add") return <Line sign="+" k={c.key} value={c.value} secret={Boolean(c.secret)} plain={plain} extra={TARGET_LABEL[c.target ?? "runtime"]} />;
  if (c.op === "remove") return <Line sign="-" k={c.key} value={base?.value ?? null} secret={Boolean(base?.secret)} plain={plain} extra="Removed" />;
  const flags: string[] = [];
  if (base && c.target && c.target !== base.target) flags.push(`${TARGET_LABEL[base.target]} to ${TARGET_LABEL[c.target].toLowerCase()}`);
  if (base && c.secret !== undefined && c.secret !== base.secret) flags.push(c.secret ? "Now secret" : "No longer secret");
  const valueChanged = c.value !== undefined;
  const secret = Boolean(base?.secret || c.secret);
  return (
    <>
      {valueChanged ? <Line sign="-" k={c.key} value={base?.value ?? null} secret={secret} plain={plain} /> : null}
      <Line sign="+" k={c.key} value={valueChanged ? c.value : undefined} secret={secret} plain={plain} extra={flags.join(", ") || (secret && valueChanged ? "New value" : undefined)} />
    </>
  );
}

export function ReviewDialog({
  open,
  onClose,
  changes,
  many,
  state,
  apps,
  busy,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  changes: EnvChange[];
  /** Whether the project shows its environments (lib/environments.ts). */
  many: boolean;
  state: EnvState;
  apps: AppSummary[];
  busy: boolean;
  onApply: (redeploy: boolean) => void;
}) {
  const [plain, setPlain] = useState(false);
  const [redeploy, setRedeploy] = useState(true);
  const affected = useMemo(() => affectedApps(changes, state, apps), [changes, state, apps]);

  const groups = useMemo(() => {
    const out = new Map<string, { label: string; env: string; app?: AppSummary; rows: EnvChange[] }>();
    for (const c of [...changes].sort((a, b) => a.key.localeCompare(b.key))) {
      const id = scopeId(c);
      const app = c.appId ? apps.find((a) => a.id === c.appId) : undefined;
      const g = out.get(id) ?? { label: app ? `${appTitle(app)} override` : many ? `${envName(c.environment)}, shared` : "Shared variables", env: c.environment, app, rows: [] };
      g.rows.push(c);
      out.set(id, g);
    }
    return [...out.values()].sort((a, b) => Number(Boolean(a.app)) - Number(Boolean(b.app)) || a.label.localeCompare(b.label));
  }, [changes, apps, many]);

  // An app never deployed has nothing to redeploy: it reads these on its first deploy.
  const deployed = affected.filter((a) => a.app.status !== "unknown");
  const rebuilds = deployed.filter((a) => a.rebuild).length;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      icon="list"
      title={`Review ${plural(changes.length, "change")}`}
      sub={`${summarize(changes)}. Version ${state.version.toLocaleString("en-US")} becomes ${(state.version + 1).toLocaleString("en-US")}.`}
      busy={busy}
      onSubmit={() => onApply(redeploy)}
      footer={
        <>
          <span className="dlg-note">
            {!redeploy || !deployed.length ? "Apps pick it up on their next deploy" : rebuilds ? `${plural(rebuilds, "app")} rebuild` : "Apps restart on their current image"}
          </span>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <PendingButton type="submit" className="btn btn-primary" pending={busy} disabled={!changes.length} icon="deploy">
            {redeploy && deployed.length ? "Apply and redeploy" : "Apply changes"}
          </PendingButton>
        </>
      }
    >
      <div className="px-review-hd">
        <span className="px-review-legend">
          <span className="px-legend" data-sign="add">
            Added or new value
          </span>
          <span className="px-legend" data-sign="remove">
            Removed or old value
          </span>
        </span>
        <label className="px-inline-switch">
          <Switch checked={plain} onChange={setPlain} label="Show values" />
          <span aria-hidden="true">Show values</span>
        </label>
      </div>

      <div className="px-diff">
        {groups.map((g) => (
          <section key={g.label} className="px-diff-group" aria-label={g.label}>
            <GroupHead label={g.label} icon="layers" lead={g.app ? <AppIcon id={g.app.id} kind={g.app.kind} /> : undefined} count={g.rows.length} noun="change" actions={many ? <EnvTag env={g.env} compact /> : undefined} />
            <ul className="px-diff-lines">
              {g.rows.map((c) => (
                <ChangeLines key={`${c.key}`} c={c} state={state} apps={apps} plain={plain} />
              ))}
            </ul>
          </section>
        ))}
      </div>

      <section className="px-reach" aria-labelledby="px-reach-title">
        <div className="px-reach-hd">
          <h3 id="px-reach-title" className="px-reach-title">
            {affected.length ? `Reaches ${plural(affected.length, "app")}` : "Reaches no app"}
          </h3>
          {deployed.length ? (
            <label className="px-inline-switch">
              <Switch checked={redeploy} onChange={setRedeploy} label="Redeploy affected apps now" />
              <span aria-hidden="true">Redeploy now</span>
            </label>
          ) : null}
        </div>
        {affected.length ? (
          <ul className="soft-list px-reach-list">
            {affected.map((a) => (
              <li key={a.app.id} className="soft-row px-reach-row">
                <AppIcon id={a.app.id} kind={a.app.kind} size="md" />
                <span className="two">
                  <span className="two-main">{appTitle(a.app)}</span>
                  <span className="two-sub ellipsis" title={a.keys.join(", ")}>
                    {a.keys.join(", ")}
                  </span>
                </span>
                {many ? <EnvTag env={a.app.environment} quiet compact /> : null}
                <Chip size="xs" tone={a.app.status === "unknown" ? "idle" : a.rebuild ? "warn" : "idle"}>
                  {a.app.status === "unknown" ? "On first deploy" : a.rebuild ? "Rebuild" : "Restart"}
                </Chip>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-reach-none">These variables are not read by any app in this project yet. They apply to the next app that uses them.</p>
        )}
      </section>
    </Dialog>
  );
}
