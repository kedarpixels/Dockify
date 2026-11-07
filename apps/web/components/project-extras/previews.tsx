"use client";

import { useMemo, useRef, useState } from "react";
import { CardTitle } from "@/components/card-title";
import { Icon, type IconName } from "@/components/icon";
import { AppIcon } from "@/components/icons/app-icon";
import { CheckRow, ToggleRow } from "@/components/project-detail/controls";
import { useLeaveGuard } from "@/components/ui/leave-guard";
import { hostOf } from "@/components/project-detail/shared";
import { DnsRecords } from "@/components/resources-domains/shared";
import { Callout } from "@/components/ui/callout";
import { Chip, StatusChip } from "@/components/ui/chip";
import { CopyButton } from "@/components/ui/copy-button";
import { GitLink } from "@/components/ui/git-ref";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Empty } from "@/components/ui/empty";
import { envName } from "@/components/ui/env-tag";
import { Field, TextInput } from "@/components/ui/field";
import { PendingButton } from "@/components/ui/pending";
import { Select, type SelectOption } from "@/components/ui/select";
import { SkelRows } from "@/components/ui/skeleton";
import { StatusMark } from "@/components/ui/status-mark";
import { When } from "@/components/ui/when";
import { resolvesItself } from "@/lib/dashboard-domain";
import { showsEnvironments } from "@/lib/environments";
import { describe, report } from "@/lib/feedback";
import { appTitle, bytes, plural } from "@/lib/format";
import { branchHref, commitHref, githubRepo, pullHref, type GitHubRepo } from "@/lib/git-links";
import type { PreviewDeployment, PreviewSettings, PreviewState, PreviewStatus, ProjectDetail } from "@/lib/pages/project-detail";
import { NO_ACCESS_TIP, useCan } from "@/lib/viewer";
import { send } from "./api";

/* Pull request previews. The settings card turns them on and holds every cost guardrail with its
   default and a one-line reason, plus the resource ceiling those settings allow. The Previews tab
   lists each preview (pr-<n>) with its PR, branch, author, status, URL, last commit, age and
   resource use, with Wake and Delete. Everything after "on" is automatic: the GitHub webhook builds,
   updates, sleeps and deletes previews by itself. A Viewer reads both; only an admin changes them. */

export const PREVIEW_SETTINGS_ID = "px-previews-settings";

const PREVIEW_KINDS = new Set(["frontend", "backend", "bot"]);
const DEFAULT_KINDS = new Set(["frontend", "backend"]);
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Only plain https links render as links: a URL from the API never becomes a script href. */
const safeHttps = (u: string | null | undefined) => (u && /^https:\/\/[^\s]+$/i.test(u) ? u : null);

const opts = <T extends number>(values: T[], label: (v: T) => string, def: T): SelectOption<string>[] =>
  values.map((v) => ({ value: String(v), label: label(v), hint: v === def ? "Default" : undefined }));

const PER_PROJECT = opts([1, 2, 3, 4, 5], (n) => plural(n, "preview"), 2);
const PER_SERVER = opts([1, 2, 3, 4, 6, 8, 12], (n) => plural(n, "preview"), 4);
const CPU = opts([0.25, 0.5, 1, 2], (n) => `${n} vCPU`, 0.5);
const MEMORY = opts([256, 512, 1024, 2048], (n) => (n >= 1024 ? `${n / 1024} GB` : `${n} MB`), 512);
const PIDS = opts([64, 128, 256, 512], (n) => `${n} processes`, 128);
const IDLE = opts([0, 15, 30, 60, 120], (n) => (n === 0 ? "Never" : n < 60 ? `${n} minutes` : plural(n / 60, "hour")), 30);
const TTL = opts([24, 48, 72, 168], (n) => (n === 168 ? "7 days" : `${n} hours`), 72);
const ACCESS: SelectOption<PreviewSettings["access"]>[] = [
  { value: "password", label: "Password", hint: "Default" },
  { value: "public", label: "Public" },
];

/** Keeps the stored value selectable even when it is not one of the presets. */
const withValue = (list: SelectOption<string>[], v: number, label: (n: number) => string) =>
  list.some((o) => o.value === String(v)) ? list : [...list, { value: String(v), label: label(v) }];

const same = (a: PreviewSettings, b: PreviewSettings) => JSON.stringify({ ...a, appIds: [...a.appIds].sort() }) === JSON.stringify({ ...b, appIds: [...b.appIds].sort() });

/** "At most 2 previews, about 1 vCPU and 1 GB", from the draft. */
function ceilingLine(s: PreviewSettings, apps: number): string {
  const per = Math.max(apps, 1);
  const cpu = Math.round(s.maxConcurrent * per * s.cpuLimit * 100) / 100;
  const mb = s.maxConcurrent * (per * s.memoryMb + (s.isolatedDb ? 256 : 0));
  const mem = mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${mb} MB`;
  return `At most ${plural(s.maxConcurrent, "preview")}, about ${cpu} vCPU and ${mem}`;
}

function GuardRow({ title, body, children }: { title: string; body: string; children: React.ReactNode }) {
  return (
    <div className="px-prev-cap">
      <span className="two">
        <span className="two-main">{title}</span>
        <span className="two-sub">{body}</span>
      </span>
      {children}
    </div>
  );
}

/** The one time a preview password is on screen. Closing it is final: the server holds only a hash. */
function PasswordDialog({ password, onClose }: { password: string; onClose: () => void }) {
  return (
    <Dialog
      open
      onClose={onClose}
      icon="lock"
      title="Copy the preview password"
      footer={
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <Callout tone="warn" icon="alert">
        This is the only time it is shown. Dockify keeps a hash, not the password. Lost it? Make a new one.
      </Callout>
      <div className="px-prev-secret">
        <code className="num">{password}</code>
        <CopyButton value={password} what="preview password" />
      </div>
    </Dialog>
  );
}

const DNS_TONE = { ok: "ok", mismatch: "bad", missing: "warn", unchecked: "idle" } as const;
const DNS_LABEL = { ok: "Points here", mismatch: "Points elsewhere", missing: "No record", unchecked: "Not checked" } as const;

function DnsPanel({ p, state, now, onChecked }: { p: ProjectDetail; state: PreviewState; now: number; onChecked: () => void }) {
  const [busy, setBusy] = useState(false);
  const d = state.dns;
  if (!d.domain) return <p className="fld-note">Set a preview domain here or in Settings, Instance to get preview URLs.</p>;
  const check = async () => {
    setBusy(true);
    const r = report(await send({ type: "previews.dnsCheck", slug: p.slug }), { success: "DNS check queued", error: "Could not check DNS", what: `*.${d.domain}` });
    setBusy(false);
    if (r.ok) setTimeout(onChecked, 4000);
  };
  const tls = d.tls === "cloudflare" ? "Cloudflare terminates TLS (tunnel mode)." : d.tls === "wildcard_dns01" ? "One Let’s Encrypt wildcard certificate through DNS-01." : "One Let’s Encrypt certificate per preview host through HTTP-01 (rate limits apply).";
  return (
    <div className="px-prev-dns">
      <div className="px-prev-dns-hd">
        <StatusChip tone={DNS_TONE[d.status]} tip={d.detail ?? undefined}>
          {DNS_LABEL[d.status]}
        </StatusChip>
        <span className="two-sub">{d.checkedAt ? <When iso={d.checkedAt} now={now} prefix="Checked" /> : "Previews start only once this passes"}</span>
        <PendingButton className="btn btn-sm" pending={busy} onClick={() => void check()}>
          Check DNS
        </PendingButton>
      </div>
      {d.cloudflare === "managed" ? (
        <p className="fld-note">Dockify made the wildcard record on Cloudflare and deletes only that record.</p>
      ) : resolvesItself(d.domain) ? (
        <p className="fld-note">sslip.io answers for this address by itself, so there is no record to create.</p>
      ) : d.record ? (
        <>
          <p className="fld-note">{d.cloudflareMessage && d.cloudflare !== "none" ? `${d.cloudflareMessage} ` : ""}Create this record at your DNS provider:</p>
          <DnsRecords records={[{ type: d.record.type, name: d.record.name, value: d.record.content }]} label="Preview DNS record to create" />
        </>
      ) : (
        <p className="fld-note">Point a wildcard record *.{d.domain} at this server.</p>
      )}
      <p className="fld-note">{tls}</p>
    </div>
  );
}

export function PreviewSettingsCard({
  p,
  state,
  error,
  loading,
  now,
  onSaved,
  onReload,
}: {
  p: ProjectDetail;
  state: PreviewState | null;
  error?: string;
  loading: boolean;
  now: number;
  onSaved: (s: PreviewSettings) => void;
  onReload?: () => void;
}) {
  const can = useCan();
  const ro = !can.manage;
  // A project with one environment has one possible base, whatever is stored (the default names
  // development, which a new project does not have), and nothing but its real data to share, so each
  // preview always gets its own database. The API refuses anything else.
  const many = showsEnvironments(p.environments);
  const only = p.environments[0]?.name;
  const stored = useMemo(() => (state && !many && only ? { ...state.settings, baseEnvironment: only, isolatedDb: true } : (state?.settings ?? null)), [state, many, only]);
  const [draft, setDraft] = useState<PreviewSettings | null>(stored);
  const [seen, setSeen] = useState(stored);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [askRotate, setAskRotate] = useState(false);
  // A fresh answer from the API replaces the form, the same as a reload would.
  if (stored !== seen) {
    setSeen(stored);
    setDraft(stored);
  }
  const dirty = Boolean(draft && stored && !same(draft, stored));
  // Leaving with unsaved settings asks first, as Settings does: the browser's prompt on close, ours on a link.
  const guard = useLeaveGuard(dirty);

  const body = () => {
    if (loading) return <SkelRows rows={4} height={56} template="minmax(0,1fr) 36px" cols={[{ w: "50%", lines: 2 }, 36]} />;
    if (!state || !stored || !draft) {
      return (
        <Empty
          icon="merge"
          title="Preview settings are unavailable"
          body={error ? `${describe([error, "Reload the page to try again"])}.` : "The Dockify API did not return this project’s preview settings."}
        />
      );
    }
    const set = (patch: Partial<PreviewSettings>) => setDraft((d) => d && { ...d, ...patch });
    // Vercel builds its own previews of an app it hosts, so it is named here and never offered.
    const inBase = p.apps.filter((a) => a.environment === draft.baseEnvironment && PREVIEW_KINDS.has(a.kind));
    const baseApps = inBase.filter((a) => !a.onVercel);
    const hostedApps = inBase.filter((a) => a.onVercel).map((a) => appTitle(a));
    const envOptions: SelectOption<string>[] = p.environments.map((e) => ({ value: e.name, label: envName(e.name), hint: e.name === "production" ? "Not recommended" : e.name === "development" ? "Default" : undefined }));
    // A stored base that no longer exists still shows, so the field never reads blank.
    const baseOptions = envOptions.some((o) => o.value === draft.baseEnvironment) ? envOptions : [...envOptions, { value: draft.baseEnvironment, label: envName(draft.baseEnvironment), hint: "Not found" }];
    const domainBad = draft.domain !== null && !HOST.test(draft.domain);
    const fallback = state.dns.source === "project" ? null : state.dns.domain;
    const off = !draft.enabled;
    const picked = draft.appIds.filter((id) => baseApps.some((a) => a.id === id));

    const save = async () => {
      if (!dirty || busy || domainBad || ro) return;
      setBusy(true);
      const r = report(await send({ type: "previews.settings", slug: p.slug, settings: { ...draft, appIds: picked } }), {
        success: "Preview settings saved",
        error: "Could not save preview settings",
        what: `${p.slug}, previews ${draft.enabled ? `on, up to ${plural(draft.maxConcurrent, "preview")}` : "off"}`,
      });
      setBusy(false);
      if (r.ok) {
        onSaved({ ...draft, appIds: picked });
        onReload?.();
        // The save that turned protection on with no password yet made the first one.
        const made = (r.data as { password?: unknown } | undefined)?.password;
        if (typeof made === "string") setShown(made);
      }
    };
    const rotate = async () => {
      setRotating(true);
      const r = report(await send({ type: "previews.password", slug: p.slug }), {
        success: "New preview password made",
        error: "Could not make a new password",
        what: `${p.slug}. Anyone signed in with the old one has to enter this one.`,
      });
      setRotating(false);
      if (!r.ok) throw new Error(r.error);
      const made = (r.data as { password?: unknown } | undefined)?.password;
      if (typeof made === "string") setShown(made);
      onReload?.();
    };
    const defaultApps = (env: string) => p.apps.filter((a) => a.environment === env && DEFAULT_KINDS.has(a.kind) && !a.onVercel).map((a) => a.id);
    // A new base environment starts from the default apps of that environment.
    const pickBase = (name: string) => set({ baseEnvironment: name, appIds: defaultApps(name) });

    return (
      <form
        className="pd-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {/* A Viewer reads the settings; the fields stay dimmed and this line says why. */}
        {ro ? <Callout icon="lock">Only an admin can change preview settings.</Callout> : null}
        <ToggleRow
          title="Pull request previews"
          body="Every pull request gets its own copy, pr-<number>, built on open and push and deleted on close or merge. Nothing to do after this."
          checked={draft.enabled}
          disabled={ro}
          onChange={(enabled) => set({ enabled, ...(enabled && !draft.appIds.length ? { appIds: defaultApps(draft.baseEnvironment) } : {}) })}
        />

        <fieldset className="fld pd-fieldset px-prev-opts" disabled={off || ro}>
          <legend className="fld-label">What a preview copies</legend>
          {many ? (
            <GuardRow title="Base environment" body="Each preview clones this environment’s apps. A development base also shares its secrets and services; production’s stay out unless allowed below.">
              <Select size="sm" label="Base environment" align="end" value={draft.baseEnvironment} options={baseOptions} disabled={off} onChange={pickBase} />
            </GuardRow>
          ) : null}
          {baseApps.length ? (
            <ul className="soft-list px-prev-apps" aria-label="Apps in each preview">
              {baseApps.map((a) => (
                <li key={a.id}>
                  <CheckRow
                    title={appTitle(a)}
                    body={`${a.kind === "frontend" ? "Frontend, included by default" : a.kind === "backend" ? "Backend, included by default" : "Bot, off by default"}${a.displayName ? `. Its preview address starts pr-<number>-${a.name}` : ""}`}
                    checked={draft.appIds.includes(a.id) || (off && !draft.appIds.length && DEFAULT_KINDS.has(a.kind))}
                    onChange={(on) => set({ appIds: on ? [...draft.appIds, a.id].sort() : draft.appIds.filter((x) => x !== a.id) })}
                    extra={<AppIcon id={a.id} kind={a.kind} />}
                  />
                </li>
              ))}
            </ul>
          ) : hostedApps.length ? null : (
            <p className="fld-note">No frontend, backend or bot app{many ? ` in ${envName(draft.baseEnvironment)}` : " in this project"} yet.</p>
          )}
          {hostedApps.length ? <p className="fld-note">{hostedApps.join(", ")} {hostedApps.length === 1 ? "is" : "are"} on Vercel, which builds {hostedApps.length === 1 ? "its" : "their"} previews, so Dockify builds no copy.</p> : null}
          <p className="fld-note">Databases are never cloned.</p>
          <ToggleRow
            title="Isolated database per preview"
            body={
              many
                ? "Off by default. On: each preview gets its own empty temporary Postgres (256 MB) and runs its release command against it."
                : "Always on with one environment: each preview gets its own empty temporary Postgres (256 MB), separate from your real data."
            }
            checked={draft.isolatedDb}
            disabled={off || !many}
            onChange={(isolatedDb) => set({ isolatedDb })}
          />
          <ToggleRow
            title="Build previews from forks (no secrets)"
            body="Off by default. On: fork PRs build with plain variables only and run on a network with no services."
            checked={draft.fromForks}
            disabled={off}
            onChange={(fromForks) => set({ fromForks })}
          />
          <ToggleRow
            title="Previews may use production secrets and services"
            body="Off by default. Off: a preview of production gets plain variables and its own network, so an app that needs more fails. A development base and forks are not affected."
            checked={draft.productionAccess}
            disabled={off}
            onChange={(productionAccess) => set({ productionAccess })}
          />
          {draft.productionAccess && !stored.productionAccess ? (
            <Callout tone="warn" icon="alert">
              Anyone who can push a branch can then read production secrets and reach production apps.
            </Callout>
          ) : null}
        </fieldset>

        <fieldset className="fld pd-fieldset px-prev-opts" disabled={off || ro}>
          <legend className="fld-label">Who can open a preview</legend>
          <GuardRow title="Preview access" body="Bots find a new public URL within minutes. Protected, every preview of this project asks for one password.">
            <Select size="sm" label="Preview access" align="end" value={draft.access} options={ACCESS} disabled={off} onChange={(access) => set({ access })} />
          </GuardRow>
          {draft.access === "password" ? (
            <GuardRow
              title="Preview password"
              body={
                state.passwordSetAt
                  ? `Made ${new Date(state.passwordSetAt).toLocaleDateString()}. It cannot be shown again. A new one signs everyone out of every preview.`
                  : "Made when you save, and shown once."
              }
            >
              {state.passwordSetAt ? (
                <button type="button" className="btn btn-sm" disabled={off || ro} onClick={() => setAskRotate(true)}>
                  Make a new one
                </button>
              ) : null}
            </GuardRow>
          ) : null}
          <p className="fld-note">
            {draft.access === "password"
              ? "Inbound webhooks to a preview, and a frontend preview calling a backend preview from the browser, cannot pass the password. Use Public if your previews need those."
              : "Anyone with the link can open a preview, and it runs your code with this environment's plain variables."}
          </p>
        </fieldset>

        <fieldset className="fld pd-fieldset px-prev-opts" disabled={off || ro}>
          <legend className="fld-label">Preview domain</legend>
          <Field
            label="Domain for this project"
            hint={draft.domain ? `URLs look like pr-12-${baseApps[0]?.name ?? "web"}.${draft.domain}` : fallback ? `Empty uses the instance domain, ${fallback}` : "Empty uses the instance domain from Settings, Instance"}
            error={domainBad ? "Use a hostname like preview.example.com" : null}
          >
            {(ids) => (
              <TextInput
                ids={ids}
                value={draft.domain ?? ""}
                placeholder={fallback ?? "preview.example.com"}
                spellCheck={false}
                autoCapitalize="off"
                onChange={(e) => set({ domain: e.target.value.trim().toLowerCase() || null })}
              />
            )}
          </Field>
          <DnsPanel p={p} state={state} now={now} onChecked={() => onReload?.()} />
        </fieldset>

        <fieldset className="fld pd-fieldset px-prev-opts" disabled={off || ro}>
          <legend className="fld-label">Cost guardrails</legend>
          <GuardRow title="Previews at once, this project" body="A new PR past the cap evicts the oldest idle preview, and its PR comment says so.">
            <Select size="sm" label="Previews at once, this project" align="end" value={String(draft.maxConcurrent)} options={withValue(PER_PROJECT, draft.maxConcurrent, (n) => plural(n, "preview"))} disabled={off} onChange={(v) => set({ maxConcurrent: Number(v) })} />
          </GuardRow>
          <GuardRow title="Previews at once, whole server" body="Shared by every project on this server.">
            <Select size="sm" label="Previews at once, whole server" align="end" value={String(draft.serverMaxConcurrent)} options={withValue(PER_SERVER, draft.serverMaxConcurrent, (n) => plural(n, "preview"))} disabled={off} onChange={(v) => set({ serverMaxConcurrent: Number(v) })} />
          </GuardRow>
          <GuardRow title="CPU per preview app" body="Separate from production limits.">
            <Select size="sm" label="CPU per preview app" align="end" value={String(draft.cpuLimit)} options={withValue(CPU, draft.cpuLimit, (n) => `${n} vCPU`)} disabled={off} onChange={(v) => set({ cpuLimit: Number(v) })} />
          </GuardRow>
          <GuardRow title="Memory per preview app" body="The container is stopped past this, never the server.">
            <Select size="sm" label="Memory per preview app" align="end" value={String(draft.memoryMb)} options={withValue(MEMORY, draft.memoryMb, (n) => `${n} MB`)} disabled={off} onChange={(v) => set({ memoryMb: Number(v) })} />
          </GuardRow>
          <GuardRow title="Processes per preview app" body="Stops a runaway process from taking down the server.">
            <Select size="sm" label="Processes per preview app" align="end" value={String(draft.pidsLimit)} options={withValue(PIDS, draft.pidsLimit, (n) => plural(n, "process", "processes"))} disabled={off} onChange={(v) => set({ pidsLimit: Number(v) })} />
          </GuardRow>
          <GuardRow title="Sleep when idle" body="Stops the containers after this long without a request. A push or Wake starts them again.">
            <Select size="sm" label="Sleep when idle" align="end" value={String(draft.idleMinutes)} options={withValue(IDLE, draft.idleMinutes, (n) => plural(n, "minute"))} disabled={off} onChange={(v) => set({ idleMinutes: Number(v) })} />
          </GuardRow>
          <GuardRow title="Delete after no commits for" body="Always deleted on close or merge too.">
            <Select size="sm" label="Delete after no commits for" align="end" value={String(draft.ttlHours)} options={withValue(TTL, draft.ttlHours, (n) => plural(n, "hour"))} disabled={off} onChange={(v) => set({ ttlHours: Number(v) })} />
          </GuardRow>
          <Callout icon="cpu">{ceilingLine(draft, picked.length)}</Callout>
          <p className="fld-note">
            Always on: no new previews above {state.server.diskGuardPct}% disk{state.server.diskPct !== null ? ` (now ${state.server.diskPct}%)` : ""}, each preview builds with its own cache, and a deleted preview’s images go at once.
          </p>
        </fieldset>

        {ro ? null : (
          <div className="pd-form-ft">
            <button type="button" className="btn" disabled={!dirty || busy} onClick={() => setDraft(stored)}>
              Discard
            </button>
            <PendingButton type="submit" className="btn" pending={busy} disabled={!dirty || domainBad}>
              Save changes
            </PendingButton>
          </div>
        )}
        <ConfirmDialog
          open={askRotate}
          onClose={() => setAskRotate(false)}
          tone="danger"
          title="Make a new preview password"
          body="The old password stops working at once, and everyone who entered it has to enter the new one. The new one is shown once."
          confirmLabel={rotating ? "Making it" : "Make a new one"}
          confirmIcon="refresh"
          onConfirm={() => rotate()}
        />
      </form>
    );
  };

  return (
    <section className="card" id={PREVIEW_SETTINGS_ID} aria-labelledby="px-prevset-title">
      <div className="card-hd">
        <CardTitle id="px-prevset-title" icon="merge" title="Preview deployments" sub="A short-lived copy of the project for every pull request" />
      </div>
      {body()}
      {guard}
      {shown ? <PasswordDialog password={shown} onClose={() => setShown(null)} /> : null}
    </section>
  );
}

const STATUS: Record<PreviewStatus, { label: string; tone: "ok" | "live" | "pending" | "warn" | "bad" | "idle"; icon: IconName | null }> = {
  building: { label: "Building", tone: "live", icon: null },
  ready: { label: "Ready", tone: "ok", icon: "check" },
  asleep: { label: "Asleep", tone: "idle", icon: "moon" },
  failed: { label: "Failed", tone: "bad", icon: "close" },
  blocked: { label: "Not started", tone: "warn", icon: "alert" },
  closing: { label: "Deleting", tone: "idle", icon: null },
  closed: { label: "Deleted", tone: "idle", icon: "slash" },
};

function usageLine(d: PreviewDeployment): string {
  if (d.status === "asleep" || d.usage.memoryBytes === null) return "None";
  return `${d.usage.cpuPct ?? 0}% CPU, ${bytes(d.usage.memoryBytes)}`;
}

function PreviewRow({
  d,
  repo,
  now,
  busy,
  manage,
  locked,
  onWake,
  onDelete,
}: {
  d: PreviewDeployment;
  /** The URL asks for the project's preview password. */
  locked: boolean;
  repo: GitHubRepo | null;
  now: number;
  busy: boolean;
  /** An admin: Wake shows and Delete works. A Viewer sees Delete dimmed, its tip saying why. */
  manage: boolean;
  onWake: () => void;
  onDelete: () => void;
}) {
  const url = safeHttps(d.url);
  const open = d.status !== "closed" && d.status !== "closing";
  const asleep = manage ? "Push or press Wake to start it" : "The next push starts it";
  const note = d.status === "failed" ? `Build failed: ${d.error ?? "see the deploy log"}` : d.status === "blocked" ? d.error ?? "Not started" : d.status === "asleep" ? asleep : null;
  return (
    <li className="px-prev" data-status={d.status} data-pr={d.pr}>
      <StatusMark tone={STATUS[d.status].tone} label={STATUS[d.status].label} icon={STATUS[d.status].icon} />
      <span className="two px-prev-id">
        <span className="two-main px-prev-title">
          <GitLink href={pullHref(repo, d.pr)} className="px-prev-pr num">
            #{d.pr}
          </GitLink>
          <span className="ellipsis" title={d.title}>
            {d.title}
          </span>
          {d.fromFork ? <Chip size="xs" tip="Built from a fork without secrets">Fork</Chip> : null}
          {d.isolation === "own" ? <Chip size="xs" tip="Runs without production’s secrets and services, so an app that needs them fails here">No secrets</Chip> : null}
        </span>
        <span className="two-sub px-prev-sub">
          <Icon name="branch" size={14} />
          <GitLink href={branchHref(repo, d.branch)} className="px-prev-branch">
            <span className="ellipsis" title={d.branch}>{d.branch}</span>
          </GitLink>
          {d.commit ? (
            <GitLink href={commitHref(repo, d.commit)} className="num">
              {d.commit.slice(0, 7)}
            </GitLink>
          ) : null}
          {d.author ? <span>{d.author}</span> : null}
        </span>
      </span>
      <span className="two px-prev-url">
        {url && (d.status === "ready" || d.status === "failed") ? (
          <span className="px-prev-link">
            <a href={url} target="_blank" rel="noreferrer" className="pd-url">
              <span className="ellipsis">{hostOf(url)}</span>
              <Icon name="arrowUpRight" size={14} />
            </a>
            <CopyButton value={url} what="preview URL" />
            {locked ? <Chip size="xs" tip="Asks for the project's preview password">Password</Chip> : null}
          </span>
        ) : (
          <span className={d.status === "failed" ? "tone-bad" : "none"}>{STATUS[d.status].label}</span>
        )}
        {note ? (
          <span className={d.status === "failed" ? "two-sub tone-bad" : "two-sub"}>{note}</span>
        ) : (
          <span className="two-sub">
            <When iso={d.lastCommitAt} now={now} prefix="Last commit" />
          </span>
        )}
      </span>
      <span className="px-prev-use num">{open ? usageLine(d) : ""}</span>
      <span className="px-prev-when num">
        <When iso={d.createdAt} now={now} tipAlign="end" />
      </span>
      <span className="px-prev-acts">
        {d.status === "asleep" && manage ? (
          <PendingButton className="btn btn-xs" pending={busy} onClick={onWake}>
            Wake
          </PendingButton>
        ) : null}
        {open ? (
          <button
            type="button"
            className="btn btn-xs btn-icon btn-quiet-danger"
            aria-label={`Delete preview #${d.pr}`}
            aria-disabled={!manage || undefined}
            data-tip={manage ? undefined : NO_ACCESS_TIP}
            data-tip-align="end"
            onClick={manage ? onDelete : undefined}
          >
            <Icon name="trash" />
          </button>
        ) : null}
      </span>
    </li>
  );
}

export function PreviewsTab({
  p,
  state,
  error,
  loading,
  now,
  onOpenSettings,
  onDeleted,
  onReload,
}: {
  p: ProjectDetail;
  state: PreviewState | null;
  error?: string;
  loading: boolean;
  now: number;
  onOpenSettings: () => void;
  onDeleted: (pr: number) => void;
  onReload?: () => void;
}) {
  const can = useCan();
  const [deleting, setDeleting] = useState<PreviewDeployment | null>(null);
  const [waking, setWaking] = useState<number | null>(null);
  /** The preview being deleted: its row stays (as Deleting) but loses its key, so the focus lands on its pull request link. */
  const deletedPr = useRef<number | null>(null);
  const running = state?.previews.filter((d) => ["building", "ready", "asleep", "failed"].includes(d.status)).length ?? 0;

  const remove = async (d: PreviewDeployment) => {
    const r = report(await send({ type: "previews.delete", slug: p.slug, pr: d.pr }), {
      success: "Preview deleted",
      error: "Could not delete the preview",
      what: `${p.slug}, ${d.name} ${d.title}`,
    });
    if (!r.ok) throw new Error(r.error);
    onDeleted(d.pr);
  };
  const wake = async (d: PreviewDeployment) => {
    setWaking(d.pr);
    const r = report(await send({ type: "previews.wake", slug: p.slug, pr: d.pr }), { success: "Waking the preview", error: "Could not wake the preview", what: `${p.slug}, ${d.name}` });
    setWaking(null);
    if (r.ok) setTimeout(() => onReload?.(), 3000);
  };

  // Turned off, the empty state says so and carries the one way to the settings, so the head stays quiet.
  const off = Boolean(state && !state.settings.enabled);
  const sub =
    state && !off
      ? `${running} of ${plural(state.settings.maxConcurrent, "slot")} in use, ${state.server.running} of ${state.server.cap} on this server`
      : "A copy of the project per pull request";

  return (
    <section className="card" aria-labelledby="px-prev-title">
      <div className="card-hd">
        <CardTitle id="px-prev-title" icon="merge" title="Previews" sub={sub} />
        {off ? null : (
          <button type="button" className="btn btn-sm" onClick={onOpenSettings}>
            Preview settings
          </button>
        )}
      </div>
      {loading ? (
        <div className="px-prevs-wrap">
          <SkelRows rows={3} height={56} template="24px minmax(0,1.4fr) minmax(0,1fr) 120px 80px 64px" cols={[24, { w: "60%", lines: 2 }, "70%", 80, 56, 24]} />
        </div>
      ) : !state ? (
        <Empty
          icon="merge"
          title="Previews are unavailable"
          body={error ? `${describe([error, "Reload the page to try again"])}.` : "The Dockify API did not return this project’s previews."}
        />
      ) : !state.settings.enabled ? (
        <Empty
          icon="merge"
          title="Previews are off"
          body={
            can.manage
              ? "Turn them on once and every pull request gets its own URL, built from its branch, asleep when idle and removed when it closes."
              : "An admin can turn them on in Preview settings. Every pull request then gets its own URL, built from its branch, asleep when idle and removed when it closes."
          }
          action={
            <button type="button" className="btn btn-sm" onClick={onOpenSettings}>
              Open preview settings
            </button>
          }
        />
      ) : state.previews.length === 0 ? (
        <Empty
          icon="merge"
          title="No previews yet"
          body={state.dns.status === "ok" ? `Open a pull request and pr-<number> shows up here within a minute.` : `Previews start once *.${state.dns.domain ?? "your preview domain"} resolves to this server. Check it in Preview settings.`}
        />
      ) : (
        <div className="px-prevs-wrap">
          <div className="px-prev px-prev-head" aria-hidden="true">
            <span />
            <span>Pull request</span>
            <span>URL</span>
            <span>Resources</span>
            <span className="px-prev-when">Age</span>
            <span />
          </div>
          <ul className="px-prevs" aria-label="Previews">
            {state.previews.map((d) => (
              <PreviewRow
                key={d.pr}
                d={d}
                repo={githubRepo(p.repo?.url)}
                now={now}
                busy={waking === d.pr}
                manage={can.manage}
                locked={state.settings.access === "password"}
                onWake={() => void wake(d)}
                onDelete={() => {
                  deletedPr.current = d.pr;
                  setDeleting(d);
                }}
              />
            ))}
          </ul>
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        tone="danger"
        title={`Delete preview #${deleting?.pr ?? ""}`}
        body={`Stops it and removes its containers, URL and images. A new push to ${deleting?.branch ?? "the branch"} builds it again.`}
        confirmLabel="Delete preview"
        confirmIcon="trash"
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
        returnFocus={() =>
          document.querySelector<HTMLElement>(`.px-prev[data-pr="${deletedPr.current ?? ""}"] a[href]`) ?? document.getElementById("px-prev-title")
        }
      />
    </section>
  );
}
