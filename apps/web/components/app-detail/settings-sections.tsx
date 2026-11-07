"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/dialog";
import { StatusChip } from "@/components/ui/chip";
import { Field, TextInput } from "@/components/ui/field";
import { PendingButton } from "@/components/ui/pending";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { When } from "@/components/ui/when";
import { report } from "@/lib/feedback";
import { appTitle } from "@/lib/format";
import type { AppConfig, AppConfigPatch, AppDetail, HealthCheck, VercelSyncState } from "@/lib/pages/project-detail";
import { useCan } from "@/lib/viewer";
import { mutate } from "@/components/project-detail/controls";
import { Optional } from "@/components/project-detail/shared";
import { TabCard } from "./states";

/* The config cards of the Settings tab. Each holds its own draft and sends only its own slice of
   AppConfigPatch; the answer (or, in the preview, the patch applied locally) becomes the new config.
   Each card tells the tab whether it holds unsaved edits (`onDirty`), so leaving the page asks first. */

const INTEGRATIONS_HREF = "/settings?section=integrations";

/** What every settings card takes on top of its own data: where it reports unsaved edits. */
export type DirtyReport = (dirty: boolean) => void;

/** Tells the tab whether this card holds unsaved edits, and that it holds none once it goes. */
export function useReportDirty(dirty: boolean, onDirty?: DirtyReport) {
  useEffect(() => {
    onDirty?.(dirty);
    return () => onDirty?.(false);
  }, [dirty, onDirty]);
}

/**
 * Discard and Save at the end of a card's form. Save keeps the focus while it saves. A Viewer gets
 * neither key: the cards are read-only for them, under the tab's one note (the card's own save
 * refuses too, so Enter does nothing).
 */
export function SaveRow({ dirty, busy, ready = true, onDiscard }: { dirty: boolean; busy: boolean; ready?: boolean; onDiscard: () => void }) {
  const can = useCan();
  if (!can.manage) return null;
  return (
    <div className="pd-form-ft">
      <button type="button" className="btn" disabled={!dirty || busy} onClick={onDiscard}>
        Discard
      </button>
      <PendingButton type="submit" className="btn" pending={busy} disabled={!dirty || !ready}>
        Save changes
      </PendingButton>
    </div>
  );
}

/** The one note a Viewer reads above the read-only settings cards. */
export function ReadOnlyNote() {
  const can = useCan();
  return can.manage ? null : <Callout tone="info">Only an admin can change these settings.</Callout>;
}

/** Sends one slice. Resolves to the new config, or null after an error toast. */
async function savePatch(app: AppDetail, config: AppConfig, patch: AppConfigPatch, m: { success: string; error: string; what: string }) {
  const r = report(await mutate({ type: "app.config", id: app.id, patch }), { ...m, what: `${app.projectSlug} / ${appTitle(app)}, ${m.what}` });
  if (!r.ok) return null;
  const answered = r.data && typeof r.data === "object" && "health" in r.data ? (r.data as AppConfig) : null;
  return answered ?? { ...config, ...patch, target: patch.target ?? config.target };
}

/** Whole number field text to a number, or null when empty. */
const whole = (v: string) => (v.trim() === "" ? null : Number(v.trim()));
const isWhole = (v: string, lo: number, hi: number) => /^\d+$/.test(v.trim()) && +v >= lo && +v <= hi;

/* -------------- Health check -------------- */

type HealthDraft = Record<"path" | "expectedStatus" | "timeoutSeconds" | "gracePeriodSeconds" | "intervalSeconds", string>;

const toHealth = (h: HealthCheck): HealthDraft => ({
  path: h.path,
  expectedStatus: String(h.expectedStatus),
  timeoutSeconds: String(h.timeoutSeconds),
  gracePeriodSeconds: String(h.gracePeriodSeconds),
  intervalSeconds: String(h.intervalSeconds),
});

function healthErrors(d: HealthDraft) {
  const e: Partial<Record<keyof HealthDraft, string>> = {};
  if (d.path.trim() && !/^\/\S{0,255}$/.test(d.path.trim())) e.path = "Start the path with /, no spaces";
  if (!isWhole(d.expectedStatus, 100, 599)) e.expectedStatus = "An HTTP status, 100 to 599";
  if (!isWhole(d.timeoutSeconds, 1, 120)) e.timeoutSeconds = "Seconds, 1 to 120";
  if (!isWhole(d.gracePeriodSeconds, 0, 600)) e.gracePeriodSeconds = "Seconds, 0 to 600";
  if (!isWhole(d.intervalSeconds, 2, 300)) e.intervalSeconds = "Seconds, 2 to 300";
  return e;
}

/** Why this app can or cannot deploy without downtime, said before the deploy, never after. */
function DowntimeNotice({ app, config, path, http }: { app: AppDetail; config: AppConfig; path: string; http: boolean }) {
  const z = config.zeroDowntime;
  if (!z.possible) {
    const why = z.blockers.map((b) =>
      b === "volume"
        ? `${appTitle(app)} keeps its data on a volume, and two containers cannot share it, so a deploy stops the old one before the new one starts.${app.kind === "postgres" ? " Dockify backs it up first." : ""}`
        : "It publishes a fixed host port with a single replica, so the new container cannot start beside the old one. Drop the host port to deploy without downtime.",
    );
    return (
      <Callout tone="warn" icon="alert">
        <b className="pd-strong">Zero downtime is not possible for this app.</b> {why.join(" ")}
      </Callout>
    );
  }
  if (http && !path.trim()) {
    return (
      <Callout tone="warn" icon="info">
        <b className="pd-strong">No health check path.</b> A container that starts counts as ready, so a build that boots but cannot serve still takes traffic. Add a path to gate the switch.
      </Callout>
    );
  }
  return (
    <Callout tone="ok" icon="checkCircle">
      <b className="pd-strong">Zero downtime.</b> The new container must answer this check before traffic moves; the old one keeps serving until then and drains afterwards.
    </Callout>
  );
}

/** Postgres and Redis speak their own protocol, so their check is the container running, never an HTTP path. */
const speaksHttp = (app: AppDetail) => app.kind !== "postgres" && app.kind !== "redis";

export function HealthSection({ app, config, onSaved, onDirty }: { app: AppDetail; config: AppConfig; onSaved: (c: AppConfig) => void; onDirty?: DirtyReport }) {
  const can = useCan();
  const [draft, setDraft] = useState(() => toHealth(config.health));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const http = speaksHttp(app);
  const errs = healthErrors(draft);
  const err = (k: keyof HealthDraft) => (tried ? (errs[k] ?? null) : null);
  const base = toHealth(config.health);
  const dirty = (Object.keys(draft) as Array<keyof HealthDraft>).some((k) => draft[k].trim() !== base[k]);
  useReportDirty(dirty, onDirty);
  const set = (k: keyof HealthDraft) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const num = (k: keyof HealthDraft, label: string, hint: string) => (
    <Field label={label} hint={hint} error={err(k)}>
      {(ids) => <TextInput ids={ids} className="num" inputMode="numeric" value={draft[k]} readOnly={!can.manage} onChange={set(k)} />}
    </Field>
  );

  const save = async () => {
    setTried(true);
    if (!can.manage || Object.keys(errs).length || busy) return;
    const health: HealthCheck = {
      path: draft.path.trim(),
      expectedStatus: Number(draft.expectedStatus),
      timeoutSeconds: Number(draft.timeoutSeconds),
      gracePeriodSeconds: Number(draft.gracePeriodSeconds),
      intervalSeconds: Number(draft.intervalSeconds),
    };
    setBusy(true);
    const next = await savePatch(app, config, { health }, { success: "Health check saved", error: "Could not save the health check", what: "used from the next deploy" });
    setBusy(false);
    if (!next) return;
    setTried(false);
    setDraft(toHealth(next.health));
    onSaved(next);
  };

  return (
    <TabCard id="at-health-title" icon="activity" title="Health check" sub="What a new container must answer before it takes traffic">
      <form
        className="pd-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <DowntimeNotice app={app} config={config} path={draft.path} http={http} />
        {http ? (
          <div className="pd-pair">
            <Field label={<Optional>Path</Optional>} hint="Empty waits for the container to run." error={err("path")}>
              {(ids) => <TextInput ids={ids} className="pd-mono" value={draft.path} placeholder="/health" spellCheck={false} readOnly={!can.manage} onChange={set("path")} />}
            </Field>
            {num("expectedStatus", "Expected status", "Any other answer fails the check.")}
          </div>
        ) : null}
        {/* No interval field: a deploy probes every 2 seconds whatever it is set to, so it would do nothing. */}
        <div className="pd-pair">
          {num("timeoutSeconds", "Timeout, seconds", "Per request.")}
          {num("gracePeriodSeconds", "Grace period, seconds", "Boot time before the first check.")}
        </div>
        <p className="fld-note">A check that keeps failing holds the build slot for the grace period plus up to 2 minutes, then the deploy fails.</p>
        <SaveRow
          dirty={dirty}
          busy={busy}
          onDiscard={() => {
            setDraft(base);
            setTried(false);
          }}
        />
      </form>
    </TabCard>
  );
}

/* -------------- Resource limits -------------- */

type LimitsDraft = Record<"cpuCores" | "memoryMb" | "pids", string>;
const text = (n: number | null) => (n === null ? "" : String(n));

export function LimitsSection({ app, config, onSaved, onDirty }: { app: AppDetail; config: AppConfig; onSaved: (c: AppConfig) => void; onDirty?: DirtyReport }) {
  const can = useCan();
  const init = (c: AppConfig): LimitsDraft => ({ cpuCores: text(c.limits.cpuCores), memoryMb: text(c.limits.memoryMb), pids: text(c.limits.pids) });
  const [draft, setDraft] = useState(() => init(config));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const d = config.defaults;
  const errs: Partial<Record<keyof LimitsDraft, string>> = {};
  if (draft.cpuCores.trim() && !(/^\d+(\.\d+)?$/.test(draft.cpuCores.trim()) && +draft.cpuCores >= 0.1 && +draft.cpuCores <= 64)) errs.cpuCores = "From 0.1 to 64 vCPU";
  // The API takes whole MiB; the dashboard names that unit MB everywhere, as bytes() does.
  if (draft.memoryMb.trim() && !isWhole(draft.memoryMb, 64, 262_144)) errs.memoryMb = "At least 64 MB";
  if (draft.pids.trim() && !isWhole(draft.pids, 16, 65_536)) errs.pids = "From 16 to 65,536";
  const err = (k: keyof LimitsDraft) => (tried ? (errs[k] ?? null) : null);
  const base = init(config);
  const dirty = (Object.keys(draft) as Array<keyof LimitsDraft>).some((k) => draft[k].trim() !== base[k]);
  useReportDirty(dirty, onDirty);
  const set = (k: keyof LimitsDraft) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft((x) => ({ ...x, [k]: e.target.value }));

  const save = async () => {
    setTried(true);
    if (!can.manage || Object.keys(errs).length || busy) return;
    const limits = { cpuCores: draft.cpuCores.trim() ? Number(draft.cpuCores) : null, memoryMb: whole(draft.memoryMb), pids: whole(draft.pids) };
    setBusy(true);
    const next = await savePatch(app, config, { limits }, { success: "Limits saved", error: "Could not save the limits", what: "applies on the next restart" });
    setBusy(false);
    if (!next) return;
    setTried(false);
    setDraft(init(next));
    onSaved(next);
  };

  return (
    <TabCard id="at-lim-set-title" icon="cpu" title="Resource limits" sub="Caps for this app, an empty field uses the default">
      <form
        className="pd-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="at-trio">
          <Field label="CPU, vCPU" hint={`Default ${d.cpuCores.toLocaleString("en-US")}`} error={err("cpuCores")}>
            {(ids) => <TextInput ids={ids} className="num" inputMode="decimal" value={draft.cpuCores} placeholder={String(d.cpuCores)} readOnly={!can.manage} onChange={set("cpuCores")} />}
          </Field>
          <Field label="Memory, MB" hint={`Default ${d.memoryMb.toLocaleString("en-US")}`} error={err("memoryMb")}>
            {(ids) => <TextInput ids={ids} className="num" inputMode="numeric" value={draft.memoryMb} placeholder={String(d.memoryMb)} readOnly={!can.manage} onChange={set("memoryMb")} />}
          </Field>
          <Field label="Processes" hint={`Default ${d.pids.toLocaleString("en-US")}`} error={err("pids")}>
            {(ids) => <TextInput ids={ids} className="num" inputMode="numeric" value={draft.pids} placeholder={String(d.pids)} readOnly={!can.manage} onChange={set("pids")} />}
          </Field>
        </div>
        <SaveRow
          dirty={dirty}
          busy={busy}
          onDiscard={() => {
            setDraft(base);
            setTried(false);
          }}
        />
      </form>
    </TabCard>
  );
}

/* -------------- Release command -------------- */

export function ReleaseSection({ app, config, onSaved, onDirty }: { app: AppDetail; config: AppConfig; onSaved: (c: AppConfig) => void; onDirty?: DirtyReport }) {
  const can = useCan();
  const [cmd, setCmd] = useState(config.release.command);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const error = cmd.length > 500 ? "At most 500 characters" : null;
  const dirty = cmd.trim() !== config.release.command;
  useReportDirty(dirty, onDirty);

  const save = async () => {
    setTried(true);
    if (!can.manage || error || busy) return;
    setBusy(true);
    const next = await savePatch(app, config, { release: { command: cmd.trim() } }, {
      success: cmd.trim() ? "Release command saved" : "Release command removed",
      error: "Could not save the release command",
      what: "runs on the next deploy",
    });
    setBusy(false);
    if (!next) return;
    setTried(false);
    setCmd(next.release.command);
    onSaved(next);
  };

  return (
    <TabCard id="at-rel-title" icon="terminal" title="Release command" sub="Migrations and other one-off work before the switch">
      <form
        className="pd-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field
          label={<Optional>Command</Optional>}
          hint="Runs once per new image in a one-off container, after the build and before traffic moves. If it fails the deploy stops, the old container keeps serving, and it is not retried."
          error={tried ? error : null}
        >
          {(ids) => <TextInput ids={ids} className="pd-mono" value={cmd} placeholder={can.manage ? "pnpm db:migrate" : "Hidden"} spellCheck={false} readOnly={!can.manage} onChange={(e) => setCmd(e.target.value)} />}
        </Field>
        <SaveRow
          dirty={dirty}
          busy={busy}
          onDiscard={() => {
            setCmd(config.release.command);
            setTried(false);
          }}
        />
      </form>
    </TabCard>
  );
}

/* -------------- Deploy target -------------- */

/** Where it runs, as the card offers it: following a Vercel project is the default for a link. */
type Target = "server" | "follow" | "deploy";

const targetOf = (t: AppConfig["target"]): Target => (t?.kind !== "vercel" ? "server" : t.mode === "deploy" ? "deploy" : "follow");
const TARGET_LABEL: Record<Target, string> = { server: "This server", follow: "Follow on Vercel", deploy: "Deploy to Vercel" };

const SYNC: Record<VercelSyncState, { label: string; tone: "ok" | "live" | "bad" }> = {
  synced: { label: "In sync", tone: "ok" },
  pending: { label: "Syncing", tone: "live" },
  failed: { label: "Sync failed", tone: "bad" },
};

const DEPLOY_STATE = { ready: { label: "Ready", tone: "ok" }, building: { label: "Building", tone: "live" }, error: { label: "Error", tone: "bad" } } as const;

export function TargetSection({ app, config, now, onSaved, onDirty }: { app: AppDetail; config: AppConfig; now: number; onSaved: (c: AppConfig) => void; onDirty?: DirtyReport }) {
  const can = useCan();
  const t = config.target!;
  const v = config.vercel!;
  const saved = targetOf(t);
  const [kind, setKind] = useState<Target>(saved);
  const [project, setProject] = useState<string | null>(t.vercelProjectId);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const vercel = kind !== "server";
  const locked = vercel && !v.connected;
  const dirty = kind !== saved || (vercel && project !== t.vercelProjectId);
  useReportDirty(dirty, onDirty);
  const ready = !locked && (!vercel || Boolean(project));
  const name = v.projects.find((p) => p.id === project)?.name ?? "the Vercel project";
  // Anything that begins sending this app's variables to a project asks first. The API refuses it otherwise.
  const startsPushing = kind === "deploy" && (saved !== "deploy" || project !== t.vercelProjectId);

  const send = async (confirmed: boolean) => {
    setBusy(true);
    const target = vercel ? { kind: "vercel" as const, vercelProjectId: project, mode: kind === "deploy" ? ("deploy" as const) : ("follow" as const) } : { kind: "server" as const, vercelProjectId: null };
    const next = await savePatch(app, config, confirmed ? { target, confirmSendSecrets: true } : { target }, {
      success: kind === "deploy" ? "Deploys go to Vercel" : kind === "follow" ? "Following on Vercel" : "Deploys stay on this server",
      error: "Could not change the deploy target",
      what: kind === "deploy" ? `linked to ${name}, variables and secrets sent on save` : kind === "follow" ? `reading ${name}, nothing is sent to Vercel` : "built and served here from the next deploy",
    });
    setBusy(false);
    if (next) onSaved(next);
    return !!next;
  };

  const save = () => {
    if (!can.manage || !ready || busy) return;
    if (startsPushing) setAsking(true);
    else void send(false);
  };

  const sync = saved === "deploy" && kind === "deploy" ? v.sync : null;
  return (
    <TabCard id="at-target-title" icon="deploy" title="Deploy target" sub="Where this frontend is built and served">
      <form
        className="pd-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="Serve from">
          {(ids) =>
            // A Viewer reads the choice in a read-only field, like every other field in these cards.
            can.manage ? (
              <Segmented
                ids={ids}
                label="Serve from"
                value={kind}
                onChange={setKind}
                options={[
                  { value: "server", label: TARGET_LABEL.server },
                  { value: "follow", label: TARGET_LABEL.follow },
                  { value: "deploy", label: TARGET_LABEL.deploy },
                ]}
              />
            ) : (
              <TextInput ids={ids} value={TARGET_LABEL[kind]} readOnly />
            )
          }
        </Field>
        {!vercel ? (
          <p className="fld-note">Built from your repository and served by this server, with its own domains and certificates.</p>
        ) : locked ? (
          <Callout
            icon="vercel"
            action={
              <Link href={INTEGRATIONS_HREF} className="btn btn-sm">
                Open integrations
              </Link>
            }
          >
            <b className="pd-strong">Vercel is not connected.</b> Add a Vercel token in Settings, Integrations, then pick the project here.
          </Callout>
        ) : (
          <>
            {kind === "deploy" ? (
              <Callout tone="warn" icon="alert">
                <b className="pd-strong">This sends secrets to Vercel.</b> Dockify pushes this environment’s variables and secrets to the project and asks Vercel to deploy. To only see deployments and logs here, choose {TARGET_LABEL.follow}.
              </Callout>
            ) : null}
            <Field
              label="Vercel project"
              hint={kind === "deploy" ? "Its domains stay on Vercel." : "Dockify reads this project’s deployments and logs, and changes nothing on Vercel. Deploy there as you do now."}
            >
              {(ids) => (
                <Select
                  ids={ids}
                  label="Vercel project"
                  icon="vercel"
                  value={project}
                  onChange={setProject}
                  placeholder={v.projects.length ? "Pick a project" : v.projectsError ? "Projects could not be listed" : "No projects on this token"}
                  disabled={!v.projects.length || !can.manage}
                  options={v.projects.map((p) => ({ value: p.id, label: p.name, hint: p.framework ?? undefined }))}
                />
              )}
            </Field>
            {v.projectsError ? (
              <Callout tone="warn" icon="alert">
                {v.projectsError}
              </Callout>
            ) : null}
            {sync ? (
              <dl className="at-sync">
                <div className="kv">
                  <dt className="kv-label">Sync</dt>
                  <dd className="kv-value at-sync-state">
                    <StatusChip tone={SYNC[sync.state].tone}>{SYNC[sync.state].label}</StatusChip>
                    {sync.at ? <When iso={sync.at} now={now} className="num" /> : null}
                  </dd>
                </div>
                <div className="kv">
                  <dt className="kv-label">Variables</dt>
                  <dd className="kv-value num">{sync.envVars.toLocaleString("en-US")} synced</dd>
                </div>
                <div className="kv">
                  <dt className="kv-label">Last Vercel deploy</dt>
                  <dd className="kv-value at-sync-state">
                    {sync.lastDeploy ? (
                      <>
                        <StatusChip tone={DEPLOY_STATE[sync.lastDeploy.state].tone}>{DEPLOY_STATE[sync.lastDeploy.state].label}</StatusChip>
                        <a href={sync.lastDeploy.url} target="_blank" rel="noreferrer" className="num">
                          <When iso={sync.lastDeploy.at} now={now} />
                        </a>
                      </>
                    ) : (
                      <span className="none">None yet</span>
                    )}
                  </dd>
                </div>
              </dl>
            ) : null}
            {sync?.error ? (
              <Callout tone="bad" icon="alert" role="alert">
                {sync.error}
              </Callout>
            ) : null}
          </>
        )}
        <SaveRow
          dirty={dirty}
          busy={busy}
          ready={ready}
          onDiscard={() => {
            setKind(saved);
            setProject(t.vercelProjectId);
          }}
        />
        <ConfirmDialog
          open={asking}
          onClose={() => setAsking(false)}
          onConfirm={async () => {
            if (!(await send(true))) throw new Error("Not saved");
          }}
          title="Send variables and secrets to Vercel"
          body={`Dockify copies this environment’s variables, secrets included, to ${name} on your Vercel account, overwriting any with the same name, and can start deploys there. Going back to follow only stops this but does not remove what was sent.`}
          confirmLabel="Send and deploy to Vercel"
          cancelLabel="Cancel"
        />
      </form>
    </TabCard>
  );
}
