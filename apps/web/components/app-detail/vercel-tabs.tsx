"use client";

import Link from "next/link";
import { CardTitle } from "@/components/card-title";
import { Icon } from "@/components/icon";
import { DeployRow } from "@/components/overview/deploy-row";
import { Callout } from "@/components/ui/callout";
import { Chip, StatusChip } from "@/components/ui/chip";
import { CopyButton } from "@/components/ui/copy-button";
import { Empty } from "@/components/ui/empty";
import { ExternalLink } from "@/components/ui/external-link";
import { SkelRows } from "@/components/ui/skeleton";
import { When } from "@/components/ui/when";
import { DEPLOY_LABEL, DEPLOY_TONE } from "@/lib/derive";
import { duration, plural } from "@/lib/format";
import { withRepo } from "@/lib/git-links";
import type { AppDetail, VercelEnvList, VercelEnvVar, VercelProjectView, VercelTargetName } from "@/lib/pages/project-detail";
import { TabCard, TabFailed } from "./states";
import { useAppTab } from "./use-tab";
import { frameworkLabel, valueNote, visitHosts } from "./vercel-view";

/* Read-only: every change goes to Vercel through a "Manage on Vercel" key. Nothing here writes to Vercel. */

const TARGET_LABEL: Record<VercelTargetName, string> = { production: "Production", preview: "Preview", development: "Development" };

function OnVercel({ href, children = "Manage on Vercel" }: { href: string; children?: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="btn btn-sm">
      {children}
      <span className="sr">, opens in a new tab</span>
    </a>
  );
}

const hostLink = (h: string) => (
  <ExternalLink key={h} href={`https://${h}`}>
    {h}
  </ExternalLink>
);

function Facts({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="pd-kv">
      {rows.map(([k, v]) => (
        <div key={k} className="pd-kv-row">
          <dt className="kv-label">{k}</dt>
          <dd className="kv-value">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const KV_SKELETON = <SkelRows rows={5} height={44} template="96px minmax(0,1fr)" cols={[72, { w: "55%" }]} label="Reading Vercel" className="vx-skel" />;

function ProductionCard({ v, loading, error, onRetry, now }: { v: VercelProjectView | null; loading: boolean; error: string | null; onRetry: () => void; now: number }) {
  const p = v?.production ?? null;
  const visit = visitHosts(p?.aliases ?? []);
  return (
    <section className="card" aria-labelledby="vx-prod-title">
      <div className="card-hd">
        <CardTitle id="vx-prod-title" icon="globe" title="Production" sub={p ? "What Vercel serves on the production domains" : "Read live from Vercel"} />
        {p?.inspectorUrl ? <OnVercel href={p.inspectorUrl}>Inspect</OnVercel> : null}
      </div>
      {!v && loading ? (
        KV_SKELETON
      ) : !v ? (
        <TabFailed error={error} onRetry={onRetry} what="Vercel" />
      ) : !p ? (
        <Empty icon="deploy" title="Nothing in production yet" body="Vercel has no production deployment of this project. Push to its production branch, or promote a deployment on Vercel." />
      ) : (
        <Facts
          rows={[
            ["Status", <StatusChip key="s" tone={DEPLOY_TONE[p.status]}>{DEPLOY_LABEL[p.status]}</StatusChip>],
            [
              visit.shown.length > 1 ? "Domains" : "Domain",
              visit.shown.length ? (
                <span key="d" className="vx-stack">
                  {visit.shown.map(hostLink)}
                  {visit.more ? <span className="vx-muted">{plural(visit.more, "more domain")}</span> : null}
                </span>
              ) : (
                <span key="d" className="vx-muted">None assigned</span>
              ),
            ],
            [
              "Commit",
              p.message || p.commit ? (
                <span key="c" className="vx-stack">
                  {p.deploymentId ? (
                    <Link href={`/deployments/${encodeURIComponent(p.deploymentId)}`} className="vx-msg">
                      {p.message ?? "No message"}
                    </Link>
                  ) : (
                    <span className="vx-msg">{p.message ?? "No message"}</span>
                  )}
                  {p.commit ? (
                    p.commitUrl ? (
                      <a href={p.commitUrl} target="_blank" rel="noopener noreferrer" className="hash-chip num" aria-label={`View commit ${p.commit.slice(0, 7)}`}>
                        {p.commit.slice(0, 7)}
                      </a>
                    ) : (
                      <span className="hash-chip num">{p.commit.slice(0, 7)}</span>
                    )
                  ) : null}
                </span>
              ) : (
                <span key="c" className="vx-muted">Not from Git</span>
              ),
            ],
            ["Branch", p.branch ? <span key="b" className="pd-mono">{p.branch}</span> : <span key="b" className="vx-muted">None</span>],
            ["Author", p.author ?? <span key="a" className="vx-muted">Unknown</span>],
            ["Created", <When key="w" iso={p.createdAt} now={now} tipAlign="end" />],
            ["Build time", p.durationMs !== null ? <span key="t" className="num">{duration(p.durationMs / 1000)}</span> : <span key="t" className="vx-muted">Not finished</span>],
          ]}
        />
      )}
    </section>
  );
}

function ProjectCard({ app, v, loading, error, onRetry }: { app: AppDetail; v: VercelProjectView | null; loading: boolean; error: string | null; onRetry: () => void }) {
  const deploy = app.target?.mode === "deploy";
  return (
    <section className="card" aria-labelledby="vx-proj-title">
      <div className="card-hd">
        <CardTitle id="vx-proj-title" icon="vercel" title="Vercel project" sub={deploy ? "Dockify sends its variables and starts its deploys" : "Followed read only"} />
        {v ? <OnVercel href={v.links.project}>Open on Vercel</OnVercel> : null}
      </div>
      {!v && loading ? (
        KV_SKELETON
      ) : !v ? (
        <TabFailed error={error} onRetry={onRetry} what="The Vercel project" />
      ) : (
        <Facts
          rows={[
            [
              "Project",
              <span key="p" className="pd-copytext">
                <span className="pd-mono ellipsis" title={v.id}>
                  {v.name}
                </span>
                <CopyButton value={v.id} what="Vercel project ID" align="end" />
              </span>,
            ],
            ["Framework", frameworkLabel(v.framework)],
            ["Node.js", v.nodeVersion ?? <span key="n" className="vx-muted">Vercel default</span>],
            ["Root directory", v.rootDirectory ? <span key="r" className="pd-mono">{v.rootDirectory}</span> : <span key="r" className="vx-muted">Repository root</span>],
            [
              "Git repository",
              v.repo ? (
                <span key="g" className="vx-stack">
                  {v.repo.url ? <ExternalLink href={v.repo.url}>{v.repo.slug}</ExternalLink> : v.repo.slug}
                  {v.repo.productionBranch ? <span className="vx-muted">Production branch <span className="pd-mono">{v.repo.productionBranch}</span></span> : null}
                </span>
              ) : (
                <span key="g" className="vx-muted">Not connected</span>
              ),
            ],
          ]}
        />
      )}
    </section>
  );
}

function PreviewsCard({ app, now, onAll }: { app: AppDetail; now: number; onAll: () => void }) {
  const previews = withRepo(app.deployments.filter((d) => d.external?.target === "preview"), app.repo).slice(0, 5);
  return (
    <section className="card dep-card" aria-labelledby="vx-prev-title">
      <div className="card-hd">
        <CardTitle id="vx-prev-title" icon="branch" title="Latest previews" sub="Vercel’s builds of other branches, newest first" />
        <button type="button" className="btn btn-sm" onClick={onAll}>
          All deployments
        </button>
      </div>
      {previews.length ? (
        <div className="dep-list">
          <ul className="soft-list">
            {previews.map((d) => (
              <li key={d.id}>
                <DeployRow d={d} now={now} scope="app" />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <Empty icon="branch" title="No recent previews" body="A push to a branch other than production shows here once Vercel builds it." />
      )}
    </section>
  );
}

/** Why a Vercel app has no Deploy, Restart, Metrics or Terminal here, said once. */
export function VercelNote({ app }: { app: AppDetail }) {
  return (
    <div className="vx-note-wrap">
      <Callout icon="info">
        {app.target?.mode === "deploy"
          ? "Vercel builds and serves this app. Dockify sends its variables and starts its deploys; roll back on Vercel. Nothing runs on this server, so there is no restart, metrics or terminal."
          : "Vercel builds and serves this app, and Dockify follows it read only. Deploy, roll back, and change variables or domains on Vercel. Nothing runs on this server, so there is no restart, metrics or terminal."}
      </Callout>
    </div>
  );
}

export function VercelOverview({ app, now, onTab }: { app: AppDetail; now: number; onTab: (t: "deployments") => void }) {
  const q = useAppTab<VercelProjectView>(app.id, "vercel");
  const v = q.data ?? null;
  const loading = q.loading && !v;
  const error = q.error ?? null;
  return (
    <div className="pd-stack">
      <VercelNote app={app} />
      <div className="pd-ov-pair">
        <ProductionCard v={v} loading={loading} error={error} onRetry={q.reload} now={now} />
        <ProjectCard app={app} v={v} loading={loading} error={error} onRetry={q.reload} />
      </div>
      <PreviewsCard app={app} now={now} onAll={() => onTab("deployments")} />
    </div>
  );
}

function servesText(d: VercelProjectView["domains"][number]): React.ReactNode {
  if (d.redirect) return <>Redirects to {d.redirect}{d.redirectStatusCode ? <span className="num"> ({d.redirectStatusCode})</span> : null}</>;
  if (d.gitBranch) return <>Branch <span className="pd-mono">{d.gitBranch}</span></>;
  return "Production";
}

export function VercelDomainsTab({ app }: { app: AppDetail }) {
  const q = useAppTab<VercelProjectView>(app.id, "vercel");
  const v = q.data;
  const list = v?.domains ?? [];
  return (
    <TabCard
      id="vx-dom-title"
      icon="globe"
      title="Domains"
      sub={v ? `${plural(list.length, "domain")} on the Vercel project ${v.name}. Add and change them on Vercel.` : "Domains on the Vercel project"}
      actions={v ? <OnVercel href={v.links.domains} /> : null}
    >
      {!v && q.loading ? (
        <SkelRows rows={3} height={56} template="minmax(0,1.4fr) 160px minmax(0,1fr)" cols={[{ w: "55%" }, 96, { w: "45%" }]} label="Reading Vercel" className="vx-skel" />
      ) : !v ? (
        <TabFailed error={q.error} onRetry={q.reload} what="Domains on Vercel" />
      ) : v.domainsError ? (
        <TabFailed error={v.domainsError} onRetry={q.reload} what="Domains on Vercel" />
      ) : !list.length ? (
        <Empty icon="globe" title="No domains on Vercel" body="This project only has its vercel.app address. Add a domain on Vercel and it shows here." />
      ) : (
        <div className="vx-list">
          <div className="vx-dom vx-head" aria-hidden="true">
            <span>Domain</span>
            <span>Status</span>
            <span>Serves</span>
          </div>
          <ul className="vx-rows" aria-label="Domains on Vercel">
            {list.map((d) => (
              <li key={d.name} className="vx-dom">
                <span className="vx-dom-name">{d.redirect ? <span className="pd-mono ellipsis">{d.name}</span> : <ExternalLink href={`https://${d.name}`} className="pd-mono">{d.name}</ExternalLink>}</span>
                <span>
                  <StatusChip tone={d.verified ? "ok" : "warn"} tip={d.verified ? undefined : "Vercel is waiting for the DNS record that proves you own it"}>
                    {d.verified ? "Verified" : "Not verified"}
                  </StatusChip>
                </span>
                <span className="vx-dom-serves">{servesText(d)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="vx-foot">
        Vercel serves this app, so its domains are added on Vercel, and the Domains page here does not take one for it.
      </p>
    </TabCard>
  );
}

function EnvRow({ e, values, now }: { e: VercelEnvVar; values: boolean; now: number }) {
  const shown = e.value !== null && e.value !== "";
  return (
    <li className="ev-var vx-env">
      <span className="ev-var-key">
        <span className="ev-var-keytext">{e.key}</span>
        {e.gitBranch ? (
          <Chip size="xs" icon={<Icon name="branch" size={12} />} tip="Only for this branch's previews">
            {e.gitBranch}
          </Chip>
        ) : null}
        {e.comment ? <span className="vx-env-comment">{e.comment}</span> : null}
      </span>
      <span className="ev-var-val">
        {shown ? (
          <>
            <span className="ellipsis" title={e.value!}>
              {e.value}
            </span>
            <CopyButton value={e.value!} what={`${e.key} value`} />
          </>
        ) : (
          <span className="vx-sealed">
            {e.type === "plain" && values ? null : <Icon name="lock" size={14} />}
            {valueNote(e, values)}
          </span>
        )}
      </span>
      <span className="vx-env-targets">
        {e.targets.length ? (
          e.targets.map((t) => (
            <span key={t} className="ev-target" data-target={t === "production" ? "build" : undefined}>
              {TARGET_LABEL[t]}
            </span>
          ))
        ) : (
          <span className="vx-muted">Custom</span>
        )}
      </span>
      <span className="ev-var-when num">{e.updatedAt ? <When iso={e.updatedAt} now={now} tipAlign="end" /> : null}</span>
    </li>
  );
}

export function VercelEnvTab({ app, now }: { app: AppDetail; now: number }) {
  const q = useAppTab<VercelEnvList>(app.id, "vercelEnv");
  const v = q.data;
  return (
    <TabCard
      id="vx-env-title"
      icon="key"
      title="Variables"
      sub="These live on Vercel for this app. Add and change them there; Dockify only reads them."
      actions={v ? <OnVercel href={v.manageUrl} /> : null}
    >
      {!v && q.loading ? (
        <div className="ev-vars-wrap">
          <SkelRows rows={4} height={44} template="minmax(0,1fr) minmax(0,1fr) 256px 96px" cols={[{ w: "60%" }, { w: "50%" }, 120, 56]} label="Reading Vercel" />
        </div>
      ) : !v ? (
        <TabFailed error={q.error} onRetry={q.reload} what="Variables on Vercel" />
      ) : !v.variables.length ? (
        <Empty icon="key" title="No variables on Vercel" body="This project has none yet. Add them on Vercel and they show here." />
      ) : (
        <div className="ev-vars-wrap">
          {!v.values ? <p className="vx-note-line">Keys only: values are for admins.</p> : null}
          <div className="ev-var ev-var-head vx-env" aria-hidden="true">
            <span>Key</span>
            <span>Value</span>
            <span>Environments</span>
            <span className="ev-var-when">Updated</span>
          </div>
          <ul className="ev-vars" aria-label="Variables on Vercel">
            {v.variables.map((e) => (
              <EnvRow key={e.id || `${e.key}:${e.targets.join()}`} e={e} values={v.values} now={now} />
            ))}
          </ul>
          {v.hiddenProductionCount ? <p className="vx-note-line">Vercel holds back {plural(v.hiddenProductionCount, "production variable")} from this token.</p> : null}
        </div>
      )}
    </TabCard>
  );
}
