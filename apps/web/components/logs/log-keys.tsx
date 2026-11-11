"use client";

import { Icon } from "@/components/icon";
import { CopyButton } from "@/components/ui/copy-button";

/** Copy and download wait for a line. */
export function LogKeys({ wrap, onWrap, allText, empty, download }: { wrap: boolean; onWrap: () => void; allText: () => Promise<string>; empty: boolean; download: () => void }) {
  return (
    <>
      <button type="button" className="btn btn-icon" aria-pressed={wrap} aria-label="Wrap lines" data-tip={wrap ? "Wrapping lines" : "Wrap lines"} onClick={onWrap}>
        <Icon name="wrap" />
      </button>
      <CopyButton size="md" what="all lines" value={allText} disabled={empty} />
      <button type="button" className="btn btn-lead" disabled={empty} onClick={download}>
        <Icon name="download" />
        Download
      </button>
    </>
  );
}
