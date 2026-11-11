"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CardTitle } from "@/components/card-title";
import { Icon } from "@/components/icon";
import { AppIcon, ProjectIcon } from "@/components/icons/app-icon";
import { NewAppDialog } from "@/components/new-app/new-app-dialog";
import type { SourceType } from "@/components/new-app/spec";
import { useProjectExtras } from "@/components/project-extras/api";
import { EnvWorkbench } from "@/components/project-extras/env-workbench";
import { PREVIEW_SETTINGS_ID, PreviewsTab } from "@/components/project-extras/previews";
import { LastDeployment } from "@/components/projects/project-card";
import { DomainHead, DomainRow } from "@/components/resources-domains/shared";
import { Topbar } from "@/components/shell/topbar";
import { StatusChip } from "@/components/ui/chip";
import { Crumbs } from "@/components/ui/crumbs";
import { Empty } from "@/components/ui/empty";
import { EnvTag, envName } from "@/components/ui/env-tag";
import { RepoRef } from "@/components/ui/git-ref";
import { NoSource } from "@/components/ui/no-source";
import { NotFound } from "@/components/ui/not-found";
import { PreviewProvider } from "@/components/ui/preview";
import { filterOptions, Segmented } from "@/components/ui/segmented";
import { Corners, Node, Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { APP_STATUS_LABEL, APP_TONE, deriveNotices } from "@/lib/derive";
import { appTitle, plural } from "@/lib/format";
import { withRepo } from "@/lib/git-links";
import { showsEnvironments } from "@/lib/environments";
import { useNow, useOverview } from "@/lib/hooks";
import type { AppSummary, PageResult, ProjectDetail, ProjectPage } from "@/lib/pages/project-detail";
import type { OverviewResult } from "@/lib/types";
import { useCan } from "@/lib/viewer";
import { useTabSwitchGuard } from "./controls";
import { previewsMoving, statusKey } from "./live";
import { ProjectSettings } from "./project-settings";
import { DeployCard, DetailLead, hostOf, KIND_LABEL, projectState, ResourcePips, useUrlTab } from "./shared";

const PROJECT_TABS = ["apps", "deployments", "previews", "env", "domains", "settings"] as const;
type ProjectTab = (typeof PROJECT_TABS)[number];

const TAB_LABEL: Record<ProjectTab, string> = {
  apps: "Apps",
  deployments: "Deployments",
  previews: "Previews",
  env: "Variables",
  domains: "Domains",
  settings: "Settings",
};

function AppCard({ a, now, multiEnv, delay, repoUrl }: { a: AppSummary; now: number; multiEnv: boolean; delay: number; repoUrl: string | null }) {
  // A deployment read without a repository takes the project's, so its branch and hash still link.
  const d = a.lastDeployment ? withRepo([a.lastDeployment], repoUrl)[0] : undefined;
  return (
    <article className="pj-cell reveal" style={{ animationDelay: `${delay}ms` }}>
      <Corners />
      <div className="pj-body">
        <header className="pj-hd">
          <Link href={`/apps/${a.id}`} className="pj-hd-link">
            <AppIcon id={a.id} kind={a.kind} size="lg" />
            <span className="pj-id">
              <h2 className="pj-name ellipsis">{appTitle(a)}</h2>
              <span className="pd-app-sub">
                {KIND_LABEL[a.kind]}
                {multiEnv ? <EnvTag env={a.environment} compact /> : null}
              </span>
            </span>
          </Link>
          <StatusChip tone={APP_TONE[a.status]} className="pj-status">
            {APP_STATUS_LABEL[a.status]}
          </StatusChip>
        </header>

        <div className="pj-sec">
          <div className="pj-cap">
            <span>URL</span>
          </div>
          {a.url ? (
            <a href={a.url} target="_blank" rel="noreferrer" className="pd-url">
              <span className="ellipsis">{hostOf(a.url)}</span>
              <Icon name="arrowUpRight" size={14} />
            </a>
          ) : (
            <p className="pj-none">{a.kind === "postgres" || a.kind === "redis" ? "Internal only" : "No public domain"}</p>
          )}
        </div>

        <LastDeployment d={d} now={now} />
      </div>

      <footer className="pj-ft">
        <Node pos="tl" />
        <Node pos="tr" />
        <ResourcePips usage={a.usage} status={a.status} />
      </footer>
    </article>
  );
}

/** The environment switcher's "every environment" choice. Never an environment name: those start with a letter or digit. */
const ALL = "*";

function AppsTab({ p, env, now, onNew }: { p: ProjectDetail; env: string; now: number; onNew?: () => void }) {
  const apps = env === ALL ? p.apps : p.apps.filter((a) => a.environment === env);
  if (!apps.length) {
    const where = env === ALL ? "" : ` in ${envName(env)}`;
    return (
      <div className="card">
        <Empty
          icon="box"
          title={`No apps${where} yet`}
          body={
            onNew
              ? "Add a frontend, a backend, a bot or a database. Each app builds from its own repository or Git URL, or runs from an image."
              : `An admin can add a frontend, a backend, a bot or a database${where ? ` to ${envName(env)}` : " here"}.`
          }
          action={
            onNew ? (
              <button type="button" className="btn btn-primary" onClick={onNew}>
                <Icon name="plus" />
                New app
              </button>
            ) : null
          }
        />
      </div>
    );
  }
  // A card names its environment only when the cards around it sit in more than one.
  const multiEnv = new Set(apps.map((a) => a.environment)).size > 1;
  return (
    <section className="pj-grid" aria-label="Apps">
      {apps.map((a, i) => (
        <AppCard key={a.id} a={a} now={now} multiEnv={multiEnv} delay={i * 40} repoUrl={p.repo?.url ?? null} />
      ))}
    </section>
  );
}

/** Kept in `?env=`; every environment is the bare URL. A switch replaces the history entry. */
function useEnvFilter() {
  const param = useSearchParams().get("env") ?? ALL;
  const [value, setValue] = useState(param);
  const [seen, setSeen] = useState(param);
  if (param !== seen) {
    setSeen(param);
    setValue(param);
  }
  const change = useCallback((next: string) => {
    setValue(next);
    const url = new URL(window.location.href);
    if (next === ALL) url.searchParams.delete("env");
    else url.searchParams.set("env", next);
    window.history.replaceState(null, "", url);
  }, []);
  return [value, change] as const;
}

/* The domains page row, without the DNS column (the project read has no lookup) or the project,
   which this page already is. Adding and removing happen on an app or on the Domains page. */
function DomainsTab({ p, env, now, manage }: { p: ProjectDetail; env: string; now: number; manage: boolean }) {
  const domains = env === ALL ? p.domains : p.domains.filter((d) => d.environment === env);
  const active = domains.filter((d) => d.tls === "active").length;
  return (
    <section className="card" aria-labelledby="pd-dom-title">
      <div className="card-hd">
        <CardTitle id="pd-dom-title" icon="globe" title="Domains" sub={domains.length ? `${plural(domains.length, "domain")}, ${active} with TLS active` : env === ALL ? "Hostnames routed to this project’s apps" : `Hostnames routed to its apps in ${envName(env)}`} />
        <Link href="/domains" className="btn btn-sm">
          View all domains
        </Link>
      </div>
      {domains.length === 0 ? (
        <Empty
          icon="globe"
          title="No domains yet"
          body={
            manage
              ? "Add a hostname from an app’s Domains tab. Dockify issues its certificate once DNS points at this server."
              : "An admin can add a hostname from an app’s Domains tab. Dockify issues its certificate once DNS points at this server."
          }
        />
      ) : (
        <div className="rd-list">
          <DomainHead target dns={false} />
          <ul className="dm-rows" aria-label="Domains">
            {domains.map((d, i) => (
              <DomainRow
                project={p.slug}
                key={d.id}
                d={{ id: d.id, hostname: d.host, appId: d.appId, appName: d.appName, appDisplayName: d.appDisplayName, environment: d.environment, tls: { status: d.tls, expiresAt: d.expiresAt } }}
                now={now}
                showTarget
                delay={Math.min(i, 12) * 30}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function ProjectView({ overview, page, slug }: { overview: OverviewResult; page: PageResult<ProjectPage>; slug: string }) {
  const router = useRouter();
  const { result } = useOverview(overview);
  const now = useNow(30_000, overview.fetchedAt);
  const can = useCan();
  const o = result.data;
  const notices = useMemo(() => (o ? deriveNotices(o, now) : null), [o, now]);
  const [tab, setTab] = useUrlTab(PROJECT_TABS);
  const [envFilter, setEnvFilter] = useEnvFilter();
  const tabGuard = useTabSwitchGuard(tab, "settings", setTab);
  const [saved, setSaved] = useState<ProjectDetail | null>(null);
  // What a save put here holds only until the server sends the page again (router.refresh).
  const [seenPage, setSeenPage] = useState(page);
  if (page !== seenPage) {
    setSeenPage(page);
    setSaved(null);
  }
  const { load, reload, patch } = useProjectExtras(slug);
  const extras = load.state === "ready" ? load.result.data : null;
  const extrasLoading = load.state === "loading";
  const extrasError = load.state === "error" ? load.error : load.state === "ready" ? load.result.error : undefined;

  // `?new=service` opens New app on the Database or service step and `&for=<app id>` names the app
  // the new service starts linked to. Closing drops both, so a reload stays put.
  const search = useSearchParams();
  const asked = search.get("new") === "service";
  const askedFor = asked ? (search.get("for") ?? undefined) : undefined;
  const [newApp, setNewApp] = useState<{ start?: SourceType; forApp?: string; environment?: string } | null>(asked ? { start: "service", forApp: askedFor } : null);
  const [seenAsk, setSeenAsk] = useState(asked);
  if (asked !== seenAsk) {
    setSeenAsk(asked);
    if (asked) setNewApp({ start: "service", forApp: askedFor });
  }
  const closeNew = useCallback(() => {
    setNewApp(null);
    const url = new URL(window.location.href);
    if (url.searchParams.has("new") || url.searchParams.has("for")) {
      url.searchParams.delete("new");
      url.searchParams.delete("for");
      window.history.replaceState(null, "", url);
    }
  }, []);

  // Live app status from the polled overview wins over the page snapshot.
  const project = useMemo(() => {
    const base = saved ?? page.data?.project;
    if (!base) return null;
    const live = new Map(o?.resources.map((r) => [r.id, r.status]));
    return { ...base, apps: base.apps.map((a) => ({ ...a, status: live.get(a.id) ?? a.status })) };
  }, [saved, page.data, o]);

  // The page's own snapshot holds the deployments and their counts: read it again when a polled status moves.
  const polled = project ? statusKey(project.apps) : null;
  const lastPolled = useRef(polled);
  useEffect(() => {
    if (lastPolled.current === polled) return;
    lastPolled.current = polled;
    router.refresh();
  }, [polled, router]);

  // Previews load with the extras, which have no poll of their own. While one is building or being
  // deleted they are read again on each overview snapshot, so the row settles.
  const moving = previewsMoving(extras?.previews?.previews);
  const tick = result.fetchedAt;
  const lastTick = useRef(tick);
  useEffect(() => {
    if (lastTick.current === tick) return;
    lastTick.current = tick;
    if (moving) void reload();
  }, [tick, moving, reload]);

  // A project with one environment shows none: no switcher, nothing narrowed.
  const multi = project ? showsEnvironments(project.environments) : false;
  const env = multi && project?.environments.some((e) => e.name === envFilter) ? envFilter : ALL;
  const inEnv = useCallback((x: { environment: string }) => env === ALL || x.environment === env, [env]);

  const tabs = useMemo(() => {
    if (!project) return [];
    const e = extras?.env;
    const counts: Partial<Record<ProjectTab, number>> = {
      apps: project.apps.filter(inEnv).length,
      deployments: project.deployments.filter(inEnv).length,
      previews: extras?.previews?.settings.enabled ? extras.previews.previews.length : undefined,
      env: e
        ? e.environments.filter((x) => inEnv({ environment: x.name })).reduce((n, x) => n + x.vars.length, 0) + e.overrides.filter(inEnv).reduce((n, o) => n + o.vars.length, 0)
        : undefined,
      domains: project.domains.filter(inEnv).length,
    };
    return PROJECT_TABS.map((t) => ({ value: t, label: TAB_LABEL[t], count: counts[t] }));
  }, [project, extras, inEnv]);

  // Settings holds the preview options: switch there, then bring the card into view once it
  // renders, gliding unless the operator asked for less motion.
  const openPreviewSettings = useCallback(() => {
    setTab("settings");
    requestAnimationFrame(() => {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      document.getElementById(PREVIEW_SETTINGS_ID)?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    });
  }, [setTab]);

  // The name the owner gave the project; the slug is only its address.
  const trail = ["Projects", project?.name || project?.slug || slug];

  if (!project) {
    return (
      <>
        <Topbar trail={trail} notices={notices} now={now} />
        <main className="page" id="main" tabIndex={-1}>
          {page.notFound ? (
            <NotFound
              title="No such project"
              body={`Nothing called “${slug}” exists on this server. It may have been deleted or renamed.`}
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
              <SectionHead level={1} title={slug} lead="Project" />
              <Rule />
              <NoSource error={page.error} />
            </>
          )}
          <Spacer end />
        </main>
      </>
    );
  }

  const state = projectState(project.apps);
  const openNew = can.manage ? () => setNewApp(env === ALL ? {} : { environment: env }) : undefined;

  return (
    <PreviewProvider preview={page.source === "preview"}>
      <Topbar trail={trail} notices={notices} now={now} />
      <main className="page pd" id="main" tabIndex={-1}>
        <Crumbs back current={false} items={[{ label: "Projects", href: "/projects" }]} />
        <SectionHead
          level={1}
          title={
            <span className="pd-title">
              <ProjectIcon slug={project.slug} size="lg" />
              <span className="ellipsis" title={project.name || project.slug}>{project.name || project.slug}</span>
            </span>
          }
          lead={
            <DetailLead tone={state.tone} state={state.label} envs={[]}>
              {/* Projects made before apps carried their own source named one repository; a project made now names none. */}
              {project.repo ? <RepoRef source={project.repo.url} label={project.repo.label} className="pd-repo" icon={<Icon name="github" size={14} />} /> : null}
            </DetailLead>
          }
          actions={
            multi || openNew ? (
              <>
                {multi ? (
                  <Segmented
                    label="Environment"
                    value={env}
                    onChange={setEnvFilter}
                    options={filterOptions([
                      { value: ALL, label: "All", count: project.apps.length, tip: "Every environment" },
                      ...project.environments.map((e) => ({
                        value: e.name,
                        label: envName(e.name),
                        count: project.apps.filter((a) => a.environment === e.name).length,
                        tip: `Deploys from ${e.branch}`,
                      })),
                    ])}
                  />
                ) : null}
                {openNew ? (
                  <button type="button" className="btn btn-primary" onClick={openNew}>
                    <Icon name="plus" />
                    New app
                  </button>
                ) : null}
              </>
            ) : null
          }
        />
        <Rule />
        <Tabs id="project" label="Project sections" value={tab} onChange={tabGuard.change} tabs={tabs} />
        <Rule />

        <TabPanel id="project" value={tab} className="pd-panel">
          {tab === "apps" ? <AppsTab p={project} env={env} now={now} onNew={openNew} /> : null}
          {tab === "deployments" ? (
            <DeployCard
              scope="project"
              deployments={withRepo(project.deployments.filter(inEnv), project.repo?.url)}
              now={now}
              sub={env === ALL ? `Every build of ${project.slug}, newest first` : `Every build in ${envName(env)}, newest first`}
              emptyBody="Push to an app’s branch or press Deploy on an app. Every build of this project shows up here."
            />
          ) : null}
          {tab === "previews" ? (
            <PreviewsTab
              p={project}
              state={extras?.previews ?? null}
              error={extras?.previewsError ?? extrasError}
              loading={extrasLoading}
              now={now}
              onOpenSettings={openPreviewSettings}
              onDeleted={(pr) => patch((d) => ({ ...d, previews: d.previews && { ...d.previews, previews: d.previews.previews.map((x) => (x.pr === pr ? { ...x, status: "closing" as const } : x)) } }))}
              onReload={() => void reload()}
            />
          ) : null}
          {tab === "env" ? (
            <EnvWorkbench project={project} extras={extras} loading={extrasLoading} loadError={extras?.envError ?? extrasError} now={now} onPatch={patch} onReload={reload} environment={env === ALL ? undefined : env} />
          ) : null}
          {tab === "domains" ? <DomainsTab p={project} env={env} now={now} manage={can.manage} /> : null}
          {tab === "settings" ? (
            <ProjectSettings
              p={project}
              onSaved={setSaved}
              extras={extras}
              extrasLoading={extrasLoading}
              extrasError={extrasError}
              now={now}
              onPatch={patch}
              onOpenPreviews={openPreviewSettings}
              onReload={() => void reload()}
              onDirty={tabGuard.onDirty}
            />
          ) : null}
        </TabPanel>
        {tabGuard.dialog}
        <Spacer end />
      </main>

      {can.manage ? <NewAppDialog p={project} open={newApp !== null} start={newApp?.start} forApp={newApp?.forApp} environment={newApp?.environment} onClose={closeNew} /> : null}
    </PreviewProvider>
  );
}
