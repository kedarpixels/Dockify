"use client";

import { useEffect, useId, useRef } from "react";
import { Icon } from "@/components/icon";
import { safeNext } from "@/components/auth/util";
import { useSessionEnded } from "@/lib/hooks";
import { openLayer } from "@/lib/modal";
import { IconTile } from "./icon-tile";

/*
 * The full-screen notice shown once a client fetch learns the session ended (`apiFetch` in
 * lib/hooks.ts). Mounted once by the console layout. It sits above every dialog, so nothing else
 * answers keys or focus while it shows; Sign in is a full navigation, so the console starts fresh.
 */
export function SessionExpired() {
  const ended = useSessionEnded();
  const id = useId();
  const action = useRef<HTMLAnchorElement>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ended) return;
    const release = openLayer(id, root.current);
    action.current?.focus();
    return release;
  }, [ended, id]);

  if (!ended) return null;

  const next = safeNext(`${location.pathname}${location.search}`);
  const href = next === "/" ? "/login?reason=expired" : `/login?reason=expired&next=${encodeURIComponent(next)}`;

  return (
    <div
      ref={root}
      className="session-ended"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={`${id}-t`}
      aria-describedby={`${id}-l`}
      onKeyDown={(e) => {
        // Sign in is the only control, so Tab stays on it.
        if (e.key === "Tab") {
          e.preventDefault();
          action.current?.focus();
        }
      }}
    >
      <div className="session-ended-card">
        <IconTile size="lg">
          <Icon name="clock" />
        </IconTile>
        <div>
          <h1 id={`${id}-t`} className="shead-title">
            Session ended
          </h1>
          <p id={`${id}-l`} className="shead-lead">
            Your session ended. Sign in again to continue.
          </p>
        </div>
        <a ref={action} href={href} className="btn btn-primary">
          <Icon name="lockOpen" />
          Sign in
        </a>
      </div>
    </div>
  );
}
