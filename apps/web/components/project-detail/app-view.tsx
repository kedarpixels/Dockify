"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { BackupsTab } from "@/components/app-detail/backups-tab";
import { DataTab } from "@/components/app-detail/data-tab";
import { DomainsTab } from "@/components/app-detail/domains-tab";
import { JobsTab } from "@/components/app-detail/jobs-tab";
import { MetricsTab } from "@/components/app-detail/metrics-tab";
import { SettingsTab } from "@/components/app-detail/settings-tab";
import { TerminalTab } from "@/components/app-detail/terminal-tab";
import { useAppTab } from "@/components/app-detail/use-tab";
import { CardTitle } from "@/components/card-title";
import { hostOfUrl } from "@/components/deployments/vercel-links";
import { VercelRuntimeLogs } from "@/components/deployments/vercel-runtime-logs";
import { ExternalLink } from "@/components/ui/external-link";
import { triggerLabel } from "@/components/deployments/actions";
import { Icon, type IconName } from "@/components/icon";
import { AppIcon, ProjectIcon } from "@/components/icons/app-icon";
import { DeployRow } from "@/components/overview/deploy-row";
import { useProjectExtras } from "@/components/project-extras/api";
import { EnvWorkbench, type EnvProject } from "@/components/project-extras/env-workbench";
import { SparkArea } from "@/components/spark-area";
import { Topbar } from "@/components/shell/topbar";
import { CopyButton } from "@/components/ui/copy-button";
import { Crumbs } from "@/components/ui/crumbs";
import { Empty } from "@/components/ui/empty";
import { RepoRef } from "@/components/ui/git-ref";
import { NoSource } from "@/components/ui/no-source";
import { NotFound } from "@/components/ui/not-found";
import { PendingButton } from "@/components/ui/pending";
import { PreviewProvider } from "@/components/ui/preview";
import { Node, Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { Skel } from "@/components/ui/skeleton";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { APP_STATUS_LABEL, APP_TONE, deriveNotices, notRunning } from "@/lib/derive";
import { bytes, usagePct } from "@/lib/format";
import { withRepo } from "@/lib/git-links";
import { projectsShowingEnvironments } from "@/lib/environments";
import { useHydrated, useNow, useOverview } from "@/lib/hooks";
import { useTimeFormat } from "@/lib/time-prefs";
import type { AppDetail, AppMetrics, AppPage, AppSettings, PageResult } from "@/lib/pages/project-detail";
import type { MetricRange } from "@/lib/pages/server-backups";
import type { AppKind, AppStatus, OverviewResult, Resource } from "@/lib/types";
import { useCan } from "@/lib/viewer";
import { mutate, track, useTabSwitchGuard } from "./controls";
import { LogPanel } from "./logs";
import { cores, DeployCard, DetailLead, hostOf, isManaged, KIND_LABEL, useUrlTab } from "./shared";

const APP_TABS = ["overview", "deployments", "logs", "metrics", "env", "domains", "jobs", "data", "backups", "terminal", "settings"] as const;
type AppTab = (typeof APP_TABS)[number];

const TAB_LABEL: Record<AppTab, string> = {
  overview: "Overview",
  deployments: "Deployments",
  logs: "Logs",
  metrics: "Metrics",
  env: "Variables",
  domains: "Domains",
  jobs: "Jobs",
  data: "Data",
  backups: "Backups",
  terminal: "Terminal",
  settings: "Settings",
};

/* Tabs that only some kinds have: databases are never published, so they get no Domains, and
   only Postgres and Redis have a data browser. Backups are Postgres dumps. */
const TAB_KINDS: Partial<Record<AppTab, readonly AppKind[]>> = {
  domains: ["frontend", "backend", "s3"],
  data: ["postgres", "redis"],
  backups: ["postgres"],
  // A managed database runs its own image, and it is the app's image a job runs from.
  jobs: ["frontend", "backend", "bot"],
};

const hasTab = (kind: AppKind, t: AppTab) => TAB_KINDS[t]?.includes(kind) ?? true;

const onVercel = (app: Pick<AppDetail, "target">) => app.target?.kind === "vercel";

/* Nothing of a Vercel app runs on this server, so it has no container metrics, and a domain on it
   would route nowhere: its domains stay on Vercel. One imported earlier is still on the Domains page. */
const HOSTED_HIDES: ReadonlySet<AppTab> = new Set(["jobs", "metrics", "domains", "terminal"]);

/** The app's latest deployment on Vercel and where it lives there, in place of the container facts. */
function VercelFacts({ app }: { app: AppDetail }) {
  const latest = app.deployments.find((d) => d.external);
  const rows: Array<[string, React.ReactNode]> = [
    ["Hosted by", "Vercel. Nothing of this app runs on this server."],
    ["Link", app.target?.mode === "deploy" ? "Deploy target: Dockify sends variables and asks Vercel to deploy" : "Follow only: Dockify changes nothing on Vercel"],
    ["Vercel project", app.target?.vercelProjectId ?? "Not picked yet: choose it in Settings, Deploy target"],
    ["Address", latest?.external?.url ? <ExternalLink key="url" href={latest.external.url}>{hostOfUrl(latest.external.url)}</ExternalLink> : "None yet"],
    ["On Vercel", latest?.external?.inspectorUrl ? <ExternalLink key="ins" href={latest.external.inspectorUrl}>Open the latest deployment</ExternalLink> : "None yet"],
  ];
  return (
    <section className="card" aria-labelledby="pd-rt-title">
      <div className="card-hd">
        <CardTitle id="pd-rt-title" icon="vercel" title="Vercel" sub="Where this app is built and served" />
      </div>
      <dl className="pd-kv">
        {rows.map(([k, v]) => (
          <div key={k} className="pd-kv-row">
            <dt className="kv-label">{k}</dt>
            <dd className="kv-value">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

type Op = "deploy" | "restart" | "stop" | "start";

/* Toast copy per action: the loading line while the request runs, then the result. */
const OP_COPY: Record<Op, { loading: string; success: string; error: string }> = {
  deploy: { loading: "Starting deployment", success: "Deployment started", error: "Could not start the deployment" },
  restart: { loading: "Restarting", success: "Restart requested", error: "Could not restart" },
  stop: { loading: "Stopping", success: "App stopped", error: "Could not stop the app" },
  start: { loading: "Starting", success: "App started", error: "Could not start the app" },
};

/** The deployment id a deploy answered with, when the API sends one. */
const deploymentIdOf = (data: unknown) =>
  data && typeof data === "object" && "deploymentId" in data && typeof data.deploymentId === "string" ? data.deploymentId : null;

/* What each action leaves the app in until the next poll says otherwise. */
const OP_STATUS: Record<Op, AppStatus> = {
  deploy: "deploying",
  restart: "running",
  stop: "stopped",
  start: "running",
};

/* -------------- Overview -------------- */

/** The limits in force with the defaults resolved, as the Metrics tab reads them. */
type Limits = AppMetrics["limits"];

const MIB = 1024 ** 2;

/*
 * The app read carries only the overrides (null uses the server default, never "no limit"), so the
 * numbers come from the metrics read and say when they are the default. Null while that read is
 * out and no override says it either.
 */
function cpuText(s: AppSettings, limits: Limits | null): string | null {
  if (limits) return `${cores(limits.cpuCores)}${s.cpuLimit === null ? " (default)" : ""}`;
  return s.cpuLimit !== null ? cores(s.cpuLimit) : null;
}

function memoryText(s: AppSettings, limits: Limits | null): string | null {
  if (limits) return `${bytes(limits.memoryBytes)}${s.memoryLimitMb === null ? " (default)" : ""}`;
  return s.memoryLimitMb !== null ? bytes(s.memoryLimitMb * MIB) : null;
}

function Usage({ app, limits }: { app: AppDetail; limits: Limits | null }) {
  // Chart labels read local once hydrated; UTC in the server render unless a zone was picked.
  const time = useTimeFormat();
  const utc = !useHydrated() && !time.prefs.timeZone;
  const m = app.metrics;
  if (!m || m.length < 2 || !app.usage) {
    return (
      <section className="card pd-usage" aria-labelledby="pd-use-title">
        <div className="card-hd">
          <CardTitle id="pd-use-title" icon="cpu" title="Usage" sub="Last 24 hours, share of the app’s limit" />
        </div>
        <Empty
          icon="server"
          title={notRunning(app.status) ? "Not running" : "No metrics yet"}
          body={notRunning(app.status) ? "Start the app to see its CPU and memory here." : "CPU and memory appear here once the metrics sampler has run for this app."}
        />
      </section>
    );
  }
  const limit = app.usage.memoryLimitBytes;
  const cpu = m.map((p, i) => ({ label: i === m.length - 1 ? "Now" : time.clock(p.at, { utc }), value: p.cpuPct }));
  const mem = m.map((p, i) => ({ label: i === m.length - 1 ? "Now" : time.clock(p.at, { utc }), value: limit ? (p.memoryBytes / limit) * 100 : 0 }));
  const cpuNow = cpu.at(-1)!.value;
  const memNow = mem.at(-1)!.value;
  const cpuLimit = cpuText(app.settings, limits);
  const meters = [
    { name: "CPU", detail: cpuLimit ? `of ${cpuLimit}` : "of the default limit", pct: cpuNow, points: cpu },
    { name: "Memory", detail: `${bytes(m.at(-1)!.memoryBytes)} of ${bytes(limit)}`, pct: memNow, points: mem },
  ];
  return (
    <section className="card pd-usage" aria-labelledby="pd-use-title">
      <div className="card-hd">
        <CardTitle id="pd-use-title" icon="cpu" title="Usage" sub="Last 24 hours, share of the app’s limit" />
      </div>
      <div className="meters">
        {meters.map((x, i) => {
          const tone = x.pct > 85 ? "bad" : x.pct > 70 ? "warn" : undefined;
          return (
            <div key={x.name} className="meter pd-meter" data-tone={tone}>
              {/* Side by side the second meter's rule runs down its left edge; stacked on a phone it
                  runs across its top. CSS shows the two nodes that match. */}
              {i ? (
                <>
                  <Node pos="tl" />
                  <Node pos="tr" />
                  <Node pos="bl" />
                </>
              ) : null}
              <div className="meter-head">
                <span className="meter-name">{x.name}</span>
                <span className="meter-detail num">{x.detail}</span>
                <span className="meter-val num">{usagePct(x.pct)}</span>
              </div>
              <SparkArea
                fluid
                points={x.points}
                unit={x.name}
                format="pct"
                domain={[0, Math.min(100, Math.max(10, ...x.points.map((p) => p.value)) * 1.5)]}
                tone={tone ? `var(--${tone})` : "var(--chart)"}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Runtime({ app, limits, loading }: { app: AppDetail; limits: Limits | null; loading: boolean }) {
  const s = app.settings;
  const managed = isManaged(app);
  const cpu = cpuText(s, limits);
  const memory = memoryText(s, limits);
  const rows: Array<[string, React.ReactNode]> = [
    [
      "App ID",
      // One line, cut with an ellipsis: the copy key carries the full value.
      <span key="id" className="pd-copytext pd-id">
        <span className="pd-mono ellipsis" title={app.id}>
          {app.id}
        </span>
        <CopyButton value={app.id} what="app ID" align="end" />
      </span>,
    ],
    ["Replicas", `${app.replicas.running} of ${app.replicas.desired} running`],
    [
      "Ports",
      app.ports.length
        ? app.ports.map((p) => `${p.container}/${p.protocol}${p.host ? ` on ${p.host}` : ", internal"}`).join(", ")
        : "None exposed",
    ],
    [
      "Source",
      managed ? (
        (app.image ?? `Managed ${KIND_LABEL[app.kind]}`)
      ) : app.repo && !app.image ? (
        <span key="src">
          <RepoRef source={app.repo} />, {s.builder === "railpack" ? "Railpack" : s.dockerfilePath || "Dockerfile, else Railpack"}
        </span>
      ) : (
        (app.image ?? "Image")
      ),
    ],
    ["Limits", loading ? <Skel key="lim" w={140} /> : `${cpu ?? "Default CPU"}, ${memory ?? "default memory"}`],
    // A path reads as one ("Path /"), never a bare "/" that looks like a stray character.
    ["Health check", s.healthCheckPath ? `Path ${s.healthCheckPath}` : "Container running"],
  ];
  return (
    <section className="card" aria-labelledby="pd-rt-title">
      <div className="card-hd">
        <CardTitle id="pd-rt-title" icon="server" title="Runtime" sub="Replicas, ports and limits" />
      </div>
      <dl className="pd-kv">
        {rows.map(([k, v]) => (
          <div key={k} className="pd-kv-row">
            <dt className="kv-label">{k}</dt>
            <dd className="kv-value num">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Latest({ app, now }: { app: AppDetail; now: number }) {
  const d = withRepo(app.deployments.slice(0, 1), app.repo)[0];
  return (
    <section className="card dep-card" aria-labelledby="pd-last-title">
      <div className="card-hd">
        {/* Nothing deployed says so once, in the empty state, not again in the head. */}
        <CardTitle id="pd-last-title" icon="deploy" title="Latest deployment" sub={d ? [triggerLabel(d.trigger), d.branch].filter(Boolean).join(", ") : undefined} />
      </div>
      {d ? (
        <div className="dep-list">
          <DeployRow d={d} now={now} scope="app" />
        </div>
      ) : (
        <Empty icon="deploy" title="No deployments yet" body={isManaged(app) || app.image ? "Press Deploy to start it for the first time." : "Press Deploy to build this app for the first time."} />
      )}
    </section>
  );
}

/** Usage across the page, then the latest deployment and the runtime facts side by side. */
function OverviewTab({ app, now }: { app: AppDetail; now: number }) {
  if (onVercel(app)) {
    return (
      <div className="pd-ov-pair">
        <Latest app={app} now={now} />
        <VercelFacts app={app} />
      </div>
    );
  }
  return <ServerOverview app={app} now={now} />;
}

function ServerOverview({ app, now }: { app: AppDetail; now: number }) {
  // The same read the Metrics tab makes, over its shortest range, for the limits in force.
  const q = useAppTab<AppMetrics>(app.id, "metrics", { range: "1h" });
  const limits = q.data?.limits ?? null;
  return (
    <div className="pd-stack">
      <Usage app={app} limits={limits} />
      <div className="pd-ov-pair">
        <Latest app={app} now={now} />
        <Runtime app={app} limits={limits} loading={q.loading && !q.data} />
      </div>
    </div>
  );
}

/* -------------- Variables -------------- */

/**
 * The project workbench, narrowed to this app. It reads the project extras itself; the overview
 * lists the project's other apps (for links and reach), and this app stands in for itself, so the
 * tab never waits on the poll.
 */
function AppEnvTab({ app, apps, now }: { app: AppDetail; apps: Resource[]; now: number }) {
  const { load, reload, patch } = useProjectExtras(app.projectSlug);
  const extras = load.state === "ready" ? load.result.data : null;
  const error = load.state === "error" ? load.error : load.state === "ready" ? load.result.error : undefined;
  const project = useMemo<EnvProject>(() => {
    const others = apps.filter((r) => r.projectSlug === app.projectSlug && r.id !== app.id).map((r) => ({ ...r, url: null }));
    const list = [app, ...others];
    return { slug: app.projectSlug, environments: [...new Set(list.map((a) => a.environment))].map((name) => ({ name })), apps: list };
  }, [app, apps]);
  return (
    <EnvWorkbench
      project={project}
      extras={extras}
      loading={load.state === "loading"}
      loadError={extras?.envError ?? error}
      now={now}
      onPatch={patch}
      onReload={reload}
      appId={app.id}
    />
  );
}

/* -------------- Page -------------- */

/** One empty list while the overview has not answered, so the Variables tab does not rebuild every tick. */
const NO_RESOURCES: Resource[] = [];

/**
 * A head key that changes what runs. It keeps the focus while its action runs (PendingButton);
 * another action in flight, or a state it cannot act on, makes it unavailable. A Viewer can run
 * none of them, so a Viewer's head has no keys.
 */
function OpKey({
  op,
  label,
  icon,
  primary = false,
  busy,
  pending = busy === op,
  unavailable = false,
  manage,
  onRun,
}: {
  op: Op;
  label: string;
  icon?: IconName;
  primary?: boolean;
  busy: Op | null;
  pending?: boolean;
  unavailable?: boolean;
  manage: boolean;
  onRun: (op: Op) => void;
}) {
  if (!manage) return null;
  return (
    <PendingButton className={primary ? "btn btn-primary" : "btn"} icon={icon} pending={pending} disabled={!pending && (unavailable || busy !== null)} onClick={() => onRun(op)}>
      {label}
    </PendingButton>
  );
}

export function AppView({ overview, page, id }: { overview: OverviewResult; page: PageResult<AppPage>; id: string }) {
  const router = useRouter();
  const { result } = useOverview(overview);
  const now = useNow(1000, overview.fetchedAt);
  const can = useCan();
  const o = result.data;
  const notices = useMemo(() => (o ? deriveNotices(o, now) : null), [o, now]);
  const [tab, setTab] = useUrlTab(APP_TABS);
  // Switching away from Settings with unsaved edits asks first.
  const tabGuard = useTabSwitchGuard(tab, "settings", setTab);
  const [override, setOverride] = useState<{ status: AppStatus; at: string } | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [busy, setBusy] = useState<Op | null>(null);
  const [range, setRange] = useState<MetricRange>("24h");

  const app = useMemo(() => {
    const base = page.data?.app;
    if (!base) return null;
    // An action's expected state holds until the overview polls a newer snapshot.
    const live = o?.resources.find((r) => r.id === base.id)?.status;
    // The preview never changes, so there the action's state simply sticks.
    const fresh = override && (result.source === "preview" || Date.parse(result.fetchedAt) <= Date.parse(override.at));
    return { ...base, status: fresh ? override.status : (live ?? override?.status ?? base.status), settings: settings ?? base.settings };
  }, [page.data, o, override, settings, result.fetchedAt, result.source]);

  // The page's own snapshot holds the deployments: read it again when the polled status moves.
  const polled = app?.status;
  const lastPolled = useRef(polled);
  useEffect(() => {
    if (lastPolled.current === polled) return;
    lastPolled.current = polled;
    router.refresh();
  }, [polled, router]);

  const multiEnv = app ? projectsShowingEnvironments(o?.resources ?? [])(app.projectSlug) : false;
  const deployCount = app?.deployments.length;
  const kind = app?.kind;
  const hosted = !!app && onVercel(app);
  // A Viewer never gets the terminal, and nobody does while the instance's switch is off: the API says so per caller.
  const terminal = !!app?.terminal && can.manage;
  const tabs = useMemo(
    () => APP_TABS.filter((t) => (!kind || hasTab(kind, t)) && !(hosted && HOSTED_HIDES.has(t)) && (t !== "terminal" || terminal)).map((t) => ({ value: t, label: TAB_LABEL[t], count: t === "deployments" ? deployCount : undefined })),
    [deployCount, kind, hosted, terminal],
  );

  const trail = ["Apps", app?.name ?? id];

  if (!app) {
    return (
      <>
        <Topbar trail={trail} notices={notices} now={now} />
        <main className="page" id="main" tabIndex={-1}>
          {page.notFound ? (
            <NotFound
              title="No such app"
              body={`Nothing called “${id}” exists on this server. It may have been deleted or renamed.`}
              actions={
                <>
                  <Link href="/projects" className="btn btn-primary">
                    Open projects
                  </Link>
                  <Link href="/" className="btn">
                    Back to overview
                  </Link>
                </>
              }
            />
          ) : (
            <>
              <SectionHead level={1} title={id} lead="App" />
              <Rule />
              <NoSource error={page.error} />
            </>
          )}
          <Spacer end />
        </main>
      </>
    );
  }

  const run = async (op: Op) => {
    setBusy(op);
    const commit = app.deployments[0]?.commit?.slice(0, 7);
    const branch = app.deployments[0]?.branch;
    const what = `${app.projectSlug} / ${app.name}${op === "deploy" && branch ? `, ${branch}${commit ? ` ${commit}` : ""}` : ""}`;
    const r = await track(mutate({ type: "app.action", id: app.id, op }), {
      ...OP_COPY[op],
      what,
      // A new deployment has a natural next place: its own page, or the list when no id came back.
      action:
        op === "deploy"
          ? (res) => {
              const dep = deploymentIdOf(res.data);
              return { label: "View", onClick: () => router.push(dep ? `/deployments/${dep}` : "/deployments") };
            }
          : undefined,
    });
    setBusy(null);
    if (r.ok) {
      setOverride({ status: OP_STATUS[op], at: new Date().toISOString() });
      router.refresh();
    }
  };

  // A ?tab= this kind does not have (a shared link from another app) falls back to the overview.
  const shown: AppTab = hasTab(app.kind, tab) && !(hosted && HOSTED_HIDES.has(tab)) && (tab !== "terminal" || terminal) ? tab : "overview";
  // Nothing runs: Start brings the container back, unless there is none to start (it never went
  // live, or the daemon lost it), where only a deploy helps.
  const down = notRunning(app.status);
  const noContainer = app.status === "missing" || app.status === "failed" || app.status === "unknown";
  const deploying = app.status === "deploying";

  return (
    <PreviewProvider preview={page.source === "preview"}>
      <Topbar trail={trail} notices={notices} now={now} />
      <main className="page pd" id="main" tabIndex={-1}>
        <Crumbs
          back
          current={false}
          items={[
            { label: "Projects", href: "/projects" },
            { label: app.projectSlug, href: `/projects/${app.projectSlug}`, icon: <ProjectIcon slug={app.projectSlug} /> },
          ]}
        />
        <SectionHead
          level={1}
          title={
            <span className="pd-title">
              <AppIcon id={app.id} kind={app.kind} size="lg" />
              <span className="ellipsis" title={app.name}>{app.name}</span>
            </span>
          }
          lead={
            <DetailLead tone={APP_TONE[app.status]} state={APP_STATUS_LABEL[app.status]} envs={multiEnv ? [app.environment] : []}>
              <span className="pd-kind">{KIND_LABEL[app.kind]}</span>
              {app.url ? (
                <a href={app.url} target="_blank" rel="noreferrer" className="pd-repo">
                  <Icon name="globe" size={14} />
                  <span className="ellipsis">{hostOf(app.url)}</span>
                </a>
              ) : null}
            </DetailLead>
          }
          actions={
            <>
              {hosted ? null : down ? (
                <OpKey op="start" label="Start" busy={busy} unavailable={noContainer} manage={can.manage} onRun={run} />
              ) : (
                <OpKey op="stop" label="Stop" busy={busy} manage={can.manage} onRun={run} />
              )}
              {hosted ? null : <OpKey op="restart" label="Restart" busy={busy} unavailable={down} manage={can.manage} onRun={run} />}
              {app.target?.kind === "vercel" && app.target.mode !== "deploy" ? null : <OpKey op="deploy" label="Deploy" icon="deploy" primary busy={busy} pending={busy === "deploy" || deploying} manage={can.manage} onRun={run} />}
            </>
          }
        />
        <Rule />
        <Tabs id="app" label="App sections" value={shown} onChange={tabGuard.change} tabs={tabs} />
        <Rule />

        <TabPanel id="app" value={shown} className="pd-panel">
          {shown === "overview" ? <OverviewTab app={app} now={now} /> : null}
          {shown === "deployments" ? (
            <DeployCard
              scope="app"
              deployments={withRepo(app.deployments, app.repo)}
              now={now}
              sub={`${hosted ? "Every deployment on Vercel of" : "Every build of"} ${app.projectSlug} / ${app.name}, newest first`}
              emptyBody={hosted ? (app.target?.mode === "deploy" ? "Vercel’s deployments of the linked project show here within a couple of minutes. Press Deploy to start one." : "Vercel’s deployments of the linked project show here within a couple of minutes.") : "Press Deploy, or push to the environment’s branch."}
            />
          ) : null}
          {shown === "logs" && hosted ? <VercelRuntimeLogs appId={app.id} inspectorUrl={app.deployments.find((d) => d.external?.inspectorUrl)?.external?.inspectorUrl} name={`${app.projectSlug}-${app.name}`} sub="Read live from Vercel" /> : null}
          {shown === "logs" && !hosted ? <LogPanel lines={page.data?.logs ?? null} error={page.data?.logsError} status={app.status} name={app.name} /> : null}
          {shown === "metrics" ? <MetricsTab app={app} now={now} range={range} onRange={setRange} onSettings={() => setTab("settings")} /> : null}
          {shown === "env" ? <AppEnvTab app={app} apps={o?.resources ?? NO_RESOURCES} now={now} /> : null}
          {shown === "domains" ? <DomainsTab app={app} now={now} /> : null}
          {shown === "jobs" ? <JobsTab appId={app.id} /> : null}
          {shown === "data" ? <DataTab app={app} /> : null}
          {shown === "backups" ? <BackupsTab app={app} now={now} /> : null}
          {shown === "terminal" ? <TerminalTab app={app} /> : null}
          {shown === "settings" ? <SettingsTab app={app} multiEnv={multiEnv} now={now} onSaved={setSettings} onDirty={tabGuard.onDirty} /> : null}
        </TabPanel>
        {tabGuard.dialog}
        <Spacer end />
      </main>
    </PreviewProvider>
  );
}
