"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { cx } from "./cx";

/*
 * The one copy control. Copies never toast: the key itself says Copied for a moment, and one shared
 * polite region tells screen readers ("Copied", "Copy failed") while the key keeps its name.
 *
 *   <CopyButton value={url} what="connection URL" />            icon key, no hover tip, "Copied" after a press
 *   <CopyTextButton value={url} label="Copy link" />            labelled secondary button
 *   const { state, copy } = useCopy();  await copy(text);        anything else (hash chips, log lines)
 */

/* One region for every copy result. It is put in the page when the first copy key mounts, so the
   first result lands in a region the reader already watches (one created with its text is often
   skipped). */
let region: HTMLElement | null = null;

function copyRegion(): HTMLElement {
  if (region?.isConnected) return region;
  region = document.createElement("div");
  region.className = "sr";
  region.setAttribute("role", "status");
  document.body.append(region);
  return region;
}

/** Says a copy result to screen readers; the same words twice in a row are still said. */
function announce(text: string) {
  const r = copyRegion();
  r.textContent = "";
  requestAnimationFrame(() => {
    r.textContent = text;
  });
}

/**
 * Puts text on the clipboard. The async API needs a secure context, so a dashboard reached over
 * plain http (a fresh VPS by its IP) falls back to a hidden textarea and execCommand. Focus and the
 * page selection are put back afterwards. Resolves false when both ways fail.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) throw new Error("No async clipboard");
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    focused?.focus({ preventScroll: true });
    return ok;
  }
}

export type CopyState = "idle" | "done" | "failed";

/**
 * Copy with a short-lived result: `state` is "done" or "failed" for `ms` after each copy, then
 * "idle" again. A repeat copy restarts the timer; the timer is cleared on unmount. `copy` takes the
 * text, or an async getter for a value fetched on demand (a secret revealed by the API).
 */
export function useCopy(ms = 1400) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    copyRegion();
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const copy = async (source: string | (() => Promise<string>)) => {
    let ok = false;
    try {
      ok = await copyText(typeof source === "string" ? source : await source());
    } catch {
      ok = false;
    }
    // A copy that settles after unmount (a slow fetched value) must not start a timer nobody clears.
    if (!alive.current) return ok;
    announce(ok ? "Copied" : "Copy failed");
    setState(ok ? "done" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), ms);
    return ok;
  };

  return { state, copy };
}

/**
 * Icon-only copy key. No hover tip (the glyph says copy); after a press the tip says "Copied" (or
 * "Copy failed") and stays up for the moment even after the pointer leaves, so a keyboard copy is
 * confirmed too, and on touch screens too. `what` names the value for screen readers, "Copy
 * connection URL", and the name stays put: the result is said through the shared region.
 */
export function CopyButton({
  value,
  what,
  size = "xs",
  align,
  side,
  className,
  disabled,
}: {
  value: string | (() => Promise<string>);
  what: string;
  /** "xs" 28px in rows, "sm" 32px in card heads, "md" 36px beside 36px toolbar keys. */
  size?: "xs" | "sm" | "md";
  align?: "end";
  side?: "bottom";
  className?: string;
  /** Nothing to copy yet, such as an empty log. */
  disabled?: boolean;
}) {
  const { state, copy } = useCopy();
  const tip = state === "done" ? "Copied" : state === "failed" ? "Copy failed" : undefined;
  return (
    <button
      type="button"
      className={cx("btn btn-icon copy-key", size !== "md" && `btn-${size}`, className)}
      aria-label={`Copy ${what}`}
      data-tip={tip}
      data-tip-align={align}
      data-tip-side={side}
      data-copied={state !== "idle" || undefined}
      disabled={disabled}
      onClick={(e) => {
        // The row around the key may be a link or a toggle.
        e.preventDefault();
        e.stopPropagation();
        void copy(value);
      }}
    >
      <Icon name={state === "done" ? "check" : "copy"} />
    </button>
  );
}

/**
 * Labelled secondary copy button ("Copy link"). The label reads "Copied" for a moment; both labels
 * share one grid cell, so the button keeps the width of the longer one and never jumps.
 */
export function CopyTextButton({
  value,
  label,
  size,
  className,
}: {
  value: string | (() => Promise<string>);
  label: string;
  size?: "sm" | "xs";
  className?: string;
}) {
  const { state, copy } = useCopy();
  const shown = state === "done" ? "Copied" : state === "failed" ? "Copy failed" : label;
  // The rare failure text joins the cell only while it shows, so it never pads the usual width.
  const cells = [...new Set([label, "Copied", ...(state === "failed" ? ["Copy failed"] : [])])];
  return (
    <button type="button" className={cx("btn", size && `btn-${size}`, className)} onClick={() => void copy(value)}>
      <span className="swap">
        {cells.map((t) => (
          <span key={t} data-on={t === shown || undefined}>
            {t}
          </span>
        ))}
      </span>
    </button>
  );
}
