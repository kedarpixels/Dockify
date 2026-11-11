"use client";

import { useEffect } from "react";
import { THEME_KEY } from "@/lib/theme";

// Until a choice is stored, the page follows prefers-color-scheme live. A choice made in another
// tab repaints this one too.

const media = () => window.matchMedia("(prefers-color-scheme: dark)");

/** The stored choice, or null when none is stored (or storage is blocked). */
function storedDark(): boolean | null {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "dark" ? true : t === "light" ? false : null;
  } catch {
    return null;
  }
}

/* Same no-flash swap as the theme switch: freeze transitions for two frames while classes flip. */
function paint(dark: boolean) {
  const root = document.documentElement;
  if (root.classList.contains("dark") === dark) return;
  root.classList.add("theme-switching");
  root.classList.toggle("dark", dark);
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
}

/* Mounted once by the shell. */
export function useFollowSystemTheme() {
  useEffect(() => {
    const mq = media();
    const onSystem = () => storedDark() === null && paint(mq.matches);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_KEY && e.key !== null) return;
      paint(storedDark() ?? mq.matches);
    };
    mq.addEventListener("change", onSystem);
    window.addEventListener("storage", onStorage);
    return () => {
      mq.removeEventListener("change", onSystem);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
}
