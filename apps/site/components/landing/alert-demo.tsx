"use client";

import type { ReactNode } from "react";
import { Handles, Ico, IconBox } from "./il";
import { type Frame, loopStory, mix, p, useScene, win } from "./scene";

/* Alerts: an app starts crash looping and the notification names it. */

const AL_END = 3400;

function alertStory(t: number): Frame {
  const st: Frame["st"] = {
    running: { o: 1 - p(t, 900, 1100) },
    unhealthy: { o: win(t, 950, 1300, 150) },
    restarting: { o: win(t, 1300, 2450, 150) },
    loop: { o: p(t, 2500, 2700) },
    bad: { o: p(t, 950, 1250) },
    toast: { x: mix(14, 0, p(t, 2900, 3350)), o: p(t, 2900, 3250) },
  };
  [1300, 1700, 2100, 2500].forEach((a, i) => (st[`r${i}`] = { o: p(t, a, a + 160) }));
  return { st };
}

const AL_T = 6200;
const alertFrame = loopStory(AL_T, alertStory);

function AppRow({ y, name, quiet, children }: { y: number; name: string; quiet?: boolean; children?: ReactNode }) {
  return (
    <g className={quiet ? "il-quiet" : undefined}>
      <rect className="il-box" x="16.5" y={y} width="320" height="40" />
      <IconBox name="cloud" x={24.5} y={y + 8} size={24} />
      <text className="il-t il-strong" x="58.5" y={y + 24}>
        {name}
      </text>
      {children}
    </g>
  );
}

export function AlertDemo() {
  const { root, b } = useScene(AL_T, AL_END + 200, alertFrame);
  return (
    <div className="ld-demo">
      <svg ref={root} className="il il-md" viewBox="0 0 352 184" aria-hidden="true">
        <AppRow y={10.5} name="horseai-api">
          {[0, 1, 2, 3].map((i) => (
            <g key={i}>
              <rect className="il-handle" x={156.5 + i * 14} y="26.5" width="8" height="8" />
              <rect {...b(`r${i}`)} className="il-warn-fill" x={156.5 + i * 14} y="26.5" width="8" height="8" />
            </g>
          ))}
          <text {...b("running")} className="il-t il-sm il-t-mute" x="324" y="34.5" textAnchor="end">
            running
          </text>
          <text {...b("unhealthy")} className="il-t il-sm il-warn-t" x="324" y="34.5" textAnchor="end">
            unhealthy
          </text>
          <text {...b("restarting")} className="il-t il-sm il-warn-t" x="324" y="34.5" textAnchor="end">
            restarting
          </text>
          <text {...b("loop")} className="il-t il-sm il-warn-t" x="324" y="34.5" textAnchor="end">
            crash loop
          </text>
        </AppRow>
        <AppRow y={58.5} name="horseai-web" quiet>
          <text className="il-t il-sm il-t-mute" x="324" y="82.5" textAnchor="end">
            running
          </text>
        </AppRow>
        <g {...b("toast")}>
          <rect className="il-box il-toast" x="16.5" y="108.5" width="320" height="66" />
          <Handles x0={16.5} y0={108.5} x1={336.5} y1={174.5} />
          <circle className="il-warn-soft" cx="36.5" cy="128.5" r="9" />
          <rect className="il-warn-fill" x="35.75" y="123.5" width="1.5" height="6" />
          <rect className="il-warn-fill" x="35.75" y="131.5" width="1.5" height="1.5" />
          <text className="il-t il-strong" x="54" y="132.5">
            horseai-api is crash looping
          </text>
          <text className="il-t il-xs il-pill-t" x="324" y="132.5" textAnchor="end">
            View logs
          </text>
          <text className="il-t il-xs il-t-mute" x="54" y="150">
            Restarted 4 times in 10 min.
          </text>
          <Ico name="webhook" x={54} y={157.5} size={12} />
          <text className="il-t il-xs il-t-faint" x="71" y="167">
            sent to Discord
          </text>
        </g>
      </svg>
    </div>
  );
}
