"use client";

import Link from "next/link";
import { AppIcon, ProjectIcon } from "@/components/icons/app-icon";
import { KIND_LABEL } from "@/components/project-detail/shared";
import { Chip, StatusChip } from "@/components/ui/chip";
import { Node } from "@/components/ui/rule";
import { deployMessage } from "@/lib/deploy-source";
import { APP_STATUS_LABEL, type ProjectCard as ProjectSummary } from "@/lib/derive";
import { DeployDot, DeployRefs, DeployTime, Envs, ProjectCard } from "./project-card";

/* The projects list in its two layouts: ruled cards in a grid, or ruled rows. Up and Down move
   between projects in either. */

/** Up and Down step between the rows' main links; Enter opens one, as any link does. */
function stepRows(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const links = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-row-link]")];
  const at = links.indexOf(e.target as HTMLElement);
  if (at < 0) return;
  e.preventDefault();
  links[Math.min(links.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
}

export function ProjectRows({ projects, now }: { projects: ProjectSummary[]; now: number }) {
  return (
    <section className="pj-rows" aria-label="Projects" onKeyDown={stepRows}>
      {projects.map((p, i) => (
        <div key={p.slug} className="pj-row reveal" style={{ animationDelay: `${i * 30}ms` }}>
          <Node pos="tl" />
          <Node pos="tr" />
          <span aria-hidden="true" className="node pj-row-node" />
          {/* The last row's divider meets the band below on a node too. */}
          {i === projects.length - 1 ? <span aria-hidden="true" className="node pj-row-node pj-row-node-end" /> : null}
          {/* The same names as the grid ("Production", not "Prod"), and the state in the lead, apart from the app chips. */}
          <Link href={`/projects/${p.slug}`} className="pj-row-lead" data-row-link>
            <ProjectIcon slug={p.slug} size="md" />
            <span className="pj-row-id">
              <span className="two">
                <h2 className="two-main pj-name ellipsis" title={p.name}>
                  {p.name}
                </h2>
                <Envs envs={p.environments} apps={p.apps.length} />
              </span>
              <StatusChip tone={p.tone} className="pj-status">
                {p.stateLabel}
              </StatusChip>
            </span>
          </Link>
          <div className="pj-row-main">
            <ul className="pj-chips">
              {p.apps.map((a) => (
                <li key={a.id}>
                  <Chip size="sm" href={`/apps/${a.id}`} icon={<AppIcon id={a.id} kind={a.kind} />} tip={`${KIND_LABEL[a.kind]}, ${APP_STATUS_LABEL[a.status].toLowerCase()}`}>
                    {a.name}
                  </Chip>
                </li>
              ))}
            </ul>
            {p.last ? (
              <p className="pj-row-last">
                <DeployDot d={p.last} />
                <span className="pj-row-msg ellipsis" title={p.last.image ?? deployMessage(p.last)}>
                  {deployMessage(p.last)}
                </span>
                <DeployRefs d={p.last} withApp />
                <span className="pj-row-time">
                  <DeployTime d={p.last} now={now} />
                </span>
              </p>
            ) : (
              <p className="pj-none">No deployments yet</p>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

export function ProjectGrid({ projects, now }: { projects: ProjectSummary[]; now: number }) {
  return (
    <section className="pj-grid" aria-label="Projects" onKeyDown={stepRows}>
      {projects.map((p, i) => (
        <ProjectCard key={p.slug} p={p} now={now} variant="grid" delay={i * 50} />
      ))}
    </section>
  );
}
