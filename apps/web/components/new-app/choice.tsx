"use client";

import { useRef } from "react";
import { Icon, type IconName } from "@/components/icon";
import { IconTile } from "@/components/ui/icon-tile";
import { cx } from "@/components/ui/cx";

/* `ActionCards` are buttons that move the flow on; `ChoiceCards` are one radio group with a roving tab stop. */

export interface CardOption<T extends string> {
  value: T;
  icon: IconName;
  title: string;
  body: string;
  disabled?: boolean;
}

function arrowTo(e: React.KeyboardEvent, count: number, from: number, usable: (i: number) => boolean): number | null {
  const by = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
  let i: number;
  if (e.key === "Home") i = 0;
  else if (e.key === "End") i = count - 1;
  else if (by) i = (from + by + count) % count;
  else return null;
  e.preventDefault();
  // Skip disabled cards in the direction of travel.
  for (let n = 0; n < count && !usable(i); n++) i = (i + (by || 1) + count) % count;
  return usable(i) ? i : null;
}

function CardInner({ icon, title, body, lead }: { icon: IconName; title: string; body: string; lead: "md" | "lg" }) {
  return (
    <>
      <IconTile size={lead}>
        <Icon name={icon} size={lead === "lg" ? 20 : 16} />
      </IconTile>
      <span className="two">
        <span className="two-main">{title}</span>
        <span className="two-sub">{body}</span>
      </span>
    </>
  );
}

export function ActionCards<T extends string>({ label, options, onPick, last }: { label: string; options: CardOption<T>[]; onPick: (v: T) => void; last?: T | null }) {
  const list = useRef<HTMLUListElement>(null);
  const focusAt = (i: number) => list.current?.querySelectorAll<HTMLButtonElement>("button")[i]?.focus();
  return (
    <ul ref={list} className="na-cards" data-layout="grid" aria-label={label}>
      {options.map((o, i) => (
        <li key={o.value}>
          <button
            type="button"
            className="na-card tile-host"
            data-autofocus={(last ? o.value === last : i === 0) || undefined}
            onClick={() => onPick(o.value)}
            onKeyDown={(e) => {
              const to = arrowTo(e, options.length, i, () => true);
              if (to !== null) focusAt(to);
            }}
          >
            <CardInner icon={o.icon} title={o.title} body={o.body} lead="lg" />
            <Icon name="chevronRight" className="na-card-go" />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ChoiceCards<T extends string>({
  label,
  options,
  value,
  onChange,
  layout = "row",
  id,
}: {
  label: string;
  options: CardOption<T>[];
  value: T;
  onChange: (v: T) => void;
  layout?: "row" | "stack";
  id?: string;
}) {
  const group = useRef<HTMLDivElement>(null);
  const at = options.findIndex((o) => o.value === value);
  const pick = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    group.current?.querySelectorAll<HTMLButtonElement>("[role=radio]")[i]?.focus();
  };
  return (
    <div ref={group} id={id} role="radiogroup" aria-label={label} className="na-cards" data-layout={layout}>
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={o.disabled || undefined}
            tabIndex={checked || (at < 0 && i === 0) ? 0 : -1}
            className={cx("na-card na-choice tile-host", checked && "surface-key-picked")}
            data-picked={checked || undefined}
            onClick={() => pick(i)}
            onKeyDown={(e) => {
              const to = arrowTo(e, options.length, i, (n) => !options[n]?.disabled);
              if (to !== null) pick(to);
            }}
          >
            <CardInner icon={o.icon} title={o.title} body={o.body} lead="md" />
            {/* The shared radio mark (foundation .radio); a span cannot be :checked, so data-on draws the dot. */}
            <span className="radio na-radio" data-on={checked || undefined} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
