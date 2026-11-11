"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { CfRecordDialog, CfStatePanel, HostPicker, useCloudflareZones } from "@/components/resources-domains/cloudflare";
import { DnsRecords, recordsFor } from "@/components/resources-domains/shared";
import { useStepUp } from "@/components/step-up/step-up";
import { Callout } from "@/components/ui/callout";
import { StatusChip } from "@/components/ui/chip";
import { CopyBox } from "@/components/ui/copy-box";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ExternalLink } from "@/components/ui/external-link";
import { PendingButton } from "@/components/ui/pending";
import { toast } from "@/components/ui/toast";
import { callJson, type Answer } from "@/lib/client-api";
import { cleanHost, domainChecks, HOST_RE, type DashboardDomain, type GitHubSteps } from "@/lib/dashboard-domain";
import { domainTargets } from "@/lib/domain-targets";
import { describe } from "@/lib/feedback";
import { isStepUpCancel } from "@/lib/step-up";

/*
 * Moving the dashboard to its own domain, in one place for Settings and for first-run setup. The three
 * screens follow the API's state, so a page reload, or a second admin, lands on the same step:
 *
 *   enter a domain     the name, typed or picked from a managed Cloudflare zone
 *   point it here      the record to add (or Dockify adds it), and the three checks. Switch stays off
 *                      until the domain answers and has its certificate. The old address is untouched.
 *   switching          the services restart on the new address; the link to it is there from the start
 */

const STATE_URL = "/api/settings/domain";

/** `enabled` false reads nothing: the state is admin only, and a Viewer's page has the address already. */
export function useDashboardDomain(enabled = true) {
  const [state, setState] = useState<DashboardDomain | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await callJson<DashboardDomain>(STATE_URL);
    if (r.ok) {
      setState(r.data);
      setError(null);
    } else {
      setError(r.error);
    }
    return r;
  }, []);
  useEffect(() => {
    if (enabled) void Promise.resolve().then(load);
  }, [enabled, load]);
  return { state, setState, error, reload: load };
}

const CHECK_TONE = { ok: "ok", wait: "pending", bad: "bad" } as const;
const CHECK_WORD = { ok: "Done", wait: "Waiting", bad: "Not yet" } as const;

function Checks({ state }: { state: DashboardDomain }) {
  const checks = useMemo(() => (state.pending ? domainChecks(state.pending) : []), [state.pending]);
  return (
    <ul className="dd-checks" aria-label="Checks">
      {checks.map((c) => (
        <li key={c.key} className="dd-check">
          <span className="two">
            <span className="two-main">{c.label}</span>
            {c.detail ? <span className="dd-check-why">{c.detail}</span> : null}
          </span>
          <StatusChip tone={CHECK_TONE[c.state]}>{CHECK_WORD[c.state]}</StatusChip>
        </li>
      ))}
    </ul>
  );
}

/** The App's URLs, for the owner to change on GitHub: the API can only set the webhook. */
export function GitHubUrls({ github, webhookFollows }: { github: GitHubSteps; webhookFollows: boolean }) {
  return (
    <div className="dd-github">
      <p className="dlg-text">
        GitHub does not let Dockify change a GitHub App&rsquo;s other addresses. Open <ExternalLink href={github.settingsUrl}>{github.slug} on GitHub</ExternalLink> and set:
      </p>
      <dl className="dd-urls">
        <dt>Homepage URL</dt>
        <dd><CopyBox value={github.homepageUrl} what="homepage URL" /></dd>
        <dt>Callback URL</dt>
        <dd><CopyBox value={github.callbackUrl} what="callback URL" /></dd>
        <dt>Setup URL</dt>
        <dd><CopyBox value={github.setupUrl} what="setup URL" /></dd>
        {webhookFollows ? null : (
          <>
            <dt>Webhook URL</dt>
            <dd><CopyBox value={github.webhookUrl} what="webhook URL" /></dd>
          </>
        )}
      </dl>
      <p className="fld-note">{webhookFollows ? "Dockify moves the webhook itself, through GitHub's API. " : ""}Until then the old address keeps serving the App, so pushes and installs go on working.</p>
    </div>
  );
}

export function DomainFlow({
  state,
  setState,
  preview,
  onClose,
  footerClass = "dd-foot",
}: {
  state: DashboardDomain;
  setState: (s: DashboardDomain) => void;
  preview: boolean;
  /** Back out of the flow (the dialog's Close). Nothing is lost: a pending domain stays pending. */
  onClose?: () => void;
  footerClass?: string;
}) {
  const { elevate } = useStepUp();
  const [input, setInput] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState<null | "start" | "check" | "record" | "switch" | "cancel">(null);
  const [fixing, setFixing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const zones = useCloudflareZones(state.cloudflareConnected && !state.pending);
  const pending = state.pending;
  const targets = useMemo(() => domainTargets(state), [state]);
  const tunnel = state.ingress === "cloudflare_tunnel";

  const host = cleanHost(input);
  const hostError = !host ? "Enter a domain" : !HOST_RE.test(host) ? "Use a domain such as dockify.example.com" : host === state.host ? "The dashboard already answers on this address" : null;

  const note = (text?: string) => describe(text, { preview });
  // Counts finished writes, so the poll can tell an answer that was asked for before one.
  const writes = useRef(0);
  /** The one write: its answer is the new state; a closed step-up leaves everything as it is. */
  const send = useCallback(
    async (key: NonNullable<typeof busy>, call: () => Promise<Answer<DashboardDomain>>, what: string, success?: string) => {
      setBusy(key);
      const r = await elevate(call, { what });
      setBusy(null);
      if (r.ok) {
        writes.current += 1;
        setState(r.data);
        if (success) toast.success(success, { description: note() });
      } else if (!isStepUpCancel(r)) {
        toast.error(`Could not finish: ${what.toLowerCase()}`, { description: r.error });
      }
      return r.ok;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [elevate, setState, preview],
  );

  const start = () => {
    setTouched(true);
    if (hostError) return;
    void send("start", () => callJson<DashboardDomain>(STATE_URL, { method: "POST", body: { hostname: host } }), "Setting up a new domain");
  };
  const check = () => send("check", () => callJson<DashboardDomain>(`${STATE_URL}/check`, { method: "POST", body: {} }), "Checking the domain");
  const cancel = () => send("cancel", () => callJson<DashboardDomain>(STATE_URL, { method: "DELETE" }), "Stopping the new domain", "The dashboard stays where it is");
  const record = async (body: { proxied: boolean; replace?: string[] }) => {
    const ok = await send("record", () => callJson<DashboardDomain>(`${STATE_URL}/record`, { method: "POST", body }), "Creating the record on Cloudflare", "Record created on Cloudflare");
    if (!ok) throw new Error("not created");
    void check();
  };
  const go = async () => {
    const ok = await send("switch", () => callJson<DashboardDomain>(`${STATE_URL}/switch`, { method: "POST", body: {} }), "Switching the dashboard's domain");
    if (!ok) throw new Error("not switched");
  };

  // While a domain waits or a switch runs, follow it. A dropped answer is the restart itself.
  const [startedOn] = useState(state.host);
  // The address changed under this page: it now only redirects, so the link is what is left to do.
  const moved = state.host !== startedOn ? state.host : null;
  const phase = pending?.phase ?? null;
  useEffect(() => {
    if (!phase || preview) return;
    const every = phase === "switching" ? 2_000 : 8_000;
    const t = setInterval(() => {
      const at = writes.current;
      void callJson<DashboardDomain>(STATE_URL).then((r) => {
        // A read that left before a write would put the old state back (a stopped domain pending again).
        if (r.ok && at === writes.current) setState(r.data);
      });
    }, every);
    return () => clearInterval(t);
  }, [phase, preview, setState]);

  if (moved) {
    return (
      <div className="dd-flow">
        <Callout tone="ok" icon="checkCircle">
          The dashboard now answers on <b className="num rd-strong">{moved}</b>. Sign in there. The old address redirects to it.
        </Callout>
        {state.github ? <GitHubUrls github={state.github} webhookFollows={state.lastChange?.webhook !== "failed"} /> : null}
        <div className={footerClass}>
          <a className="btn btn-primary" href={`https://${moved}/login`}>
            Open {moved}
            <Icon name="arrowRight" size={16} className="ic-trail" />
          </a>
        </div>
      </div>
    );
  }

  if (!pending) {
    return (
      <form
        className="dd-flow"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <HostPicker value={input} onChange={setInput} zones={zones} error={touched ? hostError : null} label="Domain" hint="A domain or subdomain you control, without https://" placeholder="dockify.example.com" namePlaceholder="dockify" />
        {tunnel && !state.cloudflareConnected ? (
          <Callout tone="warn" icon="alert">
            This server runs behind a Cloudflare tunnel, and only Cloudflare can route a new name through it. Connect Cloudflare in Settings, Integrations first.
          </Callout>
        ) : null}
        <p className="fld-note">Nothing changes yet. The dashboard stays on <span className="num dd-host">{state.host}</span> until the new domain answers and you switch.</p>
        <div className={footerClass}>
          {onClose ? (
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
          ) : null}
          <PendingButton type="submit" className="btn btn-primary" pending={busy === "start"} disabled={tunnel && !state.cloudflareConnected} trailing="arrowRight">
            Continue
          </PendingButton>
        </div>
      </form>
    );
  }

  if (phase === "switching") {
    return (
      <div className="dd-flow" role="status">
        <Callout tone="info" icon="refresh">
          The dashboard is moving to <b className="num rd-strong">{pending.host}</b>. Its services restart, which takes a minute. The domain answers and has its certificate; if a service does not come back, Dockify returns to {state.host} by itself.
        </Callout>
        <div className={footerClass}>
          <a className="btn" href={`https://${pending.host}/login`} target="_blank" rel="noreferrer">
            Open {pending.host}
            <Icon name="external" size={16} className="ic-trail" />
          </a>
        </div>
      </div>
    );
  }

  const records = recordsFor(pending.host, targets);
  const cf = state.cloudflare;
  const ready = phase === "ready";
  return (
    <div className="dd-flow">
      {pending.error ? (
        <Callout tone="bad" icon="alert" role="alert">
          {pending.error}
        </Callout>
      ) : null}
      {pending.dns.status !== "ok" ? (
        <>
          <p className="dlg-text">
            Add {records.length > 1 ? "these records" : "this record"} where <b className="num rd-strong">{pending.host}</b> is managed{tunnel ? ", proxied through Cloudflare" : ""}.
          </p>
          {records.length ? <DnsRecords records={records} label={`DNS records for ${pending.host}`} /> : null}
        </>
      ) : null}
      {cf ? <CfStatePanel state={cf} canWrite busy={busy === "record"} onCreate={() => setFixing(true)} onFix={() => setFixing(true)} /> : null}
      <Checks state={state} />
      {state.ingress === "direct_tls" && !ready ? <p className="fld-note">Behind Cloudflare, use SSL/TLS Full until the certificate is active. Dockify checks again on its own.</p> : null}
      <div className={footerClass}>
        <button type="button" className="btn dd-foot-start" onClick={() => void cancel()} disabled={busy !== null}>
          Stop
        </button>
        {onClose ? (
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        ) : null}
        <PendingButton className="btn" pending={busy === "check"} icon="refresh" onClick={() => void check()}>
          Check now
        </PendingButton>
        <PendingButton className="btn btn-primary" pending={busy === "switch"} disabled={!ready} trailing="arrowRight" onClick={() => setConfirming(true)}>
          Switch
        </PendingButton>
      </div>

      <CfRecordDialog open={fixing} state={cf} onClose={() => setFixing(false)} onConfirm={record} />
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Switch the dashboard"
        sub={`To ${pending.host}`}
        body={
          <div className="rd-fields">
            <p className="dlg-text">Everyone signs in again on the new address, because a sign-in belongs to the address it was made on. <span className="num dd-host">{state.host}</span> keeps working as a redirect, so old links and invites still arrive. The services restart for about a minute.</p>
            {state.github ? <GitHubUrls github={state.github} webhookFollows /> : null}
          </div>
        }
        confirmLabel={`Switch to ${pending.host}`}
        onConfirm={go}
      />
    </div>
  );
}
