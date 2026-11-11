"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Icon } from "@/components/icon";
import { THEME_KEY } from "@/lib/theme";
import { cx } from "./cx";
import { ownsKeys, singleKeyShortcutsOn, useSingleKeyShortcuts } from "./shortcuts";

/* While the palette swaps, `html.theme-switching` freezes every transition and animation so
   nothing fades its colour in on its own (that per-element fade is the flash). */
function applyTheme(dark: boolean) {
  const root = document.documentElement;
  root.classList.add("theme-switching");
  root.classList.toggle("dark", dark);
  try {
    localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
  } catch {
    /* storage blocked: the theme still applies for this visit */
  }
}

function release() {
  requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove("theme-switching")));
}

/** Flip the theme instantly. Every theme control calls this. */
function toggleTheme() {
  const toDark = !document.documentElement.classList.contains("dark");
  applyTheme(toDark);
  release();
}

/* D toggles from anywhere except where the key is someone's input (fields, a listbox's type-ahead,
   menus, grids: see ownsKeys), and not at all once single-key shortcuts are off. One listener
   however many switches are mounted. */
let listeners = 0;
function onKey(e: KeyboardEvent) {
  if (e.key !== "d" && e.key !== "D") return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.defaultPrevented) return;
  if (!singleKeyShortcutsOn() || ownsKeys(e.target)) return;
  e.preventDefault();
  toggleTheme();
}

const subscribeTheme = (onChange: () => void) => {
  const watch = new MutationObserver(onChange);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => watch.disconnect();
};

/**
 * Theme switch: a square knob on a slim 52 by 28 track, role="switch".
 * Position reads html.dark, so it is right before hydration. Mounting one also arms the D key.
 * `tipAlign="end"` lines the tooltip's right edge up with the switch, for a switch at a column edge.
 */
export function ThemeSwitch({
  className,
  tipSide = "bottom",
  tipAlign = "center",
}: {
  className?: string;
  tipSide?: "top" | "bottom";
  tipAlign?: "center" | "end";
}) {
  const dark = useSyncExternalStore(
    subscribeTheme,
    () => document.documentElement.classList.contains("dark"),
    () => false,
  );
  const [shortcuts] = useSingleKeyShortcuts();

  useEffect(() => {
    if (listeners++ === 0) window.addEventListener("keydown", onKey);
    return () => {
      if (--listeners === 0) window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label="Dark theme"
      aria-keyshortcuts={shortcuts ? "D" : undefined}
      data-side={tipSide}
      data-align={tipAlign}
      onClick={toggleTheme}
      className={cx("tswitch", className)}
      suppressHydrationWarning
    >
      <span aria-hidden="true" className="tswitch-knob">
        <span className="tswitch-sun">
          <Icon name="sun" size={14} />
        </span>
        <span className="tswitch-moon">
          <Icon name="moon" size={14} />
        </span>
      </span>
      <span aria-hidden="true" className="tswitch-tip">
        Toggle theme{shortcuts ? <kbd>D</kbd> : null}
      </span>
    </button>
  );
}
