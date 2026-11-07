"use client";

import { useEffect, useRef, useState } from "react";
import type { Heading } from "@/lib/docs";
import { cx } from "@/components/ui/cx";

/**
 * On this page: h2 and h3 links, one line each. The section in view is marked while you scroll. A
 * heading too long for the column ends in an ellipsis, and only such a link carries its full text as
 * a tooltip.
 */
export function Toc({ headings, editHref }: { headings: Heading[]; editHref?: string }) {
  const [active, setActive] = useState(headings[0]?.id);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const ul = list.current;
    if (!ul) return;
    const mark = () => {
      for (const a of ul.querySelectorAll<HTMLAnchorElement>(".dtoc-link")) {
        if (a.scrollWidth > a.clientWidth) a.title = a.textContent ?? "";
        else a.removeAttribute("title");
      }
    };
    mark();
    const ro = new ResizeObserver(mark);
    ro.observe(ul);
    void document.fonts?.ready.then(mark);
    return () => ro.disconnect();
  }, [headings]);

  useEffect(() => {
    const els = headings.map((h) => document.getElementById(h.id)).filter((e): e is HTMLElement => !!e);
    if (!els.length) return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = els.find((el) => seen.get(el.id));
        if (first) setActive(first.id);
      },
      { rootMargin: "-72px 0px -60% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [headings]);

  return (
    <aside className="dtoc">
      <div className="dtoc-inner">
        {headings.length ? (
          <>
            <p className="dside-hd">On this page</p>
            <ul ref={list}>
              {headings.map((h) => (
                <li key={h.id}>
                  <a href={`#${h.id}`} className={cx("dtoc-link", h.depth === 3 && "is-sub", active === h.id && "is-on")}>
                    {h.text}
                  </a>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {editHref ? (
          <a href={editHref} className="dtoc-edit" target="_blank" rel="noreferrer noopener">
            Edit on GitHub
          </a>
        ) : null}
      </div>
    </aside>
  );
}
