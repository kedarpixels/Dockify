"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useFaviconDot } from "./tab-signals";
import { Icon } from "@/components/icon";
import { Empty } from "@/components/ui/empty";
import { IconTile } from "@/components/ui/icon-tile";
import { When } from "@/components/ui/when";
import type { Notice } from "@/lib/derive";
import { useOutsidePress } from "@/lib/hooks";
import { keepSeen } from "@/lib/notices";

/*
 * Read state lives in this browser's storage and is shared by every tab: the stored JSON is the
 * snapshot, so the set is only rebuilt when it changes, and a read in one tab clears the dot in the
 * others. With storage blocked it lasts for this page's life.
 */
const SEEN_KEY = "dockify:seen-notices";
const SEEN_EVENT = "dockify-seen-notices";
let seenFallback = "[]";

function seenRaw(): string {
  try {
    return localStorage.getItem(SEEN_KEY) ?? "[]";
  } catch {
    return seenFallback;
  }
}

function parseSeen(raw: string): Set<string> {
  try {
    const v: unknown = JSON.parse(raw);
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function writeSeen(ids: Iterable<string>) {
  seenFallback = JSON.stringify([...ids].slice(-200));
  try {
    localStorage.setItem(SEEN_KEY, seenFallback);
  } catch {
    /* read state is a convenience only */
  }
  window.dispatchEvent(new Event(SEEN_EVENT));
}

function subscribeSeen(onChange: () => void) {
  const onStorage = (e: StorageEvent) => {
    if (e.key === SEEN_KEY || e.key === null) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(SEEN_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(SEEN_EVENT, onChange);
  };
}

const TONE_ICON = { bad: "closeCircle", warn: "alert", ok: "checkCircle", live: "refresh", pending: "clock", idle: "info" } as const;

/**
 * The last list a page passed in. A 404, an error or a loading page has no overview of its own, so
 * the bell keeps what the previous page knew instead of losing its dot until the next real page.
 */
let lastKnown: Notice[] | null = null;

/** The ids of the last list this page showed, kept across pages like `lastKnown`. See keepSeen. */
let listedBefore: Set<string> | null = null;

/**
 * The bell. Problems (degraded, stopped, failed in the last day) stay listed until they clear, and
 * finished deploys stay for a day. Every entry is unread until it is opened or marked read.
 * `notices` is null while the page has no overview yet, which is "unknown", not "nothing to show".
 * The panel closes when focus leaves it, on Escape, on a click outside and after a pick; focus goes
 * back to the bell, so it never falls to the page while a pick navigates.
 */
export function Notifications({ notices: given, now }: { notices: Notice[] | null; now: number }) {
  const notices = given ?? lastKnown;
  useEffect(() => {
    if (given) lastKnown = given;
  }, [given]);
  const [open, setOpen] = useState(false);
  // When the panel opened: the clock for pages without one of their own (404, error), which pass 0.
  const [openedAt, setOpenedAt] = useState(0);
  // Null on the server and until hydrated, so nothing counts as unread (and no badge flashes)
  // before this browser's read state is known.
  const raw = useSyncExternalStore(subscribeSeen, seenRaw, () => null);
  const seen = useMemo(() => (raw === null ? null : parseSeen(raw)), [raw]);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const list = notices ?? [];
  const unread = seen ? list.filter((n) => !seen.has(n.id)) : [];
  useFaviconDot(unread.some((n) => n.kind === "problem"));
  const problems = list.filter((n) => n.kind === "problem");
  const results = list.filter((n) => n.kind === "result");

  // Merge with what another tab may have written since, so two tabs never undo each other's reads.
  const mark = (ids: string[]) => writeSeen(new Set([...parseSeen(seenRaw()), ...ids]));

  // Forget the read ids of notices that left this page's list, so a problem that cleared and comes
  // back is new. Only ids this page watched go: another tab can hold a newer list (a hidden tab does
  // not poll), and forgetting what it just read would turn its notices unread again.
  // Only on real data: a page still loading its overview passes null and keeps the read state.
  useEffect(() => {
    if (!notices || !seen) return;
    const live = new Set(notices.map((n) => n.id));
    const kept = keepSeen(seen, listedBefore, live);
    listedBefore = live;
    if (kept.length !== seen.size) writeSeen(kept);
  }, [notices, seen]);

  const markAll = () => {
    if (unread.length) mark(list.map((n) => n.id));
  };

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (!open) return;
    // Escape belongs to the panel while focus is in it (or nowhere); elsewhere it is another
    // widget's key.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const a = document.activeElement;
      const inside = Boolean(a && root.current?.contains(a));
      if (!inside && a && a !== document.body) return;
      setOpen(false);
      if (inside) button.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  useOutsidePress(open, [root], () => setOpen(false));

  const toggle = () => {
    if (!open) setOpenedAt(Date.now());
    setOpen(!open);
  };

  // A pick navigates; the bell holds focus meanwhile, and the next page's main region takes it if
  // the bell goes with the old page.
  const pick = (id: string) => {
    mark([id]);
    close(true);
  };

  const label = unread.length ? `Notifications, ${unread.length} unread` : "Notifications";
  const clock = now || openedAt;

  return (
    <div
      ref={root}
      className="ntf"
      onBlur={(e) => {
        // Tabbing past the last row (or Shift Tab past the bell) leaves the panel, so it closes.
        if (open && e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        className="btn btn-sm btn-icon ntf-bell"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={toggle}
      >
        <Icon name="bell" />
        {unread.length ? <span className="ntf-badge" data-tone={unread.some((n) => n.kind === "problem") ? "bad" : "live"} aria-hidden="true" /> : null}
      </button>

      {open ? (
        <>
          {/* Phones show the panel as a sheet; this dim layer takes the tap outside it, so the tap
              closes the sheet instead of also landing on the page underneath. */}
          <div className="ntf-scrim" aria-hidden="true" onClick={() => setOpen(false)} />
          <div className="ntf-panel" role="dialog" aria-label="Notifications">
            <div className="ntf-hd">
              <span className="ntf-title">
                Notifications
                {unread.length ? (
                  <span className="ntf-count num">
                    {unread.length.toLocaleString("en-US")}
                    <span className="sr"> unread</span>
                  </span>
                ) : null}
              </span>
              {/* A quiet text action, not a key. It stays focusable with nothing left to mark, so
                  pressing it never drops focus. The panel closes with Esc, the bell or a click outside. */}
              <button type="button" className="ntf-markall" onClick={markAll} aria-disabled={unread.length === 0}>
                Mark all as read
              </button>
            </div>

            {list.length === 0 ? (
              <Empty icon="bell" title="All caught up" body="Failures and finished deploys show up here." />
            ) : (
              <div className="ntf-body">
                {problems.length ? <Group label="Needs you" items={problems} seen={seen} now={clock} onPick={pick} /> : null}
                {results.length ? <Group label="Last 24 hours" items={results} seen={seen} now={clock} onPick={pick} /> : null}
              </div>
            )}

            <Link href="/activity" className="ntf-ft" onClick={() => close(true)}>
              View all activity
              <Icon name="arrowRight" size={14} />
            </Link>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Group({ label, items, seen, now, onPick }: { label: string; items: Notice[]; seen: Set<string> | null; now: number; onPick: (id: string) => void }) {
  return (
    <section aria-label={label}>
      <h3 className="ntf-group-hd">{label}</h3>
      <ul className="ntf-list">
        {items.map((n) => {
          const unread = seen ? !seen.has(n.id) : false;
          return (
            <li key={n.id}>
              <Link href={n.href} className="ntf-row" data-unread={seen ? unread : undefined} onClick={() => onPick(n.id)}>
                <IconTile size="sm" tone={n.tone === "pending" || n.tone === "idle" ? undefined : n.tone} soft>
                  <Icon name={TONE_ICON[n.tone]} size={14} />
                </IconTile>
                <span className="ntf-text">
                  <span className="ntf-row-title">
                    {unread ? <span className="sr">Unread, </span> : null}
                    {n.title}
                  </span>
                  <span className="ntf-row-detail num" title={n.detail}>{n.detail}</span>
                </span>
                {n.at ? <When iso={n.at} now={now} tipAlign="end" className="ntf-when num" /> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
