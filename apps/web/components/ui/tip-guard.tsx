"use client";

import { useEffect } from "react";

// Tips are pure CSS, so they cannot see the viewport. Mounted once in the root layout, this slides a
// bubble back inside the rails (--tip-dx) or flips it below, and keeps native `title` tips to cut text.

const EDGE = 8;

type Box = { l: number; t: number; r: number; b: number };

function bubbleBox(el: HTMLElement): Box | null {
  const s = getComputedStyle(el, "::after");
  if (s.display === "none" || s.content === "none" || s.content === "normal") return null;
  // [data-tip] is position: relative, so the bubble's containing block is the trigger's padding box.
  const r = el.getBoundingClientRect();
  const es = getComputedStyle(el);
  const left0 = r.left + parseFloat(es.borderLeftWidth);
  const top0 = r.top + parseFloat(es.borderTopWidth);
  const w = parseFloat(s.width);
  const h = parseFloat(s.height);
  const tx = (s.translate === "none" ? "0px" : s.translate).split(" ")[0] ?? "0px";
  const dx = tx.endsWith("%") ? (parseFloat(tx) / 100) * w : parseFloat(tx);
  const l = left0 + parseFloat(s.left) + dx;
  const t = top0 + parseFloat(s.top);
  return { l, t, r: l + w, b: t + h };
}

/** The room a bubble may use: the viewport, the page's rails, and every clipping ancestor. */
function room(el: HTMLElement): Box {
  const box: Box = { l: EDGE, t: 0, r: document.documentElement.clientWidth - EDGE, b: window.innerHeight };
  // The block of main.page the tip sits in spans rail to rail; outside a page block, main itself.
  const column = el.closest("main.page > *") ?? el.closest("main");
  if (column) {
    const m = column.getBoundingClientRect();
    box.l = Math.max(box.l, m.left + EDGE);
    box.r = Math.min(box.r, m.right - EDGE);
  }
  const top = document.querySelector("header.top");
  if (top && !top.contains(el)) box.t = Math.max(box.t, top.getBoundingClientRect().bottom);
  for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
    const as = getComputedStyle(a);
    if (as.overflowX === "visible" && as.overflowY === "visible") continue;
    const ar = a.getBoundingClientRect();
    if (as.overflowX !== "visible") {
      box.l = Math.max(box.l, ar.left + 4);
      box.r = Math.min(box.r, ar.right - 4);
    }
    if (as.overflowY !== "visible") {
      box.t = Math.max(box.t, ar.top);
      box.b = Math.min(box.b, ar.bottom);
    }
  }
  return box;
}

/** Text that can be cut short (an ellipsis or a line clamp): null when it cannot, else whether it is cut now. */
function cutShort(host: HTMLElement): boolean | null {
  const s = getComputedStyle(host);
  if (s.textOverflow !== "ellipsis" && s.webkitLineClamp === "none") return null;
  return host.scrollWidth > host.clientWidth + 1 || host.scrollHeight > host.clientHeight + 1;
}

function place(el: HTMLElement) {
  el.style.removeProperty("--tip-dx");
  delete el.dataset.tipFlip;
  if (el.dataset.tipSide === "right") return;
  const bub = bubbleBox(el);
  if (!bub) return;
  const area = room(el);
  // Open below when the top has no room and the bottom has.
  if (el.dataset.tipSide !== "bottom" && bub.t < area.t) {
    const r = el.getBoundingClientRect();
    const below = r.bottom + 9 + (bub.b - bub.t);
    if (below <= area.b) el.dataset.tipFlip = "bottom";
  }
  let shift = 0;
  if (bub.r - bub.l > area.r - area.l) shift = area.l - bub.l;
  else if (bub.l < area.l) shift = area.l - bub.l;
  else if (bub.r > area.r) shift = area.r - bub.r;
  if (Math.abs(shift) >= 0.5) el.style.setProperty("--tip-dx", `${Math.round(shift)}px`);
}

export function TipGuard() {
  useEffect(() => {
    let active: HTMLElement | null = null;
    // A tip that changes its text while shown (Copy, then Copied) is measured again.
    const watch = new MutationObserver(() => active && place(active));
    const enter = (e: Event) => {
      const el = (e.target as Element | null)?.closest?.<HTMLElement>("[data-tip]");
      if (!el || el === active) return;
      if (active) delete active.dataset.tipHidden;
      active = el;
      watch.disconnect();
      watch.observe(el, { attributes: true, attributeFilter: ["data-tip", "data-tip-side", "data-tip-align"] });
      place(el);
    };
    const leave = (e: Event) => {
      const to = (e as MouseEvent | FocusEvent).relatedTarget as Node | null;
      if (active && (!to || !active.contains(to))) {
        watch.disconnect();
        delete active.dataset.tipHidden;
        active = null;
      }
    };
    // Esc dismisses the tip on screen; the key is not used up, so it still closes a dialog.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !active || "tipHidden" in active.dataset) return;
      if (getComputedStyle(active, "::after").opacity === "0") return;
      active.dataset.tipHidden = "";
    };
    // Native titles: one over text that fits steps aside while the pointer is on it; a cut ellipsis
    // with no tip of its own shows its full text.
    let titled: HTMLElement | null = null;
    const titleOver = (e: Event) => {
      const el = (e.target as Element | null)?.closest?.<HTMLElement>("[title], .ellipsis");
      if (!el || el === titled) return;
      const cut = cutShort(el);
      if (el.hasAttribute("title")) {
        if (cut !== false) return;
        el.dataset.title = el.title;
        el.removeAttribute("title");
      } else {
        const text = el.textContent?.trim();
        if (!cut || !text || el.closest("[data-tip]")) return;
        el.title = text;
        el.dataset.autoTitle = "";
      }
      titled = el;
    };
    const titleOut = (e: Event) => {
      const to = (e as MouseEvent).relatedTarget as Node | null;
      if (!titled || (to && titled.contains(to))) return;
      if (titled.dataset.title !== undefined) titled.title = titled.dataset.title;
      else if (titled.dataset.autoTitle !== undefined) titled.removeAttribute("title");
      delete titled.dataset.title;
      delete titled.dataset.autoTitle;
      titled = null;
    };
    document.addEventListener("pointerover", enter, true);
    document.addEventListener("pointerover", titleOver, true);
    document.addEventListener("focusin", enter, true);
    document.addEventListener("pointerout", leave, true);
    document.addEventListener("pointerout", titleOut, true);
    document.addEventListener("focusout", leave, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      watch.disconnect();
      document.removeEventListener("pointerover", enter, true);
      document.removeEventListener("pointerover", titleOver, true);
      document.removeEventListener("focusin", enter, true);
      document.removeEventListener("pointerout", leave, true);
      document.removeEventListener("pointerout", titleOut, true);
      document.removeEventListener("focusout", leave, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, []);
  return null;
}
