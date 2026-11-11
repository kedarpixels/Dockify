"use client";

import { useCallback, useId, useState } from "react";
import { elevate } from "@/components/step-up/step-up";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { callJson } from "@/lib/client-api";
import { report } from "@/lib/feedback";
import type { Mutation, MutationResult } from "@/lib/pages/project-detail";
import type { OverviewSource } from "@/lib/types";

/** For a strip that switches in place: leaving `guarded` with unsaved edits asks first. Render `dialog` once. */
export function useTabSwitchGuard<T extends string>(tab: T, guarded: T, setTab: (next: T) => void) {
  const [dirty, setDirty] = useState(false);
  const [asked, setAsked] = useState<T | null>(null);
  const change = useCallback(
    (next: T) => {
      if (tab === guarded && dirty && next !== guarded) setAsked(next);
      else setTab(next);
    },
    [tab, guarded, dirty, setTab],
  );
  const dialog = (
    <ConfirmDialog
      open={asked !== null}
      onClose={() => setAsked(null)}
      onConfirm={() => {
        const to = asked;
        setAsked(null);
        setDirty(false);
        if (to) setTab(to);
      }}
      title="Leave without saving"
      sub="Your unsaved changes will be lost."
      confirmLabel="Leave without saving"
      cancelLabel="Stay"
      tone="danger"
    />
  );
  return { change, onDirty: setDirty, dialog };
}

const WHAT: Partial<Record<Mutation["type"], string>> = {
  "app.settings": "Changing app settings",
  "app.config": "Changing app settings",
  "app.create": "Adding an app",
  "app.delete": "Deleting an app",
  "env.put": "Changing variables",
  "env.delete": "Changing variables",
  "project.patch": "Changing project settings",
  "project.delete": "Deleting a project",
  "app.query": "Running a query",
  "app.terminalTicket": "Opening a terminal",
};

const whatOf = (m: Mutation) => (m.type === "app.action" ? (m.op === "stop" ? "Stopping an app" : m.op === "restart" ? "Restarting an app" : undefined) : WHAT[m.type]);

async function post(m: Mutation): Promise<MutationResult> {
  const r = await callJson<MutationResult>("/api/project-detail", { body: m });
  if (r.ok) return r.data ?? { ok: true, source: "api" };
  const source = typeof r.body?.source === "string" ? (r.body.source as OverviewSource) : "api";
  return { ok: false, source, error: r.error, code: r.code, status: r.status };
}

/** Never throws. An elevated write refused for a missing step-up asks "Confirm it is you" and is sent once more. */
export function mutate(m: Mutation): Promise<MutationResult> {
  return elevate(() => post(m), { what: whatOf(m) });
}

/** Unlike toast.promise this keeps the description (and an action) on the finished toast. */
export async function track(
  p: Promise<MutationResult>,
  m: { loading: string; success: string; error: string; what?: string; action?: (r: MutationResult) => { label: string; onClick: () => void } | undefined },
) {
  const id = toast.loading(m.loading, { description: m.what });
  const r = await p;
  return report(r, { id, success: m.success, error: m.error, what: m.what, action: r.ok ? m.action?.(r) : undefined });
}

export function ToggleRow({
  title,
  body,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  body: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="pd-trow">
      <span className="two">
        <label htmlFor={id} className="two-main">
          {title}
        </label>
        <span className="two-sub">{body}</span>
      </span>
      <Switch id={id} checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

export function CheckRow({
  checked,
  onChange,
  title,
  body,
  extra,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  title: string;
  body?: string;
  extra?: React.ReactNode;
}) {
  return (
    <label className="pd-check soft-row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="two">
        <span className="two-main pd-check-title">
          {title}
          {extra}
        </span>
        {body ? <span className="two-sub">{body}</span> : null}
      </span>
    </label>
  );
}
