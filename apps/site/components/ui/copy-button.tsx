"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { cx } from "./cx";

// Copies never toast: the key itself says Copied for a moment, and one shared polite region tells
// screen readers while the key keeps its name.

// One region for every result, added when the first copy key mounts: a region created together
// with its text is often skipped by screen readers.
let region: HTMLElement | null = null;

function copyRegion(): HTMLElement {
  if (region?.isConnected) return region;
  region = document.createElement("div");
  region.className = "sr";
  region.setAttribute("role", "status");
  document.body.append(region);
  return region;
}

/** The same words twice in a row are still said. */
function announce(text: string) {
  const r = copyRegion();
  r.textContent = "";
  requestAnimationFrame(() => {
    r.textContent = text;
  });
}

// The async API needs a secure context, so plain http (a fresh VPS by its IP) falls back to a
// hidden textarea and execCommand. Resolves false when both ways fail.
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

/** `copy` takes the text, or an async getter for a value fetched on demand (a secret revealed by the API). */
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

// After a press the tip says "Copied" and stays even after the pointer leaves, so keyboard and
// touch copies are confirmed too. The accessible name stays put; the result goes to the shared region.
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

/** Both labels share one grid cell, so the button keeps the width of the longer one and never jumps. */
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
