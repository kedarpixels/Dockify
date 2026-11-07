"use client";

import { type RefObject, useEffect, useState, useSyncExternalStore } from "react";

/* Shared motion helpers for the landing demos: every demo stops off screen, and none of them move
   under prefers-reduced-motion. */

const RM = "(prefers-reduced-motion: reduce)";

function subscribeRm(cb: () => void) {
  const mq = window.matchMedia(RM);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/** True when the visitor asked for less motion. Server render assumes motion is allowed. */
export function useReducedMotion() {
  return useSyncExternalStore(
    subscribeRm,
    () => window.matchMedia(RM).matches,
    () => false,
  );
}

const SHOWN = 0.35;

/** True while at least a third of the element is on screen. */
export function useInView(ref: RefObject<Element | null>) {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    /* The 0 threshold reports leaving the screen; a lone 0.35 never fires once fully gone. */
    const io = new IntersectionObserver(([e]) => setSeen(!!e && e.isIntersecting && e.intersectionRatio >= SHOWN), {
      threshold: [0, SHOWN],
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return seen;
}
