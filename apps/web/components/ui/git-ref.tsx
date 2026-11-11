import type { ReactNode } from "react";
import { Icon, type IconSize } from "@/components/icon";
import { branchHref, githubRepo, repoHref, repoLabel, type GitHubRepo } from "@/lib/git-links";
import { cx } from "./cx";

/* Without a safe URL they render as plain text. They sit above a row's stretched link, so a click opens GitHub only. */

export function GitLink({ href, className, children }: { href: string | null; className?: string; children: ReactNode }) {
  if (!href) return <span className={className}>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cx("git-ref", className)}>
      {children}
    </a>
  );
}

export function BranchRef({ repo, branch, className, iconSize }: { repo: GitHubRepo | null; branch: string | null; className?: string; iconSize?: IconSize }) {
  return (
    <GitLink href={branchHref(repo, branch)} className={cx("git-branch", className)}>
      <Icon name="branch" size={iconSize} />
      {branch ? (
        <span className="ellipsis" title={branch}>
          {branch}
        </span>
      ) : (
        <span className="none-mark">None</span>
      )}
    </GitLink>
  );
}

export function RepoRef({ source, label, className, icon }: { source: string; label?: string; className?: string; icon?: ReactNode }) {
  const repo = githubRepo(source);
  return (
    <GitLink href={repoHref(repo)} className={className}>
      {icon}
      <span className="ellipsis">{label ?? (repo ? repoLabel(repo) : source)}</span>
    </GitLink>
  );
}
