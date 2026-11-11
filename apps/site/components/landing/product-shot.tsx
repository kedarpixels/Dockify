"use client";

import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon, type IconName } from "@/components/icon";
import { ShotPicture } from "./shot-picture";

/* Captions say exactly what each screenshot shows, using the values that are in it. */
const VIEWS: { id: string; label: string; icon: IconName; caption: string; alt: string }[] = [
  {
    id: "overview",
    label: "Overview",
    icon: "overview",
    caption: "Every project, its status and its last deploy, on one screen.",
    alt: "Dockify overview: health, deploy and failure rate cards above a row of projects with their last deployment and running apps.",
  },
  {
    id: "deploy",
    label: "Deploy",
    icon: "deploy",
    caption: "A build streaming live, step by step, up to the health check.",
    alt: "A Dockify deployment in progress: steps from queued to health check beside a streaming build log.",
  },
  {
    id: "server",
    label: "Server",
    icon: "server",
    caption: "Disk at 61%, with 38 GB that the cleanup can reclaim.",
    alt: "Dockify server page: CPU, memory, disk and network cards above a disk breakdown with reclaimable space.",
  },
  {
    id: "app",
    label: "App",
    icon: "box",
    caption: "One app: replicas, ports, limits and its health check.",
    alt: "A Dockify app page with usage, the latest deployment and runtime details.",
  },
];

/** Only the screen on show is in the page; pointing at an option loads its screen ahead of the click. */
export function ProductShot() {
  const [on, setOn] = useState(0);
  const [loaded, setLoaded] = useState<number[]>([0]);
  const opts = useRef<(HTMLButtonElement | null)[]>([]);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);

  const warm = (i: number) => setLoaded((l) => (l.includes(i) ? l : [...l, i]));
  const pick = (i: number) => {
    warm(i);
    setOn(i);
  };

  useLayoutEffect(() => {
    const place = () => {
      const b = opts.current[on];
      if (b) setThumb({ x: b.offsetLeft, w: b.offsetWidth });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [on]);

  const onKey = (e: KeyboardEvent) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (on + d + VIEWS.length) % VIEWS.length;
    pick(n);
    opts.current[n]?.focus();
  };

  const view = VIEWS[on] ?? VIEWS[0]!;

  return (
    <section className="ld-shot" aria-labelledby="ld-shot-title">
      <div className="ld-shot-hd">
        <div>
          <h2 id="ld-shot-title" className="ld-h2">
            The dashboard, as it ships.
          </h2>
          <p className="ld-lead">Real screens from the dashboard build, filled with demo data.</p>
        </div>
        <div className="seg2 ld-seg" role="radiogroup" aria-label="Screen" onKeyDown={onKey}>
          {thumb ? <span className="seg2-thumb" aria-hidden="true" style={{ transform: `translateX(${thumb.x}px)`, width: thumb.w }} /> : null}
          {VIEWS.map((v, i) => (
            <button
              key={v.id}
              ref={(el) => {
                opts.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={i === on}
              tabIndex={i === on ? 0 : -1}
              className="seg2-opt"
              onClick={() => pick(i)}
              onPointerEnter={() => warm(i)}
              onFocus={() => warm(i)}
            >
              <Icon name={v.icon} size={14} />
              <span className="ld-seg-label">{v.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="ld-frame">
        <div className="ld-frame-bar" aria-hidden="true">
          <span className="ld-frame-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="ld-frame-url">
            <Icon name="lock" size={12} />
            dockify.example.com
          </span>
        </div>
        <div className="ld-frame-view">
          {VIEWS.map((v, i) =>
            loaded.includes(i) ? (
              <div key={v.id} className="ld-frame-shot" data-on={i === on || undefined} aria-hidden={i !== on}>
                <ShotPicture name={v.id} alt={v.alt} />
              </div>
            ) : null,
          )}
        </div>
      </div>
      <p className="ld-frame-cap" aria-live="polite">
        {view.caption}
      </p>
    </section>
  );
}
