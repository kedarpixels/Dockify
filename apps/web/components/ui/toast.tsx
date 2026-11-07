"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon, type IconName } from "@/components/icon";
import { IconTile } from "./icon-tile";

/**
 * The one toast. Call `toast(...)` from anywhere on the client; <Toaster /> (mounted once in the
 * root layout) renders the stack.
 *
 *   toast.success("Deployment started", { description: "horseai / web, main 9c0d4e2" })
 *   toast.error("Could not save", { description: err.message })
 *   toast.promise(save(), { loading: "Saving", success: "Saved", error: (e) => e.message })
 *   toast.promise(recheck(), { loading: "Checking DNS", success: (r) => ({ title: "Wrong IP", tone: "warn" }), error: "Check failed" })
 *
 * At most three exist at once, newest in front; older ones tuck behind and fan out on hover or
 * focus. A fourth makes room by sending one card out at the back: the oldest confirmation first,
 * then progress, then problems, so a newer success never pushes an error away. Nothing waits off
 * screen, so no card ever comes back in from the top.
 *
 * The stack fans out on hover or focus, but only the focus holds the clock: the pointer resting on a
 * toast never stops it (the owner's call), and a keyboard user reaching a key gets the time. Timers
 * also pause while a card is swiped and while the tab is hidden. A toast with an action (Undo, View) stays at least 10 seconds, and Alt+T moves the
 * focus to the newest toast's keys from anywhere, so the action is in reach for the keyboard too;
 * Esc dismisses it and puts the focus back where it was. Swipe down to dismiss on touch.
 */

export type ToastTone = "neutral" | "ok" | "bad" | "warn" | "info" | "loading";

export interface ToastOptions {
  description?: string;
  tone?: ToastTone;
  /** Milliseconds. Errors default longer; loading toasts stay until resolved. */
  duration?: number;
  action?: { label: string; onClick: () => void };
  id?: string;
}

interface ToastItem extends Required<Pick<ToastOptions, "tone">> {
  id: string;
  /** One card's identity: kept when the toast is replaced in place, new when it comes back after leaving. */
  key: number;
  title: string;
  description?: string;
  duration: number;
  action?: ToastOptions["action"];
  createdAt: number;
  /** "dismiss" slides out under the stack; "overflow" recedes behind it to make room for a new one. */
  leaving?: "dismiss" | "overflow";
}

const DEFAULT_MS: Record<ToastTone, number> = { neutral: 3200, ok: 3600, info: 4000, warn: 5200, bad: 6400, loading: Infinity };
/** The least time a toast with an action stays up, so the action can be reached and read. */
const ACTION_MS = 10_000;
const ICON: Record<ToastTone, IconName> = { neutral: "info", ok: "checkCircle", bad: "closeCircle", warn: "alert", info: "info", loading: "loader" };
/** The icon tile's tone per toast tone: neutral stays plain, loading is info's blue. */
const TILE: Record<ToastTone, "ok" | "warn" | "bad" | "info" | undefined> = { neutral: undefined, ok: "ok", bad: "bad", warn: "warn", info: "info", loading: "info" };

/** Cards on screen at once. */
const VISIBLE = 3;
/** A leaving card fades in 200ms (foundation.css); it is removed a little after, never mid-fade. */
const REMOVE_MS = 260;
/** Which card makes room for a new one: the lowest rank goes first, the oldest within a rank. */
const KEEP: Record<ToastTone, number> = { neutral: 0, ok: 0, info: 0, loading: 1, warn: 2, bad: 2 };

/* -------------- Store -------------- */
let items: ToastItem[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
let seq = 0;
let keys = 0;

/** Marks a card as leaving and removes it once its fade has run. */
function leave(t: ToastItem, why: NonNullable<ToastItem["leaving"]>) {
  items = items.map((x) => (x === t ? { ...t, leaving: why } : x));
  setTimeout(() => {
    items = items.filter((x) => x.key !== t.key);
    emit();
  }, REMOVE_MS);
}

function push(title: string, o: ToastOptions = {}): string {
  const tone = o.tone ?? "neutral";
  const id = o.id ?? `t${++seq}`;
  const at = items.findIndex((t) => t.id === id && !t.leaving);
  const base = o.duration ?? DEFAULT_MS[tone];
  const next: ToastItem = {
    id,
    key: at >= 0 ? items[at]!.key : ++keys,
    title,
    tone,
    description: o.description,
    action: o.action,
    duration: o.action && Number.isFinite(base) ? Math.max(ACTION_MS, base) : base,
    createdAt: Date.now() + ++seq / 1e6,
  };
  if (at >= 0) {
    // A replaced toast (a loading toast settling) keeps its card and its place in the stack.
    items = items.map((t, i) => (i === at ? next : t));
  } else {
    // New, or back while its old card still fades: either way it arrives at the front.
    items = [...items, next];
    const live = items.filter((t) => !t.leaving && t !== next);
    if (live.length >= VISIBLE) {
      const rank = Math.min(...live.map((t) => KEEP[t.tone]));
      leave(live.find((t) => KEEP[t.tone] === rank)!, "overflow");
    }
  }
  emit();
  return id;
}

function dismiss(id: string) {
  const t = items.find((x) => x.id === id && !x.leaving);
  if (!t) return;
  leave(t, "dismiss");
  emit();
}

type ToastFn = ((title: string, o?: ToastOptions) => string) & {
  success: (title: string, o?: Omit<ToastOptions, "tone">) => string;
  error: (title: string, o?: Omit<ToastOptions, "tone">) => string;
  warn: (title: string, o?: Omit<ToastOptions, "tone">) => string;
  info: (title: string, o?: Omit<ToastOptions, "tone">) => string;
  loading: (title: string, o?: Omit<ToastOptions, "tone">) => string;
  dismiss: (id: string) => void;
  promise: <T>(p: Promise<T>, m: PromiseMessages<T>) => Promise<T>;
};

/** What a settled promise toast shows: a bare title, or a title with its own description, action and tone. */
export type ToastResult = string | { title: string; description?: string; action?: ToastOptions["action"] };
export interface PromiseMessages<T> {
  loading: string;
  /** A success resolver may end as a warning (`tone: "warn"`), such as a check that found a mismatch. */
  success: string | ((v: T) => string | (Exclude<ToastResult, string> & { tone?: "ok" | "warn" }));
  error: string | ((e: unknown) => ToastResult);
  /** Shown while loading, and kept on the result unless the result brings its own. */
  description?: string;
}

function settle(r: ToastResult & { tone?: ToastTone }, fallbackTone: ToastTone, id: string, description?: string) {
  if (typeof r === "string") return push(r, { id, tone: fallbackTone, description });
  return push(r.title, { id, tone: r.tone ?? fallbackTone, description: r.description ?? description, action: r.action });
}

export const toast: ToastFn = Object.assign((title: string, o?: ToastOptions) => push(title, o), {
  success: (title: string, o?: Omit<ToastOptions, "tone">) => push(title, { ...o, tone: "ok" }),
  error: (title: string, o?: Omit<ToastOptions, "tone">) => push(title, { ...o, tone: "bad" }),
  warn: (title: string, o?: Omit<ToastOptions, "tone">) => push(title, { ...o, tone: "warn" }),
  info: (title: string, o?: Omit<ToastOptions, "tone">) => push(title, { ...o, tone: "info" }),
  loading: (title: string, o?: Omit<ToastOptions, "tone">) => push(title, { ...o, tone: "loading" }),
  dismiss,
  promise: async <T,>(p: Promise<T>, m: PromiseMessages<T>) => {
    const id = push(m.loading, { tone: "loading", description: m.description });
    try {
      const v = await p;
      settle(typeof m.success === "function" ? m.success(v) : m.success, "ok", id, m.description);
      return v;
    } catch (e) {
      settle(typeof m.error === "function" ? m.error(e) : m.error, "bad", id, m.description);
      throw e;
    }
  },
});

/* -------------- View -------------- */
const EMPTY: ToastItem[] = [];
const GAP = 8; // between cards when the stack is fanned out
const PEEK = 10; // how far each tucked card shows above the one in front of it
const SWIPE_PX = 40; // a drag this far down dismisses
const SWIPE_VELOCITY = 0.11; // or a flick this fast, in px per ms
const FALLBACK_H = 56;

const spoken = (t: ToastItem) => (t.description ? `${t.title}. ${t.description}` : t.title);

/*
 * Every card sits at the bottom of the list and moves with `translate`, so tucking and fanning are
 * one continuous transition. Fanned offsets come from measured heights; tucked cards borrow the
 * front card's height so their edges line up. A card sent out to make room keeps moving with the
 * stack: it steps one place further back as it fades, so nothing jumps.
 */
export function Toaster() {
  const list = useSyncExternalStore(subscribe, () => items, () => EMPTY);
  const [expanded, setExpanded] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [heights, setHeights] = useState<Record<number, number>>({});
  const region = useRef<HTMLElement>(null);
  // Where the focus was when Alt+T pulled it into the stack, so leaving the stack puts it back.
  const cameFrom = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onVis = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Alt+T (KeyT, so it is the same key on a Mac where Alt types a symbol) focuses the front toast's
  // first key: its action, else its close key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.code !== "KeyT") return;
      const key = region.current?.querySelector<HTMLElement>(".toast[data-depth='0']:not([data-leaving]) button");
      if (!key) return;
      e.preventDefault();
      const from = document.activeElement;
      if (from instanceof HTMLElement && !region.current?.contains(from)) cameFrom.current = from;
      key.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* After a key in the stack dismisses its toast, the focus goes back where it came from (or to the
     next toast's key while there is one), never to the top of the page. */
  const refocus = useCallback(() => {
    requestAnimationFrame(() => {
      const box = region.current;
      if (!box || (document.activeElement && document.activeElement !== document.body && !box.contains(document.activeElement))) return;
      const next = box.querySelector<HTMLElement>(".toast[data-depth='0']:not([data-leaving]) button");
      if (next) return next.focus();
      if (cameFrom.current?.isConnected) cameFrom.current.focus({ preventScroll: true });
      cameFrom.current = null;
    });
  }, []);

  // Once the last toast is gone the stack closes, so the next one starts tucked.
  if (list.length === 0 && expanded) setExpanded(false);
  if (list.length === 0 && focused) setFocused(false);

  // A card reports its height while mounted and drops it when it unmounts (undefined), so a long
  // session never accumulates the heights of removed cards.
  const onHeight = useCallback((key: number, h: number | undefined) => {
    setHeights((m) => {
      if (m[key] === h) return m;
      const next = { ...m };
      if (h === undefined) delete next[key];
      else next[key] = h;
      return next;
    });
  }, []);

  // Front first. Leaving cards drop out of the order at once, so the rest close up while they fade.
  const order = list.filter((t) => !t.leaving).reverse();
  const frontH = order[0] ? heights[order[0].key] : undefined;
  const hOf = (t: ToastItem) => heights[t.key] ?? frontH ?? FALLBACK_H;

  // Fanned offsets: each card sits on top of the ones in front of it. Cards sent out to make room
  // take the next places behind the stack, newest first, the way they were heading.
  const place = new Map<number, { depth: number; y: number }>();
  let acc = 0;
  order.forEach((t, i) => {
    place.set(t.key, { depth: i, y: expanded ? acc : i * PEEK });
    acc += hOf(t) + GAP;
  });
  const outgoing = list.filter((t) => t.leaving === "overflow").reverse();
  outgoing.forEach((t, i) => {
    const depth = order.length + i;
    place.set(t.key, { depth, y: expanded ? acc + i * PEEK : depth * PEEK });
  });

  const listH = !order.length ? 0 : expanded ? acc - GAP : (frontH ?? FALLBACK_H) + (order.length - 1) * PEEK;

  // Screen readers hear each new or replaced toast through two regions that stay mounted, so the
  // text always lands in a region the reader already watches (one created with its text is often
  // skipped). Problems interrupt; the rest wait their turn.
  const [said, setSaid] = useState<{ polite?: { n: number; text: string }; urgent?: { n: number; text: string } }>({});
  const heard = useRef(new Set<number>());
  useEffect(() => {
    const fresh = list.filter((t) => !t.leaving && !heard.current.has(t.createdAt));
    heard.current = new Set(list.map((t) => t.createdAt));
    if (!fresh.length) return;
    const urgent = fresh.filter((t) => t.tone === "bad" || t.tone === "warn");
    const polite = fresh.filter((t) => t.tone !== "bad" && t.tone !== "warn");
    setSaid((s) => ({
      polite: polite.length ? { n: (s.polite?.n ?? 0) + 1, text: polite.map(spoken).join(". ") } : s.polite,
      urgent: urgent.length ? { n: (s.urgent?.n ?? 0) + 1, text: urgent.map(spoken).join(". ") } : s.urgent,
    }));
  }, [list]);

  // A named region only while it holds toasts, so an empty one is not a landmark on every page.
  const named = order.length > 0;

  return (
    <section
      ref={region}
      className="toaster"
      aria-label={named ? "Messages" : undefined}
      aria-keyshortcuts={named ? "Alt+T" : undefined}
      data-expanded={expanded || undefined}
      onPointerEnter={(e) => e.pointerType === "mouse" && setExpanded(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && setExpanded(false)}
      onFocus={() => {
        setExpanded(true);
        setFocused(true);
      }}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget)) return;
        setExpanded(false);
        setFocused(false);
      }}
    >
      <ol className="toast-list" style={{ height: listH }}>
        {list.map((t) => {
          const p = place.get(t.key);
          return (
            <ToastCard
              key={t.key}
              t={t}
              depth={p?.depth}
              y={p?.y ?? 0}
              height={expanded || p?.depth === 0 ? heights[t.key] : (frontH ?? heights[t.key])}
              expanded={expanded}
              paused={hidden || focused}
              onHeight={onHeight}
              onDone={refocus}
            />
          );
        })}
      </ol>
      <div className="sr" role="status">
        {said.polite ? <span key={said.polite.n}>{said.polite.text}</span> : null}
      </div>
      <div className="sr" role="alert">
        {said.urgent ? <span key={said.urgent.n}>{said.urgent.text}</span> : null}
      </div>
    </section>
  );
}

function ToastCard({
  t,
  depth: liveDepth,
  y: liveY,
  height,
  expanded,
  paused,
  onHeight,
  onDone,
}: {
  t: ToastItem;
  /** Undefined while the card is being dismissed. */
  depth: number | undefined;
  y: number;
  height: number | undefined;
  expanded: boolean;
  paused: boolean;
  onHeight: (key: number, h: number | undefined) => void;
  /** A key in this card dismissed it from the keyboard: the stack decides where the focus goes next. */
  onDone: () => void;
}) {
  const el = useRef<HTMLLIElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  const left = useRef(t.duration);
  const startedAt = useRef(0);
  const drag = useRef<{ id: number; y0: number; t0: number; dy: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const [swiping, setSwiping] = useState(false);

  // A dismissed card holds the place and size it had, instead of snapping to the front. The last
  // live place is kept in state, updated during render whenever it changes.
  const [last, setLast] = useState({ depth: liveDepth ?? 0, y: liveY, height });
  if (liveDepth !== undefined && (last.depth !== liveDepth || last.y !== liveY || last.height !== height)) {
    setLast({ depth: liveDepth, y: liveY, height });
  }
  const held = liveDepth === undefined;
  const depth = held ? last.depth : liveDepth;
  const y = held ? last.y : liveY;
  const h = held ? last.height : height;

  // Enter on the next frame, so the first paint is the off state and the transition runs.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Report the content height. The body is never clamped, so this stays true while the card is.
  useLayoutEffect(() => {
    const node = body.current;
    if (!node) return;
    onHeight(t.key, node.offsetHeight);
    const ro = new ResizeObserver(() => onHeight(t.key, node.offsetHeight));
    ro.observe(node);
    return () => {
      ro.disconnect();
      onHeight(t.key, undefined);
    };
  }, [t.key, onHeight]);

  // A replaced toast (same id, a new push) restarts its clock. Declared before the timer so it
  // runs first; otherwise a loading toast turned success would start from Infinity (fires at once).
  useEffect(() => {
    left.current = t.duration;
  }, [t.createdAt, t.duration]);

  const hold = paused || swiping;
  useEffect(() => {
    if (!Number.isFinite(t.duration) || t.leaving) return;
    const anims = bar.current?.getAnimations() ?? [];
    if (hold) {
      anims.forEach((a) => a.pause());
      return;
    }
    startedAt.current = Date.now();
    anims.forEach((a) => a.play());
    const id = setTimeout(() => dismiss(t.id), Math.max(0, left.current));
    return () => {
      clearTimeout(id);
      left.current -= Date.now() - startedAt.current;
    };
  }, [hold, t.id, t.duration, t.leaving, t.createdAt]);

  /* Swipe down to dismiss, for touch and pen. Upward drags meet heavy resistance. */
  const setSwipe = (px: number) => el.current?.style.setProperty("--swipe", `${px}px`);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" || t.leaving || (depth !== 0 && !expanded)) return;
    if ((e.target as HTMLElement).closest("button, a")) return;
    drag.current = { id: e.pointerId, y0: e.clientY, t0: performance.now(), dy: 0 };
    el.current?.setPointerCapture(e.pointerId);
    setSwiping(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const raw = e.clientY - d.y0;
    d.dy = raw > 0 ? raw : raw * 0.2;
    setSwipe(d.dy);
  };
  const endDrag = (e: React.PointerEvent, cancelled = false) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setSwiping(false);
    const velocity = d.dy / Math.max(1, performance.now() - d.t0);
    if (!cancelled && d.dy > 4 && (d.dy > SWIPE_PX || velocity > SWIPE_VELOCITY)) dismiss(t.id);
    else setSwipe(0);
  };

  return (
    <li
      ref={el}
      className="toast"
      data-tone={t.tone}
      data-depth={depth}
      data-mounted={mounted || undefined}
      data-leaving={t.leaving}
      data-swiping={swiping || undefined}
      // A leaving card can no longer be used, so focus and the pointer pass it by.
      inert={t.leaving ? true : undefined}
      style={
        {
          "--depth": depth,
          "--y": `${y}px`,
          height: h === undefined ? undefined : `${h}px`,
        } as React.CSSProperties
      }
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // Marked as used, so a dialog behind the toast stays open.
        e.preventDefault();
        e.stopPropagation();
        dismiss(t.id);
        onDone();
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e)}
      onPointerCancel={(e) => endDrag(e, true)}
    >
      <div ref={body} className="toast-body">
        <IconTile tone={TILE[t.tone]} soft>
          <Icon name={ICON[t.tone]} className={t.tone === "loading" ? "spin" : undefined} />
        </IconTile>
        <span className="toast-text">
          <span className="toast-title">{t.title}</span>
          {t.description ? <span className="toast-desc">{t.description}</span> : null}
        </span>
        {t.action ? (
          <button
            type="button"
            className="btn btn-xs toast-action"
            onClick={(e) => {
              t.action!.onClick();
              dismiss(t.id);
              // From the keyboard (no pointer, detail 0) the focus is handed on; a click leaves it be.
              if (e.detail === 0) onDone();
            }}
          >
            {t.action.label}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-icon toast-close"
          aria-label="Dismiss"
          onClick={(e) => {
            dismiss(t.id);
            if (e.detail === 0) onDone();
          }}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      {Number.isFinite(t.duration) ? (
        <span key={t.createdAt} ref={bar} className="toast-timer" style={{ animationDuration: `${t.duration}ms` }} aria-hidden="true" />
      ) : null}
    </li>
  );
}
