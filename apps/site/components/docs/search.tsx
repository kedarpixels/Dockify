"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icon";
import { cx } from "@/components/ui/cx";
import { ownsKeys, singleKeyShortcutsOn } from "@/components/ui/shortcuts";
import type { SearchEntry } from "./search-index";

/* Docs search: an index of titles and headings (/search.json, written at build time), opened with
   Ctrl K (Cmd K on a Mac), the trigger in the sidebar, or "/". Arrow keys move, Enter opens, Escape,
   the X or a click outside closes. The dialog is portalled to <body>, so it sits above the sticky
   header and nothing on the page paints through it. */

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]+/g, " ");

function score(e: SearchEntry, terms: string[]): number {
  const head = norm(e.heading ?? e.page);
  const page = norm(e.page);
  const lead = norm(e.lead ?? "");
  let total = 0;
  for (const t of terms) {
    if (head.startsWith(t)) total += 6;
    else if (head.split(" ").some((w) => w.startsWith(t))) total += 4;
    else if (head.includes(t)) total += 3;
    else if (page.includes(t)) total += 2;
    else if (lead.includes(t)) total += 1;
    else return 0;
  }
  return total + (e.heading ? 0 : 1);
}

/* One fetch per visit; a failed one is tried again on the next open. */
let indexLoad: Promise<SearchEntry[]> | null = null;
function loadIndex(): Promise<SearchEntry[]> {
  indexLoad ??= fetch("/search.json")
    .then((r) => (r.ok ? (r.json() as Promise<SearchEntry[]>) : Promise.reject(new Error(`HTTP ${r.status}`))))
    .catch((e: unknown) => {
      indexLoad = null;
      throw e;
    });
  return indexLoad;
}

const noop = () => () => {};
const isMac = () => /Mac|iPhone|iPad/.test(navigator.userAgent);

/** The sidebar trigger plus the global shortcuts. Only one is mounted per page. */
export function DocsSearch() {
  const [open, setOpen] = useState(false);
  const mac = useSyncExternalStore(noop, isMac, () => false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (!singleKeyShortcutsOn() || ownsKeys(e.target)) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button
        type="button"
        className="dsearch-key"
        onClick={() => setOpen(true)}
        onPointerEnter={() => void loadIndex().catch(() => {})}
        onFocus={() => void loadIndex().catch(() => {})}
        aria-haspopup="dialog"
        aria-keyshortcuts={mac ? "Meta+K /" : "Control+K /"}
      >
        <Icon name="search" size={16} />
        <span className="dsearch-key-label">Search docs</span>
        <span className="dsearch-key-kbd" aria-hidden="true">
          <kbd className="kbd">{mac ? "Cmd" : "Ctrl"}</kbd>
          <kbd className="kbd">K</kbd>
        </span>
      </button>
      {open ? <SearchDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

type Index = { state: "loading" } | { state: "ready"; list: SearchEntry[] } | { state: "error" };

function SearchDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const [index, setIndex] = useState<Index>({ state: "loading" });
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const downOnScrim = useRef(false);
  const listId = useId();

  useEffect(() => {
    let live = true;
    loadIndex().then(
      (l) => live && setIndex({ state: "ready", list: l }),
      () => live && setIndex({ state: "error" }),
    );
    return () => {
      live = false;
    };
  }, []);

  const results = useMemo(() => {
    if (index.state !== "ready") return [];
    const terms = norm(q).split(" ").filter(Boolean);
    if (!terms.length) return index.list.filter((e) => !e.heading);
    return index.list
      .map((e) => ({ e, s: score(e, terms) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 12)
      .map((r) => r.e);
  }, [q, index]);

  // Focus moves into the dialog and the page stops scrolling; both come back on close.
  useEffect(() => {
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus();
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = before;
      back?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const go = useCallback(
    (e: SearchEntry | undefined) => {
      if (!e) return;
      onClose();
      router.push(e.href);
    },
    [onClose, router],
  );

  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      onClose();
    } else if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setAt((i) => Math.min(results.length - 1, i + 1));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setAt((i) => Math.max(0, i - 1));
    } else if (ev.key === "Enter" && ev.target === input.current) {
      ev.preventDefault();
      go(results[at]);
    } else if (ev.key === "Tab") {
      // Tab stays inside: the field and the close key.
      const keys = [...(panel.current?.querySelectorAll<HTMLElement>("input, button") ?? [])];
      if (!keys.length) return;
      const i = keys.indexOf(document.activeElement as HTMLElement);
      ev.preventDefault();
      keys[(i + (ev.shiftKey ? -1 : 1) + keys.length) % keys.length]?.focus();
    }
  };

  return createPortal(
    <div
      className="dlg-scrim dsearch-scrim"
      onPointerDown={(e) => {
        downOnScrim.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnScrim.current && e.target === e.currentTarget) onClose();
        downOnScrim.current = false;
      }}
    >
      <div ref={panel} className="dlg dsearch" data-size="lg" role="dialog" aria-modal="true" aria-label="Search docs" onKeyDown={onKey}>
        <div className="dsearch-field">
          <Icon name="search" size={16} />
          <input
            ref={input}
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setAt(0);
            }}
            placeholder="Search titles and headings"
            aria-label="Search docs"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={results[at] ? `${listId}-${at}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" className="btn btn-icon dlg-close dsearch-close" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={12} />
          </button>
        </div>
        {index.state === "loading" ? (
          <p className="dsearch-none" role="status">
            Loading the docs index
          </p>
        ) : index.state === "error" ? (
          <p className="dsearch-none" role="status">
            Search could not load. Check your connection, then open it again.
          </p>
        ) : results.length ? (
          <ul ref={list} id={listId} className="dsearch-list" role="listbox" aria-label="Results">
            {results.map((e, i) => (
              <li
                key={e.href}
                id={`${listId}-${i}`}
                data-i={i}
                role="option"
                aria-selected={i === at}
                className={cx("dsearch-row", i === at && "is-on")}
                onMouseMove={() => setAt(i)}
                onClick={() => go(e)}
              >
                <span className="dsearch-ic" aria-hidden="true">
                  <Icon name={e.heading ? "hash" : "book"} size={14} />
                </span>
                <span className="dsearch-text">
                  <span className="dsearch-title">{e.heading ?? e.page}</span>
                  <span className="dsearch-sub">{e.heading ? e.page : (e.lead ?? "Page")}</span>
                </span>
                <Icon name="enter" size={14} className="dsearch-enter" />
              </li>
            ))}
          </ul>
        ) : (
          <p className="dsearch-none" role="status">
            Nothing matches &ldquo;{q}&rdquo;. Try a shorter word.
          </p>
        )}
        <div className="dsearch-ft" aria-hidden="true">
          <span>
            <kbd className="kbd">Up</kbd>
            <kbd className="kbd">Down</kbd> move
          </span>
          <span>
            <kbd className="kbd">Enter</kbd> open
          </span>
          <span>
            <kbd className="kbd">Esc</kbd> close
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
