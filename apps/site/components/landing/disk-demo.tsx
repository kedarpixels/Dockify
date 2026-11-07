"use client";

import { HatchDefs, Ico } from "./il";
import { type Frame, grow, loopStory, mix, p, useScene, useSvgId, win } from "./scene";

/* Disk: usage climbs towards the alert line, the janitor sweeps it back down and the pinned
   rollback images stay. */

const GX = 16.5;
const GW = 320;
const KEPT = 0.3;
const ALERT = 0.85;
const DK_SWEEPS = [2600, 3200, 3800];
const DK_END = 4600;

function diskStory(t: number): Frame {
  const rise = p(t, 200, 2400);
  const steps = DK_SWEEPS.map((a) => p(t, a, a + 450));
  const shrink = (steps[0]! * 9 + steps[1]! * 8 + steps[2]! * 5) / 22;
  const pct = mix(mix(52, 83, rise), 61, shrink);
  const fill = (pct / 100 - KEPT) / (1 - KEPT);
  const st: Frame["st"] = {
    clip: { x: GX + GW * KEPT, sx: grow(fill) },
    head: { x: GW * (pct / 100) },
    headBlue: { o: win(t, 2450, 4300, 200) },
    filling: { o: 1 - p(t, 2300, 2500) },
    running: { o: win(t, 2400, 4250, 200) },
    cleaned: { o: p(t, 4300, 4550) },
    near: { o: win(t, 1900, 2700, 200) },
    pin: { o: p(t, 4300, 4550) },
    pin2: { o: p(t, 4300, 4550) },
  };
  DK_SWEEPS.forEach((a, i) => (st[`j${i}`] = { o: p(t, a + 200, a + 450) }));
  return { st, tx: { pct: `${Math.round(pct)}%` } };
}

const DK_T = 7400;
const diskFrame = loopStory(DK_T, diskStory);

const JAN = ["old images", "build cache", "logs"];

export function DiskDemo() {
  const { root, b, tx } = useScene(DK_T, DK_END + 200, diskFrame);
  const id = useSvgId();
  const ax = GX + GW * ALERT;
  return (
    <div className="ld-demo">
      <svg ref={root} className="il il-md" viewBox="0 0 352 184" aria-hidden="true">
        <HatchDefs id={id} />
        <defs>
          <clipPath id={`${id}c`}>
            <rect {...b("clip")} x="0" y="64" width={GW * (1 - KEPT)} height="37" />
          </clipPath>
        </defs>
        <Ico name="server" x={16.5} y={8} />
        <text className="il-t il-sm il-t-mute" x="36" y="19">
          disk
        </text>
        <text {...b("filling")} className="il-t il-sm il-t-mute" x="336" y="19" textAnchor="end">
          filling
        </text>
        <text {...b("running")} className="il-t il-sm il-pill-t" x="336" y="19" textAnchor="end">
          janitor running
        </text>
        <g {...b("cleaned")}>
          <Ico name="checkCircle" x={270} y={9} size={12} blue />
          <text className="il-t il-sm il-pill-t" x="336" y="19" textAnchor="end">
            cleaned
          </text>
        </g>
        <text className="il-pixel il-big" x="16.5" y="51">
          <tspan {...tx("pct")} />
        </text>
        <rect className="il-box" x={GX} y="64.5" width={GW} height="36" />
        <rect x={GX + 0.5} y="65" width={GW * KEPT - 0.5} height="35" fill={`url(#${id}b)`} />
        <line className="il-blue-line" x1={GX + GW * KEPT} y1="64.5" x2={GX + GW * KEPT} y2="100.5" />
        <rect clipPath={`url(#${id}c)`} x={GX + GW * KEPT} y="65" width={GW * (1 - KEPT)} height="35" fill={`url(#${id}h)`} />
        <g {...b("head")}>
          <line className="il-ink-line" x1={GX} y1="60" x2={GX} y2="105" />
          <line {...b("headBlue")} className="il-blue-line il-w2" x1={GX} y1="60" x2={GX} y2="105" />
        </g>
        {/* Alert line at 85% */}
        <line className="il-warn-line" x1={ax} y1="56" x2={ax} y2="109" />
        <text className="il-t il-xs il-warn-t" x={ax} y="50" textAnchor="middle">
          alert 85%
        </text>
        <rect {...b("near")} className="il-warn-fill" x={ax - 2} y="107" width="4" height="4" />

        {/* The rollback images are pinned and never swept */}
        <Ico name="lock" x={GX} y={108} size={12} />
        <g {...b("pin")}>
          <Ico name="lock" x={GX} y={108} size={12} blue />
        </g>
        <text className="il-t il-xs il-t-mute" x={GX + 17} y="117.5">
          pinned
        </text>

        {JAN.map((j, i) => {
          const x = GX + (i % 2) * 168;
          const y = 148 + Math.floor(i / 2) * 22;
          return (
            <g key={j}>
              <circle className="il-handle" cx={x + 6} cy={y - 4} r="5.5" />
              <g {...b(`j${i}`)}>
                <Ico name="checkCircle" x={x} y={y - 10} size={12} blue />
              </g>
              <text className="il-t il-sm" x={x + 18} y={y}>
                {j}
              </text>
            </g>
          );
        })}
        <g>
          <Ico name="lock" x={184.5} y={160} size={12} />
          <g {...b("pin2")}>
            <Ico name="lock" x={184.5} y={160} size={12} blue />
          </g>
          <text className="il-t il-sm" x={202.5} y="170">
            rollback images
          </text>
          <text className="il-t il-xs il-pill-t" x={336.5} y="170" textAnchor="end">
            kept
          </text>
        </g>
      </svg>
    </div>
  );
}
