"use client";

import { useState } from "react";
import { Empty } from "@/components/ui/empty";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { GroupHead } from "@/components/ui/group-head";
import { PendingButton } from "@/components/ui/pending";
import { Callout } from "@/components/ui/callout";
import { Select } from "@/components/ui/select";
import { SkelRows } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { When } from "@/components/ui/when";
import { report } from "@/lib/feedback";
import type { VercelCheck, VercelIntegration, VercelProject, VercelWebhookState } from "@/lib/pages/integrations";
import { Facts, FormKeys, Hint, IntegrationCard, ItemRow, ProviderDialog, TokenField, useProviderCard, useTokenForm } from "./card";
import { ExternalLink } from "@/components/ui/external-link";
import { clause, plural } from "@/lib/format";
import { intFetch } from "./client";
import { useStepUp } from "@/components/step-up/step-up";
import { VercelImportDialog, type ImportTarget } from "./vercel-import";

/*
 * Vercel: a personal access token reads the projects still hosted there, so their variables and
 * domains can move here, and it follows the deployments of the projects apps are linked to. Connecting
 * is two steps: the API checks the token and lists its teams, then the operator picks the scope and
 * the token is stored.
 */

const PERSONAL = "personal";

function ConnectForm({ onDone, onCancel, preview, current }: { onDone: (v: VercelIntegration) => void; onCancel: () => void; preview: boolean; current?: VercelIntegration | null }) {
  const { elevate } = useStepUp();
  const form = useTokenForm();
  const { token, busy, setBusy } = form;
  const [check, setCheck] = useState<VercelCheck | null>(null);
  const [scope, setScope] = useState<string>(PERSONAL);

  const submit = async () => {
    if (!form.begin()) return;
    if (!check) {
      const r = await elevate(() => intFetch<VercelCheck>("/vercel", { method: "POST", body: { token: token.trim(), check: true } }), { what: "Connecting Vercel" });
      setBusy(false);
      if (!r.ok) return void toast.error("Could not check the token", { description: r.error });
      setCheck(r.data);
      // Connecting again keeps the scope it had, so the links, webhook and mirror carry on as they were.
      const keep = current ? (current.team ? r.data.teams.find((t) => t.id === current.team?.id)?.id : PERSONAL) : undefined;
      setScope(keep ?? r.data.teams[0]?.id ?? PERSONAL);
      return;
    }
    const r = await elevate(() => intFetch<VercelIntegration>("/vercel", { method: "POST", body: { token: token.trim(), teamId: scope === PERSONAL ? null : scope } }), { what: "Connecting Vercel" });
    setBusy(false);
    report(r, { success: "Vercel connected", error: "Could not connect Vercel", what: r.ok ? (r.data.team?.name ?? r.data.account.username) : undefined, preview });
    if (r.ok) onDone(r.data);
  };

  return (
    <Dialog
      open
      onClose={onCancel}
      title={current ? "Connect Vercel again" : "Connect Vercel"}
      sub={check ? `Signed in as ${check.account.username}` : current ? "A new token for the same account, nothing else changes" : "Deployments, logs and moving projects"}
      icon="vercel"
      size="sm"
      busy={busy}
      onSubmit={() => void submit()}
      footer={
        <>
          {check ? (
            <FormKeys cancel="Back" onCancel={() => setCheck(null)} busy={busy} icon="link">
              Connect
            </FormKeys>
          ) : (
            <FormKeys onCancel={onCancel} busy={busy} trailing="arrowRight">
              Continue
            </FormKeys>
          )}
        </>
      }
    >
      {!check ? (
        <TokenField
          label="Personal access token"
          form={form}
          hint={
            <>
              Create one at <ExternalLink href="https://vercel.com/account/tokens">vercel.com/account/tokens</ExternalLink> with access to the team that owns the projects.
            </>
          }
        />
      ) : (
        <Field label="Scope" hint="Dockify lists the projects in this scope. You can reconnect to switch.">
          {(ids) => (
            <Select
              ids={ids}
              label="Scope"
              value={scope}
              onChange={setScope}
              options={[
                ...check.teams.map((t) => ({ value: t.id, label: t.name, icon: "org" as const })),
                { value: PERSONAL, label: `${check.account.username}, personal account`, icon: "user" as const },
              ]}
            />
          )}
        </Field>
      )}
    </Dialog>
  );
}

/** How often the mirror reads Vercel with no webhook; worker/integrations/vercel-mirror.ts says the same. */
const POLL_WORDS = "every 2 minutes";

function webhookSub(w: VercelWebhookState | undefined): string {
  if (w?.state === "active") {
    const cover = `Vercel tells Dockify about each deployment in ${plural(w.projects, "linked project")}`;
    return w.missingProjects ? `${cover}. ${plural(w.missingProjects, "newly linked project")} is polled until you update it.` : `${cover}. Dockify still reads Vercel every 10 minutes as a backstop.`;
  }
  if (w?.state === "unavailable") return `Vercel refused it: ${clause(w.reason ?? "no reason given")}. Dockify polls Vercel ${POLL_WORDS} instead, so a deployment can take that long to show.`;
  return `Off. Dockify polls Vercel ${POLL_WORDS}, so a deployment can take that long to show. Register adds one webhook to your Vercel team, the only thing Dockify adds there for an app that follows. Webhooks need a Pro or Enterprise team.`;
}

/** The two ways deployments stay current: the mirror's last read, and the webhook that makes it instant. */
function DeploymentSync({ value, onChange, now, preview }: { value: VercelIntegration; onChange: (v: VercelIntegration) => void; now: number; preview: boolean }) {
  const { elevate } = useStepUp();
  const [busy, setBusy] = useState<"sync" | "webhook" | null>(null);
  const [removing, setRemoving] = useState(false);
  const mirror = value.mirror;
  const webhook = value.webhook;
  const linked = mirror?.projects ?? 0;

  const sync = async () => {
    setBusy("sync");
    const r = await intFetch<{ ok: true }>("/vercel/sync", { method: "POST", body: {} });
    setBusy(null);
    report(r, { success: "Reading Vercel now", error: "Could not start the sync", preview });
  };
  const register = async () => {
    setBusy("webhook");
    const r = await elevate(() => intFetch<VercelWebhookState>("/vercel/webhook", { method: "POST", body: {} }), { what: "Registering the Vercel webhook" });
    setBusy(null);
    if (!r.ok) return void toast.error("Could not register the webhook", { description: r.error });
    onChange({ ...value, webhook: r.data });
    if (r.data.state === "active") toast.success("Webhook registered", { description: plural(r.data.projects, "project") });
    else toast("Vercel refused the webhook", { description: "Dockify keeps polling instead." });
  };
  const remove = async () => {
    const r = await elevate(() => intFetch<{ ok: true }>("/vercel/webhook", { method: "DELETE" }), { what: "Removing the Vercel webhook" });
    report(r, { success: "Webhook removed", error: "Could not remove the webhook", preview });
    if (!r.ok) throw new Error(r.error);
    onChange({ ...value, webhook: { state: "off", projects: 0, missingProjects: 0, registeredAt: null, reason: null } });
  };

  return (
    <>
      <GroupHead label="Deployments" icon="deploy" />
      {/* A refused token is said once, at the top of the dialog, with its Connect again key. */}
      {mirror?.error && !value.error ? (
        <Callout tone="warn" icon="alert">
          {clause(mirror.error)}.
        </Callout>
      ) : null}
      <ul className="soft-list int-list">
        <ItemRow
          icon="deploy"
          title="Deployment mirror"
          sub={
            !linked ? (
              "No app is linked to a Vercel project yet. Link one in the app’s Settings, Deploy target."
            ) : (
              <>
                {plural(linked, "linked project")}, last read {mirror?.syncedAt ? <When iso={mirror.syncedAt} now={now} /> : "not yet"}
              </>
            )
          }
        >
          <PendingButton type="button" className="btn btn-xs" pending={busy === "sync"} disabled={!linked || busy !== null} onClick={() => void sync()}>
            Sync now
          </PendingButton>
        </ItemRow>
        <ItemRow icon="activity" title="Webhook" sub={webhookSub(webhook)}>
          {webhook?.state === "active" ? (
            <>
              {webhook.missingProjects ? (
                <PendingButton type="button" className="btn btn-xs" pending={busy === "webhook"} disabled={busy !== null} onClick={() => void register()}>
                  Update
                </PendingButton>
              ) : null}
              <button type="button" className="btn btn-xs" disabled={busy !== null} onClick={() => setRemoving(true)}>
                Remove
              </button>
            </>
          ) : (
            <PendingButton type="button" className="btn btn-xs" pending={busy === "webhook"} disabled={!linked || busy !== null} onClick={() => void register()}>
              {webhook?.state === "unavailable" ? "Try again" : "Register"}
            </PendingButton>
          )}
        </ItemRow>
      </ul>
      <ConfirmDialog
        open={removing}
        onClose={() => setRemoving(false)}
        title="Remove the Vercel webhook"
        body={`Dockify removes it from your Vercel account and forgets its signing secret. Deployments keep showing here, ${POLL_WORDS} instead of at once.`}
        confirmLabel="Remove webhook"
        onConfirm={remove}
      />
    </>
  );
}

export function VercelCard({ value, onChange, targets, now, preview }: { value: VercelIntegration | null; onChange: (v: VercelIntegration | null) => void; targets: ImportTarget[]; now: number; preview: boolean }) {
  const { elevate } = useStepUp();
  const { open, setOpen, leaving, setLeaving, list: projects, setList: setProjects, load, openManage } = useProviderCard<VercelProject>(value !== null, "/vercel/projects");
  const [importing, setImporting] = useState<VercelProject | null>(null);
  // A refused token is replaced in place: disconnecting would stop following deployments and drop the webhook.
  const [renewing, setRenewing] = useState(false);

  const disconnect = async () => {
    const r = await elevate(() => intFetch<{ ok: true }>("/vercel", { method: "DELETE" }), { what: "Disconnecting Vercel" });
    report(r, { success: "Vercel disconnected", error: "Could not disconnect Vercel", what: value?.team?.name ?? value?.account.username, preview });
    if (!r.ok) throw new Error(r.error);
    onChange(null);
    setProjects({ state: "idle" });
    setOpen(false);
  };

  const status = !value ? "disconnected" : value.error ? "error" : "connected";
  const scope = value ? (value.team?.name ?? `${value.account.username}, personal`) : "";

  return (
    <>
      <IntegrationCard
        id="int-vercel"
        icon="vercel"
        name="Vercel"
        purpose="See Vercel deployments and logs here, or move projects off Vercel."
        status={status}
        meta={value ? (value.error ?? scope) : null}
      >
        <button type="button" className="btn btn-sm" onClick={openManage}>
          {value ? "Manage" : "Connect"}
        </button>
      </IntegrationCard>

      {(open && !value) || renewing ? (
        <ConnectForm
          preview={preview}
          current={renewing ? value : null}
          onCancel={() => (renewing ? setRenewing(false) : setOpen(false))}
          onDone={(v) => {
            onChange(v);
            setRenewing(false);
            void load();
          }}
        />
      ) : null}

      <ProviderDialog open={open && value !== null && !renewing} onClose={() => setOpen(false)} onDisconnect={() => setLeaving(true)} title="Vercel" sub={scope} icon="vercel">
        {value ? (
          <>
            {value.error ? (
              <Callout
                tone="warn"
                icon="alert"
                action={
                  <button type="button" className="btn btn-sm" onClick={() => setRenewing(true)}>
                    Connect again
                  </button>
                }
              >
                {value.error}
              </Callout>
            ) : null}
            <Facts
              items={[
                { label: "Account", value: value.account.name ? `${value.account.name} (${value.account.username})` : value.account.username },
                { label: "Scope", value: value.team ? value.team.name : "Personal account" },
                { label: "Token", value: <Hint hint={value.tokenHint} what="Vercel token" /> },
                { label: "Connected", value: <When iso={value.connectedAt} now={now} /> },
              ]}
            />
            <DeploymentSync value={value} onChange={onChange} now={now} preview={preview} />
            <GroupHead label="Projects" icon="layers" count={projects.state === "ready" ? projects.list.length : undefined} noun="project" />
            {projects.state === "error" ? (
              <Empty
                icon="vercel"
                title="Vercel projects are unavailable"
                body={/[.!?]$/.test(projects.error.trim()) ? projects.error.trim() : `${clause(projects.error)}. Try again in a moment.`}
                action={
                  <button type="button" className="btn btn-sm" onClick={() => void load()}>
                    Try again
                  </button>
                }
              />
            ) : projects.state !== "ready" ? (
              <SkelRows rows={3} height={56} template="24px minmax(0,1fr) 176px" cols={[24, { w: "45%", lines: 2 }, 168]} label="Loading Vercel projects" />
            ) : !projects.list.length ? (
              <Empty icon="vercel" title="No projects in this scope" body="Nothing left on Vercel here. Reconnect with another scope to see other teams." />
            ) : (
              <ul className="soft-list int-list">
                {projects.list.map((p) => (
                  <ItemRow
                    key={p.id}
                    icon="window"
                    title={
                      <span className="ellipsis" title={p.name}>
                        {p.name}
                      </span>
                    }
                    sub={[p.framework ?? "Other", plural(p.env.length, "variable"), plural(p.domains.length, "domain")].join(", ")}
                  >
                    <button type="button" className="btn btn-xs" aria-label={`Import variables and domains from ${p.name}`} onClick={() => setImporting(p)}>
                      Import variables and domains
                    </button>
                  </ItemRow>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </ProviderDialog>

      <VercelImportDialog project={importing} targets={targets} onClose={() => setImporting(null)} preview={preview} />

      {/* Connecting again undoes it, so the default key, with no glyph: nothing is deleted. */}
      <ConfirmDialog
        open={leaving}
        onClose={() => setLeaving(false)}
        title="Disconnect Vercel"
        body="Dockify removes its webhook from your Vercel account and forgets the token. Anything already imported, and deployments already listed, stay. Revoke the token on Vercel too if you no longer use it."
        confirmLabel="Disconnect Vercel"
        onConfirm={disconnect}
      />
    </>
  );
}
