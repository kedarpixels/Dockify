"use client";

import { useId, useLayoutEffect, useRef } from "react";
import { CardTitle } from "@/components/card-title";
import { cx } from "@/components/ui/cx";
import type { FieldIds } from "@/components/ui/field";
import { PendingButton } from "@/components/ui/pending";
import { OFFLINE } from "@/lib/client-api";
import { useAbsTip } from "@/lib/time-prefs";
import type { Outcome } from "@/lib/pages/activity-settings";

/** Shown only while the section has unsaved edits. A save's result is a toast; the bar only says what blocks one. */
export function SaveBar({
  dirty,
  saving,
  error,
  onDiscard,
  onSave,
  label = "Save changes",
}: {
  dirty: boolean;
  saving: boolean;
  error?: string | null;
  onDiscard: () => void;
  onSave: () => void;
  label?: string;
}) {
  // When the bar goes with the focus on one of its keys, the focus moves to the section's heading,
  // not the top of the page. A blur toward nothing (the key leaving) keeps the flag.
  const held = useRef(false);
  useLayoutEffect(() => {
    if (dirty || !held.current) return;
    held.current = false;
    if (document.activeElement && document.activeElement !== document.body) return;
    const h = document.querySelector<HTMLElement>(".set-pane:not([hidden]) .set-seg:not([hidden]) h2, .set-pane:not([hidden]) > .set-group h2") ?? document.querySelector<HTMLElement>("main h1");
    if (!h) return;
    h.tabIndex = -1;
    h.focus({ preventScroll: true });
  }, [dirty]);
  if (!dirty) return null;
  return (
    <div
      className="set-savebar"
      role="region"
      aria-label="Unsaved changes"
      onFocus={() => {
        held.current = true;
      }}
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) held.current = false;
      }}
    >
      <span className={cx("set-savebar-text", error && "tone-bad")} role={error ? "alert" : undefined}>
        {error ?? "You have unsaved changes"}
      </span>
      <button type="button" className="btn btn-sm" onClick={onDiscard} disabled={saving}>
        Discard
      </button>
      <PendingButton className="btn btn-sm btn-primary" onClick={onSave} pending={saving} icon="check">
        {label}
      </PendingButton>
    </div>
  );
}

/** A dropped connection or server crash rejects, so it becomes a failed Outcome and callers handle one shape. */
export async function settle<T>(call: Promise<Outcome<T>>): Promise<Outcome<T>> {
  try {
    return await call;
  } catch {
    return { ok: false, error: OFFLINE };
  }
}

export function Group({
  id,
  icon,
  title,
  sub,
  actions,
  children,
  solo,
}: {
  id: string;
  icon: React.ComponentProps<typeof CardTitle>["icon"];
  title: string;
  sub?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  /** Drops the body: a block that is only its head and keys. */
  solo?: boolean;
}) {
  return (
    <section className={solo ? "set-group set-group-solo" : "set-group"} aria-labelledby={id}>
      <div className="card-hd">
        <CardTitle id={id} icon={icon} title={title} sub={sub} />
        {actions ? <div className="set-group-actions">{actions}</div> : null}
      </div>
      {solo ? children : <div className="set-body">{children}</div>}
    </section>
  );
}

/** With a render prop the label points at the control; with plain keys the row is a labelled group. */
export function SettingRow({
  label,
  desc,
  error,
  lead,
  className,
  onClick,
  children,
}: {
  label: React.ReactNode;
  desc?: React.ReactNode;
  error?: string | null;
  lead?: React.ReactNode;
  className?: string;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  children: ((ids: FieldIds) => React.ReactNode) | React.ReactNode;
}) {
  const id = useId();
  const note = `${id}-note`;
  const ids: FieldIds = { id, describedBy: desc || error ? note : undefined, invalid: Boolean(error) };
  const wired = typeof children === "function";
  return (
    <div className={cx("set-row", lead ? "set-row-lead" : null, className)} onClick={onClick}>
      {lead ? <span className="set-row-pic">{lead}</span> : null}
      <span className="two">
        {wired ? (
          <label htmlFor={id} className="two-main set-row-label">
            {label}
          </label>
        ) : (
          <span id={`${id}-label`} className="two-main">
            {label}
          </span>
        )}
        {error ? (
          <span id={note} className="two-sub tone-bad" role="alert">
            {error}
          </span>
        ) : desc ? (
          <span id={note} className="two-sub">
            {desc}
          </span>
        ) : null}
      </span>
      <span className="set-ctl" role={wired ? undefined : "group"} aria-labelledby={wired ? undefined : `${id}-label`} aria-describedby={wired ? undefined : ids.describedBy}>
        {wired ? children(ids) : children}
      </span>
    </div>
  );
}

/** Both spellings of UTC. A zone picker lists it once. */
export const isUtc = (zone: string) => zone === "UTC" || zone === "Etc/UTC";

export const zoneLabel = (zone: string) => (isUtc(zone) ? "UTC" : zone.replaceAll("_", " "));

function until(iso: string, now: number) {
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return "expired";
  const h = Math.round(ms / 3_600_000);
  if (h < 24) return `in ${Math.max(1, h)} ${h === 1 ? "hour" : "hours"}`;
  const d = Math.round(h / 24);
  return `in ${d} ${d === 1 ? "day" : "days"}`;
}

/** The counterpart of `When` for a time ahead. The tip reads UTC until hydrated. */
export function Until({
  iso,
  now,
  prefix,
  expired = "Expired",
  tipAlign,
  className,
}: {
  iso: string;
  now: number;
  /** Words before "in 5 days"; without it the text starts "In". */
  prefix?: string;
  expired?: string;
  tipAlign?: "end";
  className?: string;
}) {
  const tip = useAbsTip();
  const left = until(iso, now);
  const text = left === "expired" ? expired : prefix ? `${prefix} ${left}` : left.charAt(0).toUpperCase() + left.slice(1);
  return (
    <time dateTime={iso} className={cx("when", className)} data-tip={tip(iso)} data-tip-align={tipAlign} suppressHydrationWarning>
      {text}
    </time>
  );
}
