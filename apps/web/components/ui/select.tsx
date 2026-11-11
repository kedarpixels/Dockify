"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "@/components/icon";
import { useOutsidePress } from "@/lib/hooks";
import { openLayer } from "@/lib/modal";
import { cx } from "./cx";
import type { FieldIds } from "./field";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** Muted text on the right of the row, such as a count. */
  hint?: string;
  icon?: IconName;
  /** A leading node instead of a glyph, such as a 20px AppIcon. */
  glyph?: React.ReactNode;
  /** A leading status dot instead of an icon. */
  tone?: "ok" | "live" | "pending" | "warn" | "bad" | "idle";
  disabled?: boolean;
}

/** `q` must already be trimmed and lowercased. */
const matching = <T extends string>(options: SelectOption<T>[], q: string) =>
  q ? options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)) : options;

/* GAP is the room between the trigger and the list, EDGE the margin the list keeps inside the
   viewport. CAP is the tallest the options get before they scroll; a filter field adds its own
   FILTER height on top, so every list shows the same number of rows. */
const GAP = 6;
const EDGE = 8;
const CAP = 280;
const FILTER = 41;
const FILTER_MIN_W = 280;

// The open list is portaled to the body, so no scroll box or dialog edge clips it. Every printable
// key the trigger or the list reads is used up there, so a page shortcut never fires as well.
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  icon,
  placeholder = "Select",
  size = "md",
  align = "start",
  className,
  disabled,
  id,
  ids,
  search,
  fullHeight,
}: {
  value: T | null;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  /** Accessible name. Not shown; a Field's visible label (`ids`) names the trigger instead when there is one. */
  label: string;
  /** Leading glyph on the trigger. Falls back to the picked option's own icon. */
  icon?: IconName;
  placeholder?: string;
  size?: "sm" | "md";
  align?: "start" | "end";
  className?: string;
  disabled?: boolean;
  id?: string;
  ids?: FieldIds;
  /** Placeholder of a filter field at the top of the open list. */
  search?: string;
  /** Show every option without the height cap, limited only by the viewport (a short fixed list). */
  fullHeight?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const place = useRef<((measure?: boolean) => void) | null>(null);
  const typed = useRef({ text: "", at: 0 });
  const auto = useId();
  const triggerId = id ?? ids?.id;
  const base = triggerId ?? auto;
  const listId = `${base}-list`;
  const nameId = `${base}-name`;
  const valueId = `${base}-value`;

  const picked = options.find((o) => o.value === value) ?? null;
  const shown = matching(options, search ? query.trim().toLowerCase() : "");
  const lead = icon ?? picked?.icon;
  // When any option has a glyph, every row reserves the slot so labels share one left edge.
  const slot = options.some((o) => Boolean(o.icon || o.tone || o.glyph));
  const slotGlyph = options.some((o) => Boolean(o.glyph));

  const step = (from: number, by: number, rows = shown) => {
    for (let i = 1; i <= rows.length; i++) {
      const next = (from + by * i + rows.length * i) % rows.length;
      if (!rows[next]!.disabled) return next;
    }
    return from;
  };

  /* Opens on `index`, or the first enabled option when that one cannot take the highlight. */
  const openAt = (index: number) => {
    setActive(index >= 0 && !options[index]?.disabled ? index : step(-1, 1));
    setOpen(true);
  };

  /* Type-ahead: letters typed within 600ms build one query; returns the first match or -1. `at` is
     the key event's own time stamp. */
  const typeAhead = (key: string, at: number) => {
    typed.current = { text: (at - typed.current.at < 600 ? typed.current.text : "") + key.toLowerCase(), at };
    return options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(typed.current.text));
  };

  const close = (refocus = true) => {
    setOpen(false);
    setQuery("");
    if (refocus) trigger.current?.focus();
  };

  const pick = (o: SelectOption<T>) => {
    if (o.disabled) return;
    onChange(o.value);
    close();
  };

  // Outside click closes without stealing focus back. The list lives in the body, so it counts as inside.
  useOutsidePress(open, [root, search ? pop : list], () => close(false));

  // Before paint: place the list against the viewport, and keep it on its trigger while anything
  // scrolls or resizes. Inside a dialog it is the top layer while open.
  useLayoutEffect(() => {
    const t = trigger.current;
    const box = search ? pop.current : list.current;
    if (!open || !t || !box) return;
    const release = t.closest("[aria-modal='true']") ? openLayer(`${listId}-layer`) : null;
    let natural = 0;

    const put = (measure = false) => {
      const r = t.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const room = vw - EDGE * 2;
      // As wide as the trigger: a full-width field gets a list of its exact width, and a narrow
      // trigger lets the list grow to its longest option rather than cut it. A filter needs room to type.
      box.style.width = search ? `${Math.min(room, Math.max(r.width, FILTER_MIN_W))}px` : "";
      box.style.minWidth = `${Math.min(r.width, room)}px`;
      box.style.maxWidth = `${room}px`;
      if (measure || !natural) {
        box.style.maxHeight = "none";
        natural = box.offsetHeight;
      }
      const want = Math.min(natural, fullHeight ? Infinity : search ? CAP + FILTER : CAP);
      const below = vh - EDGE - GAP - r.bottom;
      const above = r.top - GAP - EDGE;
      const up = want > below && above > below;
      const h = Math.max(0, Math.floor(Math.min(want, up ? above : below)));
      box.style.maxHeight = `${h}px`;
      const w = box.offsetWidth;
      const left = align === "end" ? r.right - w : r.left;
      box.style.left = `${Math.round(Math.max(EDGE, Math.min(left, vw - EDGE - w)))}px`;
      box.style.top = `${Math.round(up ? r.top - GAP - h : r.bottom + GAP)}px`;
      box.dataset.side = up ? "top" : "bottom";
    };
    place.current = put;
    put(true);

    const follow = () => put();
    // The list's own scrolling moves nothing; any other scroller (the page, a dialog body) moves the trigger.
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && box.contains(e.target)) return;
      put();
    };
    const ro = new ResizeObserver(follow);
    ro.observe(t);
    window.addEventListener("resize", follow);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", follow);
      window.removeEventListener("scroll", onScroll, true);
      place.current = null;
      release?.();
    };
  }, [open, search, fullHeight, align, listId]);

  // A filter that changes the rows changes the height: measure again, so a list above its trigger
  // stays against it.
  useLayoutEffect(() => {
    if (open && search) place.current?.(true);
  }, [open, search, query]);

  // The active row is kept in view by scrolling the list only (scrollIntoView would also scroll the
  // page). Pointer hover moves the highlight but never scrolls.
  const byPointer = useRef(false);
  useEffect(() => {
    if (!open || !list.current) return;
    const ul = list.current;
    const keys = search ? field.current : ul;
    if (keys && document.activeElement !== keys) keys.focus({ preventScroll: true });
    if (byPointer.current) {
      byPointer.current = false;
      return;
    }
    const row = ul.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!row) return;
    if (row.offsetTop < ul.scrollTop) ul.scrollTop = row.offsetTop - 4;
    else if (row.offsetTop + row.offsetHeight > ul.scrollTop + ul.clientHeight) ul.scrollTop = row.offsetTop + row.offsetHeight - ul.clientHeight + 4;
  }, [open, active, search]);

  const pickedIndex = () => options.findIndex((o) => o.value === value);

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      openAt(pickedIndex());
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Typed letters are type-ahead whether or not one matches, never a page shortcut.
      e.preventDefault();
      const hit = typeAhead(e.key, e.timeStamp);
      if (hit >= 0) openAt(hit);
    }
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // Like SearchField: the first Esc clears a typed filter, the next one closes.
      if (search && query) {
        setQuery("");
        setActive(step(-1, 1, options));
      } else close();
    } else if (e.key === "Tab") {
      // Back on the trigger before the browser moves on, so Tab continues from the control, not
      // from the top of the page once the list unmounts.
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => step(i, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => step(i, -1));
    } else if (search && (e.key === "Home" || e.key === "End" || e.key === " ")) {
      // The filter field keeps its caret keys and takes spaces as text.
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(step(-1, 1));
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(step(shown.length, -1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const o = shown[active];
      if (o) pick(o);
    } else if (search) {
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const hit = typeAhead(e.key, e.timeStamp);
      if (hit >= 0) setActive(hit);
    }
  };

  /* The option list: the floating layer itself, or the scroll area under the filter field. */
  const own = !search;
  const listbox = (
    <ul
      ref={list}
      id={listId}
      role="listbox"
      tabIndex={-1}
      aria-label={label}
      aria-activedescendant={own && shown[active] ? `${listId}-${active}` : undefined}
      className={own ? "sel-list sel-float" : "sel-scroll"}
      onKeyDown={own ? onListKey : undefined}
    >
      {shown.map((o, i) => (
        <li
          key={o.value}
          id={`${listId}-${i}`}
          data-index={i}
          role="option"
          aria-selected={o.value === value}
          aria-disabled={o.disabled || undefined}
          data-active={i === active}
          className="sel-option"
          onPointerMove={() => {
            if (o.disabled || i === active) return;
            byPointer.current = true;
            setActive(i);
          }}
          onClick={() => pick(o)}
        >
          {slot ? (
            <span className="sel-lead" data-glyph={slotGlyph || undefined} aria-hidden="true">
              {o.glyph ?? (o.tone ? <span className="dot" data-tone={o.tone} /> : o.icon ? <Icon name={o.icon} size={16} /> : null)}
            </span>
          ) : null}
          <span className="sel-option-label">{o.label}</span>
          {o.hint ? <span className="sel-hint num">{o.hint}</span> : null}
          <span className="sel-check" aria-hidden="true">
            {o.value === value ? <Icon name="check" size={16} /> : null}
          </span>
        </li>
      ))}
      {!shown.length ? <li className="sel-empty" role="presentation">No matches</li> : null}
    </ul>
  );

  return (
    <div ref={root} className={cx("sel", className)} data-size={size} data-open={open}>
      {ids?.labelId ? null : (
        <span id={nameId} className="sr">
          {label}
        </span>
      )}
      <button
        ref={trigger}
        id={triggerId}
        type="button"
        className="sel-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={`${ids?.labelId ?? nameId} ${valueId}`}
        aria-describedby={ids?.describedBy}
        aria-invalid={ids?.invalid || undefined}
        disabled={disabled}
        onClick={() => (open ? close() : openAt(pickedIndex()))}
        onKeyDown={onTriggerKey}
      >
        {picked?.glyph && !icon ? (
          <span className="sel-glyph" aria-hidden="true">
            {picked.glyph}
          </span>
        ) : picked?.tone ? (
          <span className="dot" data-tone={picked.tone} aria-hidden="true" />
        ) : lead ? (
          <Icon name={lead} size={16} />
        ) : null}
        <span id={valueId} className={cx("sel-value", !picked && "sel-placeholder")}>
          {picked?.label ?? placeholder}
        </span>
        <span className="sel-chev" aria-hidden="true">
          <Icon name="chevronDown" size={16} />
        </span>
      </button>

      {open
        ? createPortal(
            search ? (
              <div ref={pop} className="sel-list sel-pop sel-float">
                <div className="sel-search">
                  <Icon name="search" size={16} />
                  <input
                    ref={field}
                    type="text"
                    value={query}
                    placeholder={search}
                    aria-label={`Filter ${label.toLowerCase()}`}
                    role="combobox"
                    aria-expanded="true"
                    aria-controls={listId}
                    aria-autocomplete="list"
                    aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setActive(step(-1, 1, matching(options, e.target.value.trim().toLowerCase())));
                    }}
                    onKeyDown={onListKey}
                  />
                </div>
                {listbox}
              </div>
            ) : (
              listbox
            ),
            document.body,
          )
        : null}
    </div>
  );
}
