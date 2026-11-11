"use client";

import { commitHref, type GitHubRepo } from "@/lib/git-links";
import { useCopy } from "./copy-button";

// Opens the commit on GitHub when the repository is known, else copies the full hash. Beside a
// message that already links to GitHub, pass `action="copy"` so the two never do the same thing.
export function HashChip({
  hash,
  repo = null,
  tipAlign,
  action = "auto",
}: {
  hash: string | null;
  repo?: GitHubRepo | null;
  tipAlign?: "end";
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
