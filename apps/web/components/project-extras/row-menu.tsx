"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/icon";
import { cx } from "@/components/ui/cx";
import { opensUp, useOutsidePress } from "@/lib/hooks";

/* A row's "more" key: one icon button in the row's last slot, opening a short menu below it,
   right aligned. Keeps destructive actions out of the row itself. Arrows, Home and End move;
   Escape closes and returns focus to the key; Tab or a click outside closes. With `text` the key
   is a small text button instead (text only, like every labelled secondary key), for a card head
   action that picks an app first. The icon key carries no tip: its name is enough. */

export interface RowMenuItem {
  label: string;
  icon?: IconName;
  /** A leading node instead of an icon, such as a 20px AppIcon. */
  glyph?: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Red label, for an action that removes something. */
  bad?: boolean;
}

export function RowMenu({ label, items, text }: { label: string; items: RowMenuItem[]; text?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const key = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) key.current?.focus();
  }, []);
  const entries = () => [...(panel.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? [])];

  useEffect(() => {
    if (!open) return;
    // Opens upward when the room below ends first, so a menu on a low row never hides under the fold
    // of a scroll box. Before the focus, which would scroll the box to reach the menu. 6px gap, 8px
    // clear of the edge.
    const pop = panel.current;
    const anchor = root.current?.getBoundingClientRect();
    if (pop && anchor && opensUp(anchor, pop.offsetHeight + 6 + 8, pop.parentElement)) pop.dataset.flip = "up";
    entries()[0]?.focus();
  }, [open]);
  useOutsidePress(open, [root], () => close(false));

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "Tab") return close(false);
    const list = entries();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (e.key === "ArrowDown") next = (at + 1) % list.length;
    else if (e.key === "ArrowUp") next = at < 0 ? list.length - 1 : (at - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else return;
    e.preventDefault();
    list[next]?.focus();
  };

  return (
    <span ref={root} className="px-menu">
      {text ? (
        <button
          ref={key}
          type="button"
          className={cx("btn btn-sm", open && "is-open")}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={!items.length}
          onClick={() => setOpen((o) => !o)}
        >
          {text}
        </button>
      ) : (
        <button
          ref={key}
          type="button"
          className={cx("btn btn-xs btn-icon", open && "is-open")}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name="more" />
        </button>
      )}
      {open ? (
        <div ref={panel} className="px-menu-pop" role="menu" aria-label={label} onKeyDown={onKey}>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className="px-menu-item"
              data-bad={it.bad || undefined}
              disabled={it.disabled}
              onClick={() => {
                close();
                it.onSelect();
              }}
            >
              {it.glyph ? <span className="px-menu-glyph">{it.glyph}</span> : it.icon ? <Icon name={it.icon} size={16} /> : null}
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
