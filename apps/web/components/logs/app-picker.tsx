"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { AppIcon, ProjectIcon } from "@/components/icons/app-icon";
import { EnvTag } from "@/components/ui/env-tag";
import { plural } from "@/lib/format";
import { opensUp, useOutsidePress } from "@/lib/hooks";
import type { AppKind } from "@/lib/types";

/*
 * The app filter: a multi-select in the Select material, grouped by project. A project row picks
 * or drops all of its apps at once. Nothing picked means every app, and picking every app reads
 * back as nothing picked, so the two never disagree. Keyboard: arrows (wrapping), Home and End
 * move; letters jump to the next row that starts with them, as in Select; Space or Enter toggles;
 * Escape or a click outside closes and returns focus. Every key the list reads is used up there,
 * so a letter never also reaches a page shortcut.
 */

export interface PickerApp {
  id: string;
  name: string;
  kind: AppKind;
  project: string;
  env: string;
  stopped: boolean;
  /** Its lines live on Vercel, not here: the page says where when it is picked. */
  onVercel: boolean;
  slot: number;
}

type Row = { kind: "project"; project: string; ids: string[] } | { kind: "app"; app: PickerApp };

export function AppPicker({ apps, value, onChange }: { apps: PickerApp[]; value: string[]; onChange: (next: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [side, setSide] = useState<"bottom" | "top">("bottom");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = `${useId()}-apps`;

  const rows: Row[] = [];
  for (const project of [...new Set(apps.map((a) => a.project))]) {
    const own = apps.filter((a) => a.project === project);
    rows.push({ kind: "project", project, ids: own.map((a) => a.id) });
    for (const app of own) rows.push({ kind: "app", app });
  }

  const picked = new Set(value);
  const all = (ids: string[]) => ids.length > 0 && ids.every((id) => picked.has(id));
  const some = (ids: string[]) => ids.some((id) => picked.has(id));

  /** Every app picked is the same as none: show everything. */
  const commit = (next: Set<string>) => onChange(next.size >= apps.length && apps.every((a) => next.has(a.id)) ? [] : apps.map((a) => a.id).filter((id) => next.has(id)));

  const toggle = (row: Row) => {
    const next = new Set(picked);
    if (row.kind === "app") {
      if (next.has(row.app.id)) next.delete(row.app.id);
      else next.add(row.app.id);
    } else if (all(row.ids)) for (const id of row.ids) next.delete(id);
    else for (const id of row.ids) next.add(id);
    commit(next);
  };

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  // Type-ahead: letters typed within 600ms build one query; the search starts after the active row
  // and wraps, so typing the same letter again walks through the rows that start with it.
  const typed = useRef({ text: "", at: Number.NEGATIVE_INFINITY });
  /**
   * `at` is the key event's own time stamp, so the pause between letters needs no clock read.
   * `current` is the row the search moves on from (-1 starts at the top).
   */
  const typeAhead = (key: string, at: number, current: number) => {
    const text = (at - typed.current.at < 600 ? typed.current.text : "") + key.toLowerCase();
    typed.current = { text, at };
    // One letter moves on from the current row; a longer query may keep it, since it still matches.
    const from = text.length > 1 ? Math.max(current, 0) : current + 1;
    for (let k = 0; k < rows.length; k++) {
      const i = (from + k) % rows.length;
      const row = rows[i]!;
      if ((row.kind === "project" ? row.project : row.app.name).toLowerCase().startsWith(text)) return i;
    }
    return -1;
  };

  useOutsidePress(open, [root], () => close(false));

  // Before paint: open above the trigger when the panel would run past the viewport bottom.
  useLayoutEffect(() => {
    if (!open || !trigger.current || !list.current) return;
    const r = trigger.current.getBoundingClientRect();
    setSide(opensUp(r, (list.current.parentElement?.offsetHeight ?? 0) + 12, trigger.current.parentElement) ? "top" : "bottom");
  }, [open]);

  // The list takes focus; keyboard moves keep the active row in view by scrolling the panel only.
  const byPointer = useRef(false);
  useEffect(() => {
    if (!open || !list.current) return;
    const ul = list.current;
    if (document.activeElement !== ul) ul.focus({ preventScroll: true });
    if (byPointer.current) {
      byPointer.current = false;
      return;
    }
    const panel = ul.parentElement;
    const row = ul.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!row || !panel) return;
    if (row.offsetTop < panel.scrollTop) panel.scrollTop = row.offsetTop - 4;
    else if (row.offsetTop + row.offsetHeight > panel.scrollTop + panel.clientHeight - 52) panel.scrollTop = row.offsetTop + row.offsetHeight - panel.clientHeight + 56;
  }, [open, active]);

  const onListKey = (e: React.KeyboardEvent) => {
    const n = rows.length;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") close(false);
    else if (n === 0) return;
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % n);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + n) % n);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(n - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const row = rows[active];
      if (row) toggle(row);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const hit = typeAhead(e.key, e.timeStamp, active);
      if (hit >= 0) setActive(hit);
    }
  };

  const one = value.length === 1 ? apps.find((a) => a.id === value[0]) : undefined;
  const label = value.length === 0 ? "All apps" : one ? `${one.project} / ${one.name}` : plural(value.length, "app");

  return (
    <div ref={root} className="sel lx-pick" data-open={open}>
      <button
        ref={trigger}
        type="button"
        className="sel-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Filter by app, ${label}`}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
            e.preventDefault();
            setActive(0);
            setOpen(true);
          } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            // A letter opens the list on the first row that starts with it.
            e.preventDefault();
            const hit = typeAhead(e.key, e.timeStamp, -1);
            setActive(hit >= 0 ? hit : 0);
            setOpen(true);
          }
        }}
      >
        {one ? (
          <span className="sel-glyph" aria-hidden="true">
            <AppIcon id={one.id} kind={one.kind} />
          </span>
        ) : (
          <Icon name="layers" size={16} />
        )}
        <span className="sel-value" title={label}>
          {label}
        </span>
        <span className="sel-chev" aria-hidden="true">
          <Icon name="chevronDown" size={16} />
        </span>
      </button>

      {open ? (
        <div className="sel-list lx-pick-panel" data-side={side}>
          <ul
            ref={list}
            id={listId}
            role="listbox"
            aria-multiselectable="true"
            aria-label="Apps"
            tabIndex={-1}
            aria-activedescendant={`${listId}-${active}`}
            className="lx-pick-list"
            onKeyDown={onListKey}
          >
            {rows.map((row, i) => {
              const on = row.kind === "app" ? picked.has(row.app.id) : all(row.ids);
              const part = row.kind === "project" && !on && some(row.ids);
              return (
                <li
                  key={row.kind === "app" ? row.app.id : `p:${row.project}`}
                  id={`${listId}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={on}
                  data-active={i === active}
                  data-kind={row.kind}
                  className="sel-option lx-pick-opt"
                  onPointerMove={() => {
                    if (i === active) return;
                    byPointer.current = true;
                    setActive(i);
                  }}
                  onClick={() => toggle(row)}
                >
                  <span className="sel-lead" data-glyph aria-hidden="true">
                    {row.kind === "project" ? <ProjectIcon slug={row.project} /> : <AppIcon id={row.app.id} kind={row.app.kind} />}
                  </span>
                  <span className="sel-option-label">{row.kind === "project" ? row.project : row.app.name}</span>
                  {row.kind === "app" ? <span className="lx-dot" style={{ ["--lx-app" as string]: `var(--lx-c${row.app.slot})` }} aria-hidden="true" /> : null}
                  {row.kind === "app" ? <EnvTag env={row.app.env} quiet compact /> : null}
                  <span className="sel-hint num">{row.kind === "project" ? plural(row.ids.length, "app") : row.app.onVercel ? "On Vercel" : row.app.stopped ? "Stopped" : ""}</span>
                  <span className="sel-check" aria-hidden="true">
                    {on ? <Icon name="check" size={16} /> : part ? <Icon name="minus" size={16} /> : null}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="lx-pick-foot">
            <span className="num">{value.length ? `${plural(value.length, "app")} picked` : "Showing every app"}</span>
            <button type="button" className="btn btn-xs" disabled={!value.length} onClick={() => onChange([])}>
              Show all
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
