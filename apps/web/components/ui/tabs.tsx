"use client";

import { useMemo, useRef } from "react";
import { SegThumb, segOption, useSegThumb } from "./segmented";
import { Select } from "./select";

export interface TabItem<T extends string> {
  value: T;
  label: string;
  /** How many things the section holds, read as its own phrase ("Apps, 6"). */
  count?: number;
}

const tabId = (id: string, value: string) => `${id}-tab-${value}`;
const panelId = (id: string) => `${id}-panel`;

// A tab list with manual activation: arrows move the focus only, so arrowing past a section never
// loads it. Memoise `tabs` in the caller: the thumb measures again whenever the tab values change.
export function Tabs<T extends string>({
  id,
  label,
  value,
  onChange,
  tabs,
}: {
  /** Ties the tabs to their TabPanel. */
  id: string;
  label: string;
  value: T;
  onChange: (next: T) => void;
  tabs: TabItem<T>[];
}) {
  const track = useRef<HTMLDivElement>(null);
  const thumb = useSegThumb(track, value, JSON.stringify(tabs.map((t) => t.value)));
  const options = useMemo(() => tabs.map((t) => ({ value: t.value, label: t.label, hint: t.count?.toLocaleString("en-US") })), [tabs]);

  const move = (e: React.KeyboardEvent, i: number) => {
    const n = tabs.length;
    const to = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    segOption(track.current, tabs[to]!.value)?.focus();
  };

  return (
    <div className="tabs-wrap" data-many={tabs.length > 6 || undefined}>
      <div className="tabs">
        <div ref={track} className="seg2 tabs-list" role="tablist" aria-label={label}>
          <SegThumb thumb={thumb} />
          {tabs.map((t, i) => {
            const open = t.value === value;
            return (
              <button
                key={t.value}
                id={tabId(id, t.value)}
                type="button"
                role="tab"
                aria-selected={open}
                // Only the open section is in the page, so only its tab points at a panel.
                aria-controls={open ? panelId(id) : undefined}
                tabIndex={open ? 0 : -1}
                data-value={t.value}
                className="seg2-opt"
                onClick={() => onChange(t.value)}
                onKeyDown={(e) => move(e, i)}
              >
                {t.label}
                {t.count !== undefined ? (
                  <>
                    <span className="sr">, </span>
                    <span className="seg2-count num">{t.count.toLocaleString("en-US")}</span>
                  </>
                ) : null}
              </button>
            );
          })}
        </div>
        <Select className="tabs-sel" label={label} value={value} onChange={onChange} options={options} />
      </div>
    </div>
  );
}

export function TabPanel({ id, value, className, children }: { id: string; value: string; className?: string; children: React.ReactNode }) {
  return (
    <div id={panelId(id)} role="tabpanel" aria-labelledby={tabId(id, value)} className={className}>
      {children}
    </div>
  );
}
