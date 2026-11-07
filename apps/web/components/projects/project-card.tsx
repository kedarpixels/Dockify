import Link from "next/link";
import { Icon } from "@/components/icon";
import { AppIcon, ProjectIcon } from "@/components/icons/app-icon";
import { KIND_LABEL } from "@/components/project-detail/shared";
import { StatusChip } from "@/components/ui/chip";
import { EnvTag } from "@/components/ui/env-tag";
import { BranchRef, GitLink } from "@/components/ui/git-ref";
import { Corners, Node } from "@/components/ui/rule";
import { When } from "@/components/ui/when";
import { deployMessage } from "@/lib/deploy-source";
import { APP_STATUS_LABEL, APP_TONE, DEPLOY_LABEL, DEPLOY_TONE, upCount, type ProjectCard as ProjectSummary } from "@/lib/derive";
import { showsEnvironments } from "@/lib/environments";
import { plural } from "@/lib/format";
import { commitHref, githubRepo } from "@/lib/git-links";
import type { AppStatus, RecentDeployment } from "@/lib/types";

/*
 * One project card and the last deployment block, shared by the Overview strip, the Projects grid
 * and list, and the app cards on a project's page, so a project and its latest build read the same
 * on every page: the status dot and message, then branch, hash and app, the time on the caption.
 *
 *   <ProjectCard p={p} now={now} variant="grid" />        Projects: identity, last deployment, apps
 *   <ProjectCard p={p} now={now} variant="carousel" />    Overview strip: the whole card opens it
 *   <LastDeployment d={app.lastDeployment} now={now} />   an app card, which is the app itself
 */

/** When a deployment ran, relative with the moment in the tip; "Now" while it builds or deploys. */
export function DeployTime({ d, now }: { d: RecentDeployment; now: number }) {
  return <When iso={d.createdAt} now={now} live={DEPLOY_TONE[d.status] === "live"} tipAlign="end" className="num" />;
}

/** A deployment's round status dot, its state spoken and in the tip. */
export function DeployDot({ d }: { d: RecentDeployment }) {
  const tone = DEPLOY_TONE[d.status];
  return <span className={tone === "live" ? "dot pulse" : "dot"} data-tone={tone} role="img" aria-label={DEPLOY_LABEL[d.status]} data-tip={DEPLOY_LABEL[d.status]} />;
}

/** Branch, short hash, then the app when the card is not the app itself. The hash opens the commit. */
export function DeployRefs({ d, withApp = false }: { d: RecentDeployment; withApp?: boolean }) {
  const repo = githubRepo(d.repo);
  return (
    <span className="pj-meta">
      {d.branch ? <BranchRef repo={repo} branch={d.branch} iconSize={14} className="pj-meta-item" /> : null}
      {d.commit ? (
        <GitLink href={commitHref(repo, d.commit)} className="pj-meta-item num">
          {d.commit.slice(0, 7)}
        </GitLink>
      ) : null}
      {withApp ? (
        <span className="pj-meta-item ellipsis" title={d.app.name}>
          {d.app.name}
        </span>
      ) : null}
    </span>
  );
}

/** The card section: "Last deployment" and its time, the dot and message, then the refs. */
export function LastDeployment({ d, now, withApp = false }: { d?: RecentDeployment; now: number; withApp?: boolean }) {
  return (
    <div className="pj-sec pj-last">
      <div className="pj-cap">
        <span>Last deployment</span>
        {d ? <DeployTime d={d} now={now} /> : null}
      </div>
      {d ? (
        <>
          <p className="pj-last-msg">
            <DeployDot d={d} />
            <span className="ellipsis" title={d.image ?? deployMessage(d)}>
              {deployMessage(d)}
            </span>
          </p>
          <DeployRefs d={d} withApp={withApp} />
        </>
      ) : (
        <p className="pj-none">No deployments yet</p>
      )}
    </div>
  );
}

/**
 * The line under a project's name: every environment, production included, when the project shows
 * them (lib/environments.ts); otherwise how many apps it holds, so cards keep one height.
 */
export function Envs({ envs, apps }: { envs: string[]; apps: number }) {
  if (!showsEnvironments(envs)) return <span className="two-sub num">{plural(apps, "app")}</span>;
  return (
    <span className="pj-envs">
      {envs.map((e) => (
        <EnvTag key={e} env={e} />
      ))}
    </span>
  );
}

const ORDER: AppStatus[] = ["running", "deploying", "degraded", "stopped", "unknown"];

/** One pip per app in its state's colour; the counts by state are spoken, each app's state is its tip. */
function Pips({ apps }: { apps: ProjectSummary["apps"] }) {
  const said = ORDER.map((s) => [s, apps.filter((a) => a.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${APP_STATUS_LABEL[s].toLowerCase()}`)
    .join(", ");
  return (
    <span className="pips" role="img" aria-label={said || "No apps"}>
      {apps.map((a) => (
        <i key={a.id} data-tone={APP_TONE[a.status]} data-tip={`${a.name}, ${APP_STATUS_LABEL[a.status].toLowerCase()}`} />
      ))}
    </span>
  );
}

/** How many apps a card lists before it hands over to the project page. */
const SHOWN = 5;

/**
 * A ruled project cell: the identity head (40px icon, name, environments, state), the last
 * deployment, on the grid its apps too, then the running count over a ruled foot. The grid card
 * opens the project from its head (its app rows open each app); the carousel card is one link.
 * The name is an h2 on the Projects page and an h3 under the Overview's Projects card.
 */
export function ProjectCard({ p, now, variant, delay = 0 }: { p: ProjectSummary; now: number; variant: "grid" | "carousel"; delay?: number }) {
  const href = `/projects/${p.slug}`;
  const H = variant === "carousel" ? "h3" : "h2";
  const running = upCount(p.apps);
  const shown = p.apps.slice(0, SHOWN);
  const multiEnv = showsEnvironments(p.environments);
  return (
    <article className="pj-cell reveal" data-variant={variant} style={delay ? { animationDelay: `${delay}ms` } : undefined}>
      <Corners />
      <div className="pj-body">
        <header className="pj-hd">
          <Link href={href} className="pj-hd-link" data-row-link>
            <ProjectIcon slug={p.slug} size="lg" />
            <span className="two">
              <H className="two-main pj-name ellipsis" title={p.name}>
                {p.name}
              </H>
              <Envs envs={p.environments} apps={p.apps.length} />
            </span>
          </Link>
          <StatusChip tone={p.tone} className="pj-status">
            {p.stateLabel}
          </StatusChip>
        </header>

        <LastDeployment d={p.last} now={now} withApp />

        {variant === "grid" && p.apps.length ? (
          <div className="pj-sec">
            <div className="pj-cap">
              <span>Apps</span>
              <span className="num">{p.apps.length}</span>
            </div>
            <ul className="soft-list pj-apps">
              {shown.map((a) => (
                <li key={a.id}>
                  <Link href={`/apps/${a.id}`} className="soft-row pj-app">
                    <AppIcon id={a.id} kind={a.kind} />
                    <span className="pj-app-name ellipsis" title={a.name}>
                      {a.name}
                    </span>
                    {multiEnv ? <EnvTag env={a.environment} quiet compact /> : null}
                    <span className="pj-kind">{KIND_LABEL[a.kind]}</span>
                    <span className="dot" data-tone={APP_TONE[a.status]} role="img" aria-label={APP_STATUS_LABEL[a.status]} data-tip={APP_STATUS_LABEL[a.status]} />
                  </Link>
                </li>
              ))}
              {p.apps.length > SHOWN ? (
                <li>
                  {/* A row of the list like the apps above it (owner: no empty-looking row): a quiet
                      tile where their icons sit, the label in the names' column, an arrow where
                      their status dots are. It opens the project, where every app is listed. */}
                  <Link href={href} className="soft-row pj-app pj-app-more">
                    <span className="pj-more-tile" aria-hidden="true">
                      <Icon name="more" size={12} />
                    </span>
                    <span className="pj-app-name">View all {p.apps.length} apps</span>
                    <Icon name="arrowRight" size={14} className="pj-more-arrow" />
                  </Link>
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}
      </div>

      <footer className="pj-ft">
        <Node pos="tl" />
        <Node pos="tr" />
        <Pips apps={p.apps} />
        <span className="pj-running num">
          {running} of {p.apps.length} running
        </span>
      </footer>
    </article>
  );
}
