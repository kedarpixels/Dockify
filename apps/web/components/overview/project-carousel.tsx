"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CardTitle } from "@/components/card-title";
import { Icon } from "@/components/icon";
import { ProjectCard } from "@/components/projects/project-card";
import { Empty } from "@/components/ui/empty";
import type { ProjectCard as ProjectSummary } from "@/lib/derive";

/**
 * The Overview's project strip: the Projects page's card (carousel variant), three to a view,
 * snapping, with arrow keys in the head while it can scroll and the way to the full list beside them.
 */
export function ProjectCarousel({ projects, now, empty }: { projects: ProjectSummary[]; now: number; empty?: string }) {
  const track = useRef<HTMLDivElement>(null);
  const prevKey = useRef<HTMLButtonElement>(null);
  const nextKey = useRef<HTMLButtonElement>(null);
  const viewAll = useRef<HTMLAnchorElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const measure = useCallback(() => {
    const el = track.current;
    if (!el) return;
    const start = el.scrollLeft <= 2;
    const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
    // A key that turns disabled under focus would drop focus to the page; hand it to the other key,
    // or to View all projects when every project fits and both keys go.
    const onKey = document.activeElement === prevKey.current || document.activeElement === nextKey.current;
    if (start && end && onKey) viewAll.current?.focus();
    else if (start && document.activeElement === prevKey.current) nextKey.current?.focus();
    else if (end && document.activeElement === nextKey.current) prevKey.current?.focus();
    setEdges((e) => (e.start === start && e.end === end ? e : { start, end }));
  }, []);

  // Track size changes (window resize, sidebar fold) and card count changes both move the edges.
  useEffect(() => {
    const el = track.current;
    measure();
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, projects.length]);

  const slide = (dir: 1 | -1) => {
    const el = track.current;
    const cell = el?.querySelector<HTMLElement>(".pj-cell");
    if (!el || !cell) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: dir * (cell.offsetWidth + 1), behavior: reduced ? "auto" : "smooth" });
  };

  // The arrows show only while the strip can scroll; at either end the key that cannot move is disabled.
  const movable = projects.length > 0 && !(edges.start && edges.end);

  return (
    <section aria-labelledby="proj-title" className="card ovp">
      <div className="card-hd ovp-hd-row">
        {/* The counts are the page lead's; the sub says what each card holds. */}
        <CardTitle id="proj-title" icon="folder" title="Projects" sub="Health, last deploy" />
        {movable ? (
          <span className="ovp-arrows">
            <button ref={prevKey} type="button" className="btn btn-sm btn-icon" onClick={() => slide(-1)} disabled={edges.start} aria-label="Previous projects">
              <Icon name="chevronLeft" />
            </button>
            <button ref={nextKey} type="button" className="btn btn-sm btn-icon" onClick={() => slide(1)} disabled={edges.end} aria-label="Next projects">
              <Icon name="chevronRight" />
            </button>
          </span>
        ) : null}
        <Link ref={viewAll} href="/projects" className="btn btn-sm">
          View all projects
        </Link>
      </div>
      {projects.length ? (
        <div className="ovp-mask" data-start={edges.start} data-end={edges.end}>
          <div ref={track} className="ovp-track" onScroll={measure}>
            {projects.map((p) => (
              <ProjectCard key={p.slug} p={p} now={now} variant="carousel" />
            ))}
          </div>
        </div>
      ) : (
        <Empty icon="folder" title="No projects yet" body={empty ?? "Create a project to group its apps and domains. It shows up here."} />
      )}
    </section>
  );
}
