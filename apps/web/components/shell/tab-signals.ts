"use client";

import { useEffect } from "react";

/*
 * The browser tab mirrors the console, so a background tab still says what is going on:
 * - the title gains a count while builds are in flight, "(2) Deployments | Dockify";
 * - the favicon gains a red dot while a problem in the bell is unread, drawn on a canvas over
 *   /icon.png, and goes back to the plain icon once it is read or has cleared. Like the bell's own
 *   dot, it asks for attention once; the project dots in the sidebar keep showing the live state.
 */

const COUNT = /^\(\d+\)\s/;

/** Keeps the "(n) " prefix on document.title, including after Next swaps the title on navigation. */
function useTitleCount(count: number) {
  useEffect(() => {
    const apply = () => {
      const base = document.title.replace(COUNT, "");
      const next = count > 0 ? `(${count.toLocaleString("en-US")}) ${base}` : base;
      if (document.title !== next) document.title = next;
    };
    apply();
    // Next replaces the <title> element or its text when the route changes.
    const mo = new MutationObserver(apply);
    mo.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      mo.disconnect();
      document.title = document.title.replace(COUNT, "");
    };
  }, [count]);
}

/** Swaps every icon link to a badged copy while `alert` holds, restoring the originals after. */
export function useFaviconDot(alert: boolean) {
  useEffect(() => {
    if (!alert) return;
    const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')];
    if (!links.length) return;
    const originals = links.map((l) => l.href);
    let cancelled = false;

    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const size = 64;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, size, size);
      // Punch a clear ring first, so the dot reads on any icon colour, then draw the dot.
      const cx = size - 15;
      const cy = size - 15;
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.arc(cx, cy, 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--bad").trim() || "red";
      ctx.beginPath();
      ctx.arc(cx, cy, 11, 0, Math.PI * 2);
      ctx.fill();
      let url: string;
      try {
        url = canvas.toDataURL("image/png");
      } catch {
        return; // a tainted canvas keeps the plain icon
      }
      links.forEach((l) => (l.href = url));
    };
    img.src = originals[0]!;

    return () => {
      cancelled = true;
      links.forEach((l, i) => (l.href = originals[i]!));
    };
  }, [alert]);
}

export function useTabSignals(inFlight: number) {
  useTitleCount(inFlight);
}
