"use client";

import { commitHref, type GitHubRepo } from "@/lib/git-links";
import { useCopy } from "./copy-button";

/**
 * Short commit hash in a soft chip, with one job. By default it opens the commit on GitHub when
 * the repository is known and copies the full hash otherwise. In a row whose commit message
 * already links to GitHub, pass `action="copy"` so the two never do the same thing. A deploy with
 * no commit reads a muted "None". No hover tip either way (the chip is the hash); a copy says Copied
 * for a moment, as CopyButton does.
 *
 *   <HashChip hash={d.commit} repo={repo} />                 the only commit link on the page
 *   <HashChip hash={d.commit} repo={repo} action="copy" />   beside a message that links out
 */
export function HashChip({
  hash,
  repo = null,
  tipAlign,
  action = "auto",
}: {
  hash: string | null;
  repo?: GitHubRepo | null;
  tipAlign?: "end";
  /** "auto" links to GitHub when it can, else copies; "copy" always copies. */
  action?: "auto" | "copy";
}) {
  const { state, copy } = useCopy();
  if (!hash) return <span className="hash-chip" data-empty="true">None</span>;

  const href = action === "copy" ? null : commitHref(repo, hash);
  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="hash-chip num" aria-label={`View commit ${hash.slice(0, 7)} on GitHub`}>
        {hash.slice(0, 7)}
      </a>
    );
  }

  const tip = state === "done" ? "Copied" : state === "failed" ? "Copy failed" : undefined;
  return (
    <button
      type="button"
      className="hash-chip copy-key num"
      data-tip={tip}
      data-tip-align={tipAlign}
      data-copied={state !== "idle" || undefined}
      aria-label={`Copy commit ${hash}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void copy(hash);
      }}
    >
      {hash.slice(0, 7)}
    </button>
  );
}
