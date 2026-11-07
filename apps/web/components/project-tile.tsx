"use client";

import { useId } from "react";

const SIZES = { sm: 20, md: 28, lg: 40 } as const;

/** A two-tone folder: a deeper back panel with its tab, and a lighter front with a lit edge. */
export function ProjectTile({ size = "sm" }: { size?: keyof typeof SIZES }) {
  const id = useId();
  const px = SIZES[size];
  return (
    <svg className="folder" width={px} height={px} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--folder-back-top)" />
          <stop offset="1" stopColor="var(--folder-back-bottom)" />
        </linearGradient>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--folder-front-top)" />
          <stop offset="1" stopColor="var(--folder-front-bottom)" />
        </linearGradient>
      </defs>
      <path d="M2.5 6.25A2.25 2.25 0 0 1 4.75 4h4.1c.6 0 1.17.24 1.6.66L11.9 6.1h7.35a2.25 2.25 0 0 1 2.25 2.25V18a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2z" fill={`url(#${id}b)`} />
      <path d="M2.5 10.25A2.25 2.25 0 0 1 4.75 8h14.5a2.25 2.25 0 0 1 2.25 2.25V18a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2z" fill={`url(#${id}f)`} />
      <path d="M4.75 8.6h14.5" stroke="rgb(255 255 255 / 0.45)" strokeWidth="0.9" strokeLinecap="round" />
    </svg>
  );
}
