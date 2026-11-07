"use client";

import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/icon";
import { AppIcon, ProjectIcon } from "@/components/icons/app-icon";
import { EnvTag } from "@/components/ui/env-tag";
import { IconTile } from "@/components/ui/icon-tile";
import { claimLeave } from "@/components/ui/leave-guard";
import type { Tone } from "@/lib/derive";
import { plural } from "@/lib/format";
import type { AppKind } from "@/lib/types";
import { useModKey } from "./mod-key";
import { MAIN_NAV, SYSTEM_NAV } from "./nav";
import type { ShellData } from "./shell";
import { useCan } from "@/lib/viewer";

interface Entry {
  id: string;
  group: string;
  label: string;
  /** Text the query also matches, shown on the right. */
  hint?: string;
  /** Text the query also matches, not shown: a renamed app's own name. */
  alias?: string;
  href: string;
  icon?: IconName;
  /** Projects show their icon and their state. */
  project?: { slug: string; tone: Tone };
  /** Apps show their icon. */
  app?: { id: string; kind: AppKind };
  /** Apps show their environment tag. */
  env?: string;
  /** Recent rows carry the id of the entry they repeat. */
  key?: string;
}

/* Recently opened entries, newest first, kept per browser. Storage can be missing or blocked. */
const RECENT_KEY = "dockify:cmd-recent";
const RECENT_MAX = 5;
function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}
function rememberRecent(id: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_MAX)));
  } catch {
    /* recents are a convenience only */
  }
}

/**
 * Ctrl K (Cmd K on Apple platforms). A modal over the shell: the page behind leaves the keyboard
 * and the accessibility tree while it is open. Closing gives focus back to whatever opened it;
 * `onNavigate` hears a pick's destination first, so the shell can land focus on the next page.
 */
export function CommandMenu({ data, onClose, onNavigate }: { data: ShellData; onClose: () => void; onNavigate: (href: string) => void }) {
  const router = useRouter();
  const mod = useModKey();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const [recent] = useState(readRecent);
  const can = useCan();
  // Read while rendering, before the input takes focus. The phone menu closes as its search row
  // opens this, so the burger stands in for that row.
  const [opener] = useState(() => {
    const a = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    return a?.closest("#mobile-nav") ? document.querySelector<HTMLElement>('[aria-controls="mobile-nav"]') : a;
  });

  const entries = useMemo<Entry[]>(
    () => [
      ...(can.manage ? [{ id: "new", group: "Actions", label: "New project", href: "/projects/new", icon: "plus" as IconName }] : []),
      ...[...MAIN_NAV, ...SYSTEM_NAV].map((n) => ({ id: n.href, group: "Go to", label: n.label, href: n.href, icon: n.icon })),
      ...data.projects.map((p) => ({
        id: `p-${p.slug}`,
        group: "Projects",
        label: p.slug,
        hint: p.stateLabel,
        href: `/projects/${p.slug}`,
        project: { slug: p.slug, tone: p.tone },
      })),
      ...data.apps.map((a) => ({
        id: `a-${a.id}`,
        group: "Apps",
        label: a.label,
        alias: a.name,
        hint: a.environment ?? undefined,
        env: a.environment ?? undefined,
        href: `/apps/${a.id}`,
        app: { id: a.id, kind: a.kind },
      })),
    ],
    [data, can.manage],
  );

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) return entries.filter((e) => e.label.toLowerCase().includes(q) || e.hint?.toLowerCase().includes(q) || e.alias?.toLowerCase().includes(q));
    // No query: recent picks first (entries that no longer exist drop out), then the defaults.
    const byId = new Map(entries.map((e) => [e.id, e]));
    const recents = recent.flatMap((id) => {
      const e = byId.get(id);
      return e ? [{ ...e, id: `recent-${e.id}`, group: "Recent", key: e.id }] : [];
    });
    return [...recents, ...entries.filter((e) => e.group !== "Apps")];
  }, [entries, query, recent]);

  // Results can shrink under the cursor when live data refreshes, so the active row is clamped.
  const active = Math.min(index, Math.max(results.length - 1, 0));

  useEffect(() => {
    // The first row scrolls fully home, so its group heading shows again after a wrap.
    if (active === 0 && listRef.current) listRef.current.scrollTop = 0;
    else listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // What a query leaves, said once typing pauses rather than on every key.
  const [said, setSaid] = useState("");
  useEffect(() => {
    const text = !query.trim() ? "" : results.length ? plural(results.length, "result") : "No results";
    const t = setTimeout(() => setSaid(text), 500);
    return () => clearTimeout(t);
  }, [query, results.length]);

  const go = (e: Entry | undefined) => {
    if (!e) return;
    rememberRecent(e.key ?? e.id);
    onClose();
    // A page holding unsaved edits asks first, and goes on itself on Leave.
    if (claimLeave(e.href)) return;
    onNavigate(e.href);
    router.push(e.href);
  };

  // Focus stays in the input while open (combobox pattern). Escape closes from anywhere.
  const close = useEffectEvent(() => onClose());
  useEffect(() => {
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    };
    document.addEventListener("keydown", onDocKey, true);
    const behind = [...document.querySelectorAll<HTMLElement>(".shell > .side, .shell > .shell-main")].filter((el) => !el.inert);
    for (const el of behind) el.inert = true;
    // The page under the scrim stays put, restoring whatever overflow it had before.
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onDocKey, true);
      for (const el of behind) el.inert = false;
      root.style.overflow = overflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") e.preventDefault();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      // Arrows wrap around the ends, like every list in the dashboard.
      if (results.length) setIndex((active + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length) setIndex((active - 1 + results.length) % results.length);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      go(results[active]);
    }
  };

  // A press anywhere in the panel but the input would blur it and strand the arrow keys, so the
  // input keeps focus; row clicks still fire.
  const keepFocus = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
  };

  const groups = useMemo(() => {
    const out: Array<{ name: string; items: Array<{ entry: Entry; i: number }> }> = [];
    results.forEach((entry, i) => {
      const last = out.at(-1);
      if (last && last.name === entry.group) last.items.push({ entry, i });
      else out.push({ name: entry.group, items: [{ entry, i }] });
    });
    return out;
  }, [results]);

  return (
    <div className="cmd-scrim" onMouseDown={onClose}>
      <div className="cmd" role="dialog" aria-modal="true" aria-label="Command menu" onMouseDown={keepFocus} onKeyDown={onKey}>
        <div className="cmd-input">
          <Icon name="search" />
          <input
            spellCheck={false}
            autoFocus
            aria-label="Search"
            value={query}
            onChange={(e) => {
              // A new query starts at the top.
              setQuery(e.target.value);
              setIndex(0);
            }}
            placeholder="Search projects, apps and pages"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="cmd-list"
            aria-autocomplete="list"
            aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
          />
          {/* The close key: the Esc chip on a keyboard, a cross on a phone, where there is no Esc. */}
          <button type="button" className="cmd-close" aria-label="Close" onClick={onClose}>
            <kbd className="kbd" aria-hidden="true">
              Esc
            </kbd>
            <Icon name="close" size={12} />
          </button>
        </div>
        {/* The list holds only options; an empty query result is said beside it, not inside it. */}
        <div className="cmd-list" id="cmd-list" role="listbox" aria-label="Results" ref={listRef} hidden={results.length === 0}>
          {groups.map((g) => (
            <div key={g.name} role="group" aria-label={g.name} className="cmd-section">
              <div className="cmd-group" aria-hidden="true">
                {g.name}
              </div>
              {g.items.map(({ entry: e, i }) => (
                <div
                  key={e.id}
                  id={`cmd-${e.id}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  className="soft-row cmd-item"
                  onMouseMove={() => setIndex(i)}
                  onClick={() => go(e)}
                >
                  {e.project || e.app ? (
                    <span className="cmd-slot">
                      {e.app ? <AppIcon id={e.app.id} kind={e.app.kind} /> : <ProjectIcon slug={e.project?.slug} />}
                    </span>
                  ) : (
                    <IconTile size="sm">{e.icon ? <Icon name={e.icon} size={14} /> : null}</IconTile>
                  )}
                  <span className="cmd-label">{e.label}</span>
                  {e.project ? (
                    <span className="cmd-hint">
                      <span className="dot" data-tone={e.project.tone} aria-hidden="true" />
                      {e.hint}
                    </span>
                  ) : e.env ? (
                    <span className="cmd-hint">
                      <EnvTag env={e.env} compact />
                    </span>
                  ) : null}
                  <span className="cmd-enter">
                    <Icon name="enter" size={14} />
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
        {results.length === 0 ? <p className="cmd-empty">Nothing matches “{query}”.</p> : null}
        <p className="sr" role="status">
          {said}
        </p>
        <div className="cmd-foot">
          <span className="cmd-foot-hint">
            <kbd className="kbd kbd-ic">
              <Icon name="arrowUp" size={12} />
            </kbd>
            <kbd className="kbd kbd-ic">
              <Icon name="arrowDown" size={12} />
            </kbd>
            to move
          </span>
          <span className="cmd-foot-hint">
            <kbd className="kbd kbd-ic">
              <Icon name="enter" size={12} />
            </kbd>
            to open
          </span>
          <span className="cmd-foot-hint cmd-foot-end">
            <kbd className="kbd">{mod}</kbd>
            <kbd className="kbd">B</kbd>
            sidebar
          </span>
        </div>
      </div>
    </div>
  );
}
