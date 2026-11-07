"use client";

import { Icon } from "@/components/icon";
import { Chip } from "@/components/ui/chip";
import { IconTile } from "@/components/ui/icon-tile";
import { SkelRows } from "@/components/ui/skeleton";
import { When } from "@/components/ui/when";
import type { GitRepo } from "@/lib/pages/git";

/** The row grid, shared with the skeleton so nothing moves when the list lands. */
const TEMPLATE = "32px minmax(0,1fr) 96px 72px";

/**
 * One repository in the import list, 52px: a GitHub or lock tile, owner/name over the push time
 * (the full moment on hover), the framework or language, and Import. `active` is the row the
 * arrow keys reached in the search field; Enter there imports it.
 */
export function RepoRow({
  repo,
  now,
  active,
  onImport,
  onPoint,
}: {
  repo: GitRepo;
  now: number;
  active: boolean;
  onImport: () => void;
  onPoint: () => void;
}) {
  const tag = repo.framework || repo.language;
  return (
    <li className="git-row" data-active={active || undefined} onPointerMove={onPoint}>
      <IconTile size="md">
        <Icon name={repo.private ? "lock" : "github"} />
      </IconTile>
      <span className="two">
        <span className="two-main git-row-name" title={repo.fullName}>
          <span className="git-row-owner">{repo.owner}/</span>
          {repo.name}
        </span>
        <span className="two-sub">
          {repo.private ? "Private" : "Public"}, <When iso={repo.pushedAt} now={now} prefix="pushed" />
        </span>
      </span>
      <span className="git-row-tag">{tag ? <Chip size="xs">{tag}</Chip> : null}</span>
      <button type="button" className="btn btn-sm" onClick={onImport} aria-label={`Import ${repo.fullName}`}>
        Import
      </button>
    </li>
  );
}

/** Placeholder rows in the exact row geometry. */
export function RepoSkeleton({ rows = 5 }: { rows?: number }) {
  return <SkelRows rows={rows} height={52} template={TEMPLATE} cols={[24, { w: "50%", lines: 2 }, 64, 72]} label="Loading repositories" className="git-skel" />;
}
