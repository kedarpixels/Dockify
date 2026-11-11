"use client";

import { useEffect, useRef } from "react";
import { Icon, type IconName } from "@/components/icon";
import { IconTile } from "@/components/ui/icon-tile";

/** `announce` moves focus to the title, for steps that replace the card in place. */
export function AuthHead({
  icon,
  step,
  title,
  lead,
  announce,
}: {
  icon: IconName;
  /** [current, total], for setup and invites. */
  step?: [number, number];
  title: string;
  lead?: React.ReactNode;
  announce?: boolean;
}) {
  const h = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (announce) h.current?.focus();
  }, [announce]);

  return (
    <header className="auth-head">
      {step ? (
        <div className="auth-steps">
          <span className="auth-steps-bars" aria-hidden="true">
            {Array.from({ length: step[1] }, (_, i) => (
              <span key={i} data-on={i < step[0] ? "" : undefined} />
            ))}
          </span>
          <span className="auth-steps-label num">
            Step {step[0]} of {step[1]}
          </span>
        </div>
      ) : null}
      <div className="auth-head-top">
        <IconTile size="lg">
          <Icon name={icon} />
        </IconTile>
        <h1 ref={h} className="shead-title auth-title" tabIndex={announce ? -1 : undefined}>
          {title}
        </h1>
      </div>
      {lead ? <p className="shead-lead">{lead}</p> : null}
    </header>
  );
}
