"use client";

import { Icon } from "@/components/icon";
import { Field, TextInput } from "@/components/ui/field";
import { IconTile } from "@/components/ui/icon-tile";
import { githubRepo, repoHref } from "@/lib/git-links";
import type { GitInstallation, GitRepo } from "@/lib/pages/git";
import { isSshRepoUrl, parseRepo, type ParsedRepo } from "./parse";

/** What a new app builds from: a repository the GitHub App can read, or a public URL. */
export type Picked = { kind: "git"; installation: GitInstallation; repo: GitRepo } | { kind: "url"; parsed: ParsedRepo };

export const fullName = (p: Picked) => (p.kind === "git" ? p.repo.fullName : `${p.parsed.owner}/${p.parsed.repo}`);

/** The name links to the repository on GitHub; any other host shows it as text. */
export function PickedRepo({ picked, onChange, disabled }: { picked: Picked; onChange: () => void; disabled?: boolean }) {
  const name = fullName(picked);
  const locked = picked.kind === "git" && picked.repo.private;
  const href = repoHref(githubRepo(picked.kind === "git" ? `https://github.com/${name}` : picked.parsed.url));
  return (
    <div className="git-picked">
      <IconTile size="md">
        <Icon name={locked ? "lock" : "github"} />
      </IconTile>
      <span className="two">
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className="git-ref two-main git-picked-name">
            {name}
          </a>
        ) : (
          <span className="two-main git-picked-name">{name}</span>
        )}
        <span className="two-sub">
          {picked.kind === "git"
            ? `${picked.repo.private ? "Private" : "Public"}, from ${picked.installation.account.login}`
            : `${picked.parsed.host}, public URL`}
        </span>
      </span>
      <button type="button" className="git-link" onClick={onChange} disabled={disabled}>
        Change
      </button>
    </div>
  );
}

const SSH_MESSAGE = "Dockify clones over HTTPS. Use a URL like https://github.com/owner/repo";

/** The flow owns the URL and its Continue, which sits in the footer; Enter here is the same Continue. */
export function UrlImport({
  value: url,
  tried,
  onChange,
  onSubmit,
  onBack,
}: {
  value: string;
  /** Continue was pressed, so an empty or unreadable URL says why. */
  tried: boolean;
  onChange: (url: string) => void;
  onSubmit: () => void;
  onBack: () => void;
}) {
  const parsed = parseRepo(url);
  const ssh = isSshRepoUrl(url);
  const error = !tried ? null : !url.trim() ? "Enter the repository URL" : ssh ? SSH_MESSAGE : !parsed ? "Use a URL like https://github.com/owner/repo" : null;

  const hint = !url.trim() ? (
    "An HTTPS URL. Private repositories need the Dockify GitHub App."
  ) : parsed ? (
    <span className="git-valid" aria-live="polite">
      <Icon name="checkCircle" size={14} />
      {parsed.host}, {parsed.owner}/{parsed.repo}
    </span>
  ) : (
    <span aria-live="polite">{ssh ? SSH_MESSAGE : "Not a repository URL yet, for example https://github.com/owner/repo"}</span>
  );

  return (
    <div className="git-url">
      <Field label="Repository URL" error={error} hint={hint}>
        {(ids) => (
          <TextInput
            ids={ids}
            data-autofocus
            autoFocus
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://github.com/owner/repo"
            value={url}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              // Never the surrounding form's submit: step 2 is not open yet.
              if (e.key !== "Enter") return;
              e.preventDefault();
              onSubmit();
            }}
          />
        )}
      </Field>
      <p className="git-pick-foot">
        <button type="button" className="git-link" onClick={onBack}>
          Pick from GitHub instead
        </button>
      </p>
    </div>
  );
}
