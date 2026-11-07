"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useInView, useReducedMotion } from "./motion";

/* A tiny timeline engine for the line illustrations. A scene is a pure function of time that
   returns, per element key, a translate, a scale and an opacity (plus a few text values). One
   requestAnimationFrame loop applies it while the scene is on screen, touching transform and
   opacity only. Server render and first paint use frame(0); under reduced motion the scene holds
   frame(still). */

export type Pt = [number, number];
/** x, y, width and height. */
export type Box = [number, number, number, number];
export type St = { x?: number; y?: number; s?: number; sx?: number; o?: number };
export type Frame = { st: Record<string, St>; tx?: Record<string, string> };

export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const inOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
/** Eased progress of t through [a, b]: 0 before, 1 after. */
export const p = (t: number, a: number, b: number) => inOut(clamp((t - a) / (b - a)));
/** Linear progress of t through [a, b]. */
export const lin = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
export const mix = (a: number, b: number, u: number) => a + (b - a) * u;
/** Fades in over [a, a + f] and out over [b, b + f]. */
export const win = (t: number, a: number, b: number, f = 250) => p(t, a, a + f) * (1 - p(t, b, b + f));
/** A horizontal scale that never reaches 0, which would make the matrix singular. */
export const grow = (u: number) => Math.max(0.0001, u);

/** The length of a polyline. */
export const lengthOf = (pts: Pt[]) => pts.slice(1).reduce((n, q, k) => n + Math.hypot(q[0] - pts[k]![0], q[1] - pts[k]![1]), 0);

/** A point at distance d along a polyline. */
export function along(pts: Pt[], d: number): Pt {
  let left = d;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (left <= len) {
      const u = len ? left / len : 0;
      return [x0 + (x1 - x0) * u, y0 + (y1 - y0) * u];
    }
    left -= len;
  }
  return pts[pts.length - 1]!;
}

const RESET = 800;
const pct = (s: string | undefined) => (s && /^\d+%$/.test(s) ? Number(s.slice(0, -1)) : null);

/**
 * Wraps a story into a loop of length T. The story holds its last frame until T - RESET; then
 * every animated key glides back to its frame(0) state so the wrap to 0 is seamless. Outgoing
 * parts fade in the first half and incoming ones in the second, so swapped labels never overlap.
 * Ambient keys keep following time throughout.
 */
export function loopStory(T: number, story: (t: number) => Frame, ambient: (k: string) => boolean = () => false) {
  const f0 = story(0);
  const fe = story(T - RESET);
  return (t: number): Frame => {
    if (t < T - RESET) return story(t);
    const r = p(t, T - RESET, T);
    const cur = story(t);
    const st: Frame["st"] = {};
    for (const k in fe.st) {
      if (ambient(k)) {
        st[k] = cur.st[k]!;
        continue;
      }
      const a = fe.st[k]!;
      const z = f0.st[k] ?? {};
      const m = (u?: number, v?: number, d = 0) => (u === undefined && v === undefined ? undefined : mix(u ?? d, v ?? d, r));
      const ao = a.o ?? 1;
      const zo = z.o ?? 1;
      const sx = m(a.sx, z.sx, 1);
      st[k] = {
        x: m(a.x, z.x),
        y: m(a.y, z.y),
        s: m(a.s, z.s, 1),
        sx: sx === undefined ? undefined : grow(sx),
        o: mix(ao, zo, zo > ao ? clamp(r * 2 - 1) : clamp(r * 2)),
      };
    }
    const tx: Record<string, string> = {};
    for (const k in fe.tx) {
      const a = pct(fe.tx[k]);
      const z = pct(f0.tx?.[k]);
      tx[k] = a !== null && z !== null ? `${Math.round(mix(a, z, r))}%` : r < 0.5 ? fe.tx[k]! : (f0.tx?.[k] ?? "");
    }
    return { st, tx };
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function css(s: St | undefined) {
  const tr =
    s && (s.x || s.y || s.s !== undefined || s.sx !== undefined)
      ? `translate(${r2(s.x ?? 0)}px, ${r2(s.y ?? 0)}px) scale(${r2(s.sx ?? s.s ?? 1)}, ${r2(s.s ?? 1)})`
      : "none";
  const op = s?.o === undefined ? "1" : String(r2(s.o));
  return { transform: tr, opacity: op };
}

/** Unique, url()-safe id prefix for patterns and clip paths. */
export function useSvgId() {
  return "il" + useId().replace(/[^a-zA-Z0-9]/g, "");
}

/**
 * Runs `frame` while the drawing is on screen. Time wraps at T (Infinity plays once). With
 * `hold`, the scene stops for good at that time, so a finished story costs no frames.
 */
export function useScene(T: number, still: number, frame: (t: number) => Frame, hold?: number) {
  const root = useRef<SVGSVGElement>(null);
  const els = useRef(new Map<string, SVGElement>());
  const texts = useRef(new Map<string, SVGElement>());
  const last = useRef(new Map<string, string>());
  const time = useRef(0);
  const seen = useInView(root);
  const reduced = useReducedMotion();
  /* The server render and the first paint use frame(0), computed once. */
  const [first] = useState(() => frame(0));

  const apply = useCallback(
    (t: number) => {
      const f = frame(t);
      for (const k in f.st) {
        const el = els.current.get(k);
        if (!el) continue;
        const c = css(f.st[k]);
        const key = c.transform + "|" + c.opacity;
        if (last.current.get(k) === key) continue;
        last.current.set(k, key);
        el.style.transform = c.transform;
        el.style.opacity = c.opacity;
      }
      for (const k in f.tx) {
        const el = texts.current.get(k);
        if (el && el.textContent !== f.tx[k]) el.textContent = f.tx[k]!;
      }
    },
    [frame],
  );

  useEffect(() => {
    if (reduced) {
      apply(still);
      return;
    }
    if (!seen) return;
    if (hold !== undefined && time.current >= hold) {
      apply(hold);
      return;
    }
    let raf = 0;
    let prev = 0;
    const tick = (now: number) => {
      const dt = prev ? Math.min(50, now - prev) : 0;
      prev = now;
      time.current = (time.current + dt) % T;
      if (hold !== undefined && time.current >= hold) {
        apply(hold);
        return;
      }
      apply(time.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [seen, reduced, apply, still, T, hold]);

  /** Props for an animated element: a ref and its frame(0) style. */
  const b = (k: string) => ({
    ref: (el: SVGElement | null) => {
      if (el) els.current.set(k, el);
    },
    style: css(first.st[k]),
  });
  /** Props for a text element whose content follows the scene. */
  const tx = (k: string) => ({
    ref: (el: SVGElement | null) => {
      if (el) texts.current.set(k, el);
    },
    children: first.tx?.[k] ?? "",
  });
  return { root, b, tx };
}
