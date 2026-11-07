"use client";

import { useState } from "react";
import { DomainFlow, GitHubUrls, useDashboardDomain } from "@/components/dashboard-domain/flow";
import { useStepUp } from "@/components/step-up/step-up";
import { Callout } from "@/components/ui/callout";
import { StatusChip } from "@/components/ui/chip";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { callJson } from "@/lib/client-api";
import { isSslipHost, type DashboardDomain } from "@/lib/dashboard-domain";
import { describe } from "@/lib/feedback";
import { isStepUpCancel } from "@/lib/step-up";
import { Group, SettingRow } from "./form";

/*
 * Settings, Instance, Dashboard domain: where this dashboard is reached, for an admin. The flow itself
 * lives in a dialog (components/dashboard-domain/flow.tsx) and the row brings it back while a new
 * domain waits. A viewer sees the address and nothing to press.
 */

const PHASE: Record<NonNullable<DashboardDomain["pending"]>["phase"], { label: string; tone: "pending" | "ok" | "bad" }> = {
  waiting: { label: "Waiting for DNS", tone: "pending" },
  ready: { label: "Ready to switch", tone: "ok" },
  switching: { label: "Switching", tone: "pending" },
  failed: { label: "Switch failed", tone: "bad" },
};

export function DashboardDomainGroup({ url, manage, preview }: { url: string; manage: boolean; preview: boolean }) {
  const { state, setState, error } = useDashboardDomain(manage);
  const { elevate } = useStepUp();
  const [open, setOpen] = useState(false);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const host = state?.host ?? (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  })();
  const pending = state?.pending ?? null;
  const lastChange = state?.lastChange;
  // After a move, the App's addresses on GitHub still name the old one until the owner changes them.
  const githubToDo = state?.github && lastChange?.to === host;

  const forget = async (old: string) => {
    const r = await elevate(() => callJson<DashboardDomain>(`/api/settings/domain/previous/${encodeURIComponent(old)}`, { method: "DELETE" }), { what: "Stopping an old address" });
    if (r.ok) {
      setState(r.data);
      toast.success("The old address stopped answering", { description: describe(old, { preview }) });
      return;
    }
    if (!isStepUpCancel(r)) toast.error("Could not stop the old address", { description: r.error });
    throw new Error(r.error);
  };

  return (
    <Group id="set-dashboard-domain" icon="globe" title="Dashboard domain" sub={manage ? "Where this dashboard is reached. Invite and email links follow it" : "Where this dashboard is reached. Only an admin can change it"}>
      <SettingRow
        label={<span className="num">{host}</span>}
        desc={isSslipHost(host) ? "Temporary address, use your own domain for real use." : "Invite and email links, webhooks and sign-ins all use this address."}
      >
        {manage ? (
          <button type="button" className="btn btn-sm" onClick={() => setOpen(true)} disabled={!state}>
            {pending ? "Continue" : "Change domain"}
          </button>
        ) : null}
      </SettingRow>
      {manage && error && !state ? (
        <SettingRow label="Domain setup" desc={error}>
          {null}
        </SettingRow>
      ) : null}
      {pending ? (
        <SettingRow label={<span className="num">{pending.host}</span>} desc={pending.error ?? "The new domain. The dashboard stays where it is until you switch."}>
          <StatusChip tone={PHASE[pending.phase].tone}>{PHASE[pending.phase].label}</StatusChip>
        </SettingRow>
      ) : null}
      {(state?.previousHosts ?? []).map((old) => (
        <SettingRow key={old} label={<span className="num">{old}</span>} desc="An old address. It redirects here, and still serves the API, so a GitHub App set up on it keeps working.">
          {manage ? (
            <button type="button" className="btn btn-sm" onClick={() => setForgetting(old)}>
              Stop answering
            </button>
          ) : null}
        </SettingRow>
      ))}
      {manage && githubToDo && state?.github ? (
        <div className="dd-after">
          {lastChange?.webhook === "failed" ? (
            <Callout tone="warn" icon="alert">
              GitHub did not accept the new webhook URL{lastChange.webhookError ? ` (${lastChange.webhookError})` : ""}. Set it by hand with the others.
            </Callout>
          ) : null}
          <GitHubUrls github={state.github} webhookFollows={lastChange?.webhook === "updated"} />
        </div>
      ) : null}

      {state ? (
        <Dialog open={open} onClose={() => setOpen(false)} icon="globe" title={pending ? `Move to ${pending.host}` : "Change the dashboard's domain"} sub={`Now on ${host}`} size="lg">
          <DomainFlow state={state} setState={setState} preview={preview} onClose={() => setOpen(false)} />
        </Dialog>
      ) : null}
      <ConfirmDialog
        open={forgetting !== null}
        onClose={() => setForgetting(null)}
        tone="danger"
        title="Stop answering"
        sub={forgetting ?? undefined}
        body={
          <p className="dlg-text">
            Old links to this address stop working, and a GitHub App still set up on it stops receiving pushes. Check its addresses on GitHub first.{" "}
            {forgetting && state?.previousRecords?.includes(forgetting) ? "Dockify also removes the Cloudflare record it made for this address." : "Its DNS record is yours to remove."}
          </p>
        }
        confirmLabel="Stop answering"
        onConfirm={() => (forgetting ? forget(forgetting) : undefined)}
      />
    </Group>
  );
}
