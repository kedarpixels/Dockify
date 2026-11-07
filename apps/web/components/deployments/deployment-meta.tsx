import Link from "next/link";
import { AppIcon, ProjectIcon } from "@/components/icons/app-icon";
import { ActorAvatar } from "@/components/ui/actor-avatar";
import { EnvTag } from "@/components/ui/env-tag";
import { BranchRef } from "@/components/ui/git-ref";
import { HashChip } from "@/components/ui/hash-chip";
import { Corners } from "@/components/ui/rule";
import { When } from "@/components/ui/when";
import { deployPeople, deploySource, shortImage, type DeployPerson } from "@/lib/deploy-source";
import { IN_FLIGHT } from "@/lib/derive";
import { appTitle, clock, duration } from "@/lib/format";
import { githubRepo } from "@/lib/git-links";
import type { DeploymentDetail } from "@/lib/pages/deployments";
import { triggerLabel } from "./actions";
import { secondsBetween } from "./deployment-steps";
import { hostOfUrl } from "./vercel-links";

/** How Vercel says a deployment started, in words. Anything newer reads as Vercel wrote it. */
const SOURCE_LABEL: Record<string, string> = {
  git: "Git push",
  "git-deploy-hook": "Git deploy hook",
  cli: "Vercel CLI",
  redeploy: "Redeploy on Vercel",
  "api-trigger-git-deploy": "Vercel API",
  import: "Import on Vercel",
};

/**
 * The ruled facts grid in the Details card, a node on every cell corner as on every ruled grid. The
 * start time reads like every other time: relative, the absolute moment in its tip.
 */
export function DeploymentMeta({ d, now, multiEnv }: { d: DeploymentDetail; now: number; multiEnv: boolean }) {
  const live = IN_FLIGHT.includes(d.status);
  const wall = secondsBetween(d.createdAt, d.finishedAt ?? now);
  const repo = githubRepo(d.repo);
  const source = deploySource(d);
  // In full on the page rather than in a tip: "acme-labs" and "Sam", "API token ci", or
  // "Dockify" for nobody.
  const { main, deployedBy } = deployPeople(d);
  const person = (p: DeployPerson, note?: string) => (
    <span className="dpd-meta-ic">
      <ActorAvatar kind={p.person?.kind ?? "system"} url={p.person?.avatarUrl} name={p.person?.name} />
      <span className="ellipsis" title={p.text}>
        {p.text}
      </span>
      {note ? <span className="dpd-meta-note">{note}</span> : null}
    </span>
  );
  const cells: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: "Project",
      value: (
        <Link href={`/projects/${d.projectSlug}`} className="dpd-meta-link">
          <ProjectIcon slug={d.projectSlug} />
          <span className="ellipsis" title={d.projectSlug}>
            {d.projectSlug}
          </span>
        </Link>
      ),
    },
    {
      label: "App",
      value: (
        <Link href={`/apps/${d.appId}`} className="dpd-meta-link">
          <AppIcon id={d.appId} kind={d.app.kind} />
          <span className="ellipsis" title={appTitle(d.app)}>
            {appTitle(d.app)}
          </span>
        </Link>
      ),
    },
    // A project that shows no environments gets when it ended in that cell, so the grid stays full.
    multiEnv
      ? { label: "Environment", value: <EnvTag env={d.environment} /> }
      : {
          label: "Finished",
          value: d.finishedAt ? (
            <span className="num">
              <When iso={d.finishedAt} now={now} />
            </span>
          ) : (
            <span className="none">Not yet</span>
          ),
        },
    // A deployment with no commit has no branch or hash to give: what ran takes both cells.
    ...(source
      ? [
          // An image app's source is its image, named once, in the next cell.
          { label: "Source", value: d.image && shortImage(d.image) === source ? "Container image" : source },
          {
            label: "Image",
            value: d.image ? (
              <span className="ellipsis num" title={d.image}>
                {shortImage(d.image)}
              </span>
            ) : (
              <span className="none-mark">None</span>
            ),
          },
        ]
      : [
          { label: "Branch", value: <BranchRef repo={repo} branch={d.branch} className="dpd-meta-ic" /> },
          // The head's View on GitHub key opens the commit, so the chip here has the other job: copying it.
          { label: "Commit", value: <HashChip hash={d.commit} repo={repo} action="copy" /> },
        ]),
    deployedBy ? { label: deployedBy.label, value: person(deployedBy, triggerLabel(d.trigger)) } : { label: "Trigger", value: triggerLabel(d.trigger) },
    {
      label: "Started",
      value: (
        <span className="num">
          <When iso={d.createdAt} now={now} />
        </span>
      ),
    },
    {
      label: "Duration",
      value: d.status === "queued" ? <span className="tone-pending">Waiting</span> : <span className={`num${live ? " tone-live" : ""}`}>{live ? clock(wall) : duration(wall)}</span>,
    },
    { label: main.label, value: person(main) },
  ];
  if (d.external) {
    const v = d.external;
    cells.push(
      { label: "Vercel target", value: v.target === "production" ? "Production" : v.target === "preview" ? "Preview" : "Unknown" },
      {
        label: "Address",
        value: v.url ? (
          <a href={v.url} target="_blank" rel="noopener noreferrer" className="dpd-meta-link">
            <span className="ellipsis" title={v.url}>
              {hostOfUrl(v.url)}
            </span>
          </a>
        ) : (
          <span className="none">Not yet</span>
        ),
      },
      { label: "Started with", value: SOURCE_LABEL[v.source ?? ""] ?? v.source ?? "Unknown" },
    );
  }
  return (
    <dl className="dpd-meta" aria-label="Deployment details">
      {cells.map((c) => (
        <div key={c.label} className="kv dpd-meta-cell">
          <dt className="kv-label">{c.label}</dt>
          <dd className="kv-value dpd-meta-value">
            {c.value}
            {/* Inside the value, since a dl group holds only dt and dd; the cell is their box. */}
            <Corners />
          </dd>
        </div>
      ))}
    </dl>
  );
}
