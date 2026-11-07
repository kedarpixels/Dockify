"use client";

import { HatchDefs, Ico } from "./il";
import { along, type Box, type Frame, lengthOf, loopStory, mix, p, type Pt, useScene, useSvgId, win } from "./scene";

/* Backups: the dump is encrypted, leaves the box for the bucket, then is restored for real into
   a throwaway database. */

const SRC: Box = [12.5, 16.5, 120, 72];
const BKT: Box = [220.5, 16.5, 120, 72];
const SCR: Box = [12.5, 120.5, 136, 32];
const LANE = 64.5;
const BLOCK = { w: 36, h: 22, x0: 72.5, x1: 280.5 };
const BK_ROUTE: Pt[] = [
  [320.5, 98.5],
  [320.5, 136.5],
  [SCR[0] + SCR[2], 136.5],
];
const BK_LEN = lengthOf(BK_ROUTE);
const BK_END = 4300;

function backupStory(t: number): Frame {
  const [cx, cy] = along(BK_ROUTE, BK_LEN * p(t, 2600, 3600));
  return {
    st: {
      block: { x: (BLOCK.x1 - BLOCK.x0) * p(t, 1100, 2300), o: p(t, 200, 500) },
      lock: { o: p(t, 600, 900), y: mix(2, 0, p(t, 600, 900)) },
      dumped: { o: win(t, 200, 700, 200) },
      enc: { o: p(t, 700, 1000) },
      sent: { o: p(t, 2250, 2550) },
      bucket: { o: p(t, 2200, 2500) },
      copy: { x: cx, y: cy, o: p(t, 2500, 2700) * (1 - p(t, 3500, 3700)) },
      scratch: { o: p(t, 3500, 3800) },
      scratchOk: { o: p(t, 3600, 3900) },
      ok: { o: p(t, 3900, 4250), x: mix(-4, 0, p(t, 3900, 4250)) },
    },
  };
}

function HeadBox({ box, icon, label }: { box: Box; icon: "database" | "archive"; label: string }) {
  const [x, y, w, h] = box;
  return (
    <>
      <rect className="il-box" x={x} y={y} width={w} height={h} />
      <Ico name={icon} x={x + 10} y={y + 10} />
      <text className="il-t il-sm" x={x + 30} y={y + 21}>
        {label}
      </text>
    </>
  );
}

const BK_T = 7000;
const backupFrame = loopStory(BK_T, backupStory);

export function BackupDemo() {
  const { root, b } = useScene(BK_T, BK_END + 200, backupFrame);
  const id = useSvgId();
  const [sx, sy, sw, sh] = SCR;
  return (
    <div className="ld-demo">
      <svg ref={root} className="il il-md" viewBox="0 0 352 184" aria-hidden="true">
        <HatchDefs id={id} />
        <HeadBox box={SRC} icon="database" label="horseai-db" />
        <HeadBox box={BKT} icon="archive" label="bucket" />
        <rect {...b("bucket")} className="il-box-blue" x={BKT[0]} y={BKT[1]} width={BKT[2]} height={BKT[3]} />
        <line className="il-guide" x1={SRC[0] + SRC[2]} y1={LANE} x2={BKT[0]} y2={LANE} />

        <text {...b("dumped")} className="il-t il-xs il-t-mute" x={SRC[0]} y="106">
          dumped
        </text>
        <g {...b("enc")}>
          <Ico name="lock" x={SRC[0]} y={96.5} size={12} blue />
          <text className="il-t il-xs il-pill-t" x={SRC[0] + 17} y="106">
            encrypted
          </text>
        </g>
        <g {...b("sent")}>
          <Ico name="checkCircle" x={BKT[0]} y={96.5} size={12} blue />
          <text className="il-t il-xs il-pill-t" x={BKT[0] + 17} y="106">
            off the box
          </text>
        </g>

        {/* The dump, locked before it leaves */}
        <g {...b("block")}>
          <rect className="il-box" x={BLOCK.x0 - BLOCK.w / 2} y={LANE - BLOCK.h / 2} width={BLOCK.w} height={BLOCK.h} />
          <rect x={BLOCK.x0 - BLOCK.w / 2 + 0.5} y={LANE - BLOCK.h / 2 + 0.5} width={BLOCK.w - 1} height={BLOCK.h - 1} fill={`url(#${id}h)`} />
          <g {...b("lock")}>
            <rect className="il-mask" x={BLOCK.x0 - 8} y={LANE - 8} width="16" height="16" />
            <Ico name="lock" x={BLOCK.x0 - 6} y={LANE - 6} size={12} blue />
          </g>
        </g>

        {/* Restore test into a throwaway database */}
        <path className="il-guide" d={`M320.5 88.5L${BK_ROUTE.map((q) => q.join(" ")).join("L")}`} />
        <rect className="il-box il-dash" x={sx} y={sy} width={sw} height={sh} />
        <rect {...b("scratch")} className="il-box" x={sx} y={sy} width={sw} height={sh} />
        <Ico name="database" x={sx + 10} y={sy + 9} />
        <text className="il-t il-sm" x={sx + 30} y={sy + 20}>
          throwaway db
        </text>
        <g {...b("scratchOk")}>
          <rect className="il-box-blue" x={sx} y={sy} width={sw} height={sh} />
          <Ico name="checkCircle" x={sx + sw - 22} y={sy + 10} size={12} blue />
        </g>
        <g {...b("copy")}>
          <rect className="il-box" x="-10" y="-7" width="20" height="14" />
          <rect x="-9.5" y="-6.5" width="19" height="13" fill={`url(#${id}b)`} />
        </g>
        <g {...b("ok")}>
          <Ico name="checkCircle" x={12.5} y={161} blue />
          <text className="il-t il-strong" x="33" y="172">
            restore test passed
          </text>
        </g>
        <text className="il-t il-xs il-t-faint" x="340.5" y="172" textAnchor="end">
          on a schedule
        </text>
      </svg>
    </div>
  );
}
