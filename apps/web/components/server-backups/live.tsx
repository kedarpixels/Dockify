"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "@/components/ui/toast";
import { describe, errText } from "@/lib/feedback";
import { isStepUpCancel } from "@/lib/step-up";
import { useTimeFormat } from "@/lib/time-prefs";
import { dueIn } from "./util";

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The first render shows the target as is. Reduced motion skips the tween. */
export function useTween(target: number, ms = 600) {
  const [value, setValue] = useState(target);
  const shown = useRef(target);
  useEffect(() => {
    const from = shown.current;
    if (from === target || reduced()) {
      shown.current = target;
      setValue(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const v = from + (target - from) * (1 - Math.pow(1 - k, 3));
      shown.current = v;
      setValue(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

/* A single interval runs while anything subscribes, and stops when the last one leaves. */
const clock = { now: 0, subs: new Set<() => void>(), timer: undefined as ReturnType<typeof setInterval> | undefined };

function subscribe(cb: () => void) {
  clock.subs.add(cb);
  if (clock.subs.size === 1) {
    clock.now = Date.now();
    clock.timer = setInterval(() => {
      clock.now = Date.now();
      clock.subs.forEach((f) => f());
    }, 1000);
  }
  return () => {
    clock.subs.delete(cb);
    if (!clock.subs.size) clearInterval(clock.timer);
  };
}

// With no subscriber yet the stored time may be stale, so read the current second instead.
const readClock = () => (clock.subs.size ? clock.now : Math.floor(Date.now() / 1000) * 1000);

/** `serverNow` is used for the server render and hydration so both print the same text; the live clock takes over right after. */
export function useSecond(serverNow: number) {
  return useSyncExternalStore(subscribe, readClock, () => serverNow);
}

/** Switches to seconds in the last hour. The exact time sits in the tip. */
export function Countdown({
  at,
  serverNow,
  prefix = "",
  className,
  tipAlign,
}: {
  at: string;
  serverNow: number;
  prefix?: string;
  className?: string;
  tipAlign?: "end";
}) {
  const time = useTimeFormat();
  const now = useSecond(serverNow);
  const t = dueIn(at, now);
  return (
    <span className={className} data-tip={time.abs(at, { utc: true })} data-tip-side="bottom" data-tip-align={tipAlign}>
      {prefix ? `${prefix} ${t}` : t.charAt(0).toUpperCase() + t.slice(1)}
    </span>
  );
}

/** Like toast.promise, with a description on every step: an error carries the API's message. */
export async function track<T>(
  p: Promise<T>,
  m: {
    loading: string;
    description?: string;
    success: (v: T) => { title: string; description?: string | string[]; action?: { label: string; onClick: () => void } };
    error: string;
    preview: boolean;
  },
): Promise<T | undefined> {
  const id = toast.loading(m.loading, { description: m.description });
  try {
    const v = await p;
    const s = m.success(v);
    toast.success(s.title, { id, description: describe(s.description, { preview: m.preview }), action: s.action });
    return v;
  } catch (e) {
    // Closing "Confirm it is you" (components/step-up) is no failure: the loading toast just goes.
    if (isStepUpCancel(e)) toast.dismiss(id);
    else toast.error(m.error, { id, description: describe(errText(e), { preview: m.preview }) });
    return undefined;
  }
}
