"use client";

import { Diamond, Handles, HatchDefs, Ico, IconBox } from "./il";
import { type Box, type Frame, grow, lin, loopStory, mix, p, useScene, useSvgId, win } from "./scene";

/* The large bento cell: a new version builds next to the live one, fails its health checks and is
   removed, while traffic never leaves the live version. A wide and a narrow layout of one story. */

type FailLayout = {
  w: number;
  h: number;
  /** Left column as x and width, then the edge, git and health boxes as y and height. */
  col: [number, number];
  edge: [number, number];
  git: [number, number];
  health: [number, number];
  v40: Box;
  v41: Box;
  well: Box;
  /** Size of the icon square in the version boxes and its inset. */
  tile: [number, number];
  ticks: number[];
  checkLabels: boolean;
  track: [number, number, number];
  pill: [number, number, number, string];
  push: string;
  domain: boolean;
};

const WIDE: FailLayout = {
  w: 720,
  h: 264,
  col: [20.5, 112],
  edge: [52.5, 32],
  git: [124.5, 32],
  health: [180.5, 24],
  v40: [470.5, 36.5, 230, 64],
  v41: [470.5, 120.5, 230, 92],
  well: [482.5, 184.5, 206, 14],
  tile: [28, 12],
  ticks: [230.5, 301.5, 372.5],
  checkLabels: true,
  track: [20.5, 700.5, 236.5],
  pill: [301.5, 104.5, 136, "traffic never moved"],
  push: "git push",
  domain: true,
};

const NARROW: FailLayout = {
  w: 352,
  h: 236,
  col: [12.5, 80],
  edge: [20.5, 28],
  git: [92.5, 28],
  health: [150.5, 24],
  v40: [196.5, 12.5, 144, 44],
  v41: [196.5, 84.5, 144, 88],
  well: [206.5, 144.5, 124, 14],
  tile: [24, 10],
  ticks: [116.5, 144.5, 172.5],
  checkLabels: false,
  track: [12.5, 340.5, 204.5],
  pill: [144.5, 70.5, 96, "no downtime"],
  push: "push",
  domain: false,
};

const FAIL_END = 5000;
const FAIL_T = 8000;
const FAIL_KEYS = [
  { t: 900, label: "build" },
  { t: 2800, label: "health" },
  { t: 4300, label: "rolled back" },
];

const mid = (y: number, h: number) => y + h / 2;
const colRight = (L: FailLayout) => L.col[0] + L.col[1];
/** Where time t sits on the timeline track. */
const trackX = (L: FailLayout, t: number) => L.track[0] + ((L.track[1] - L.track[0]) * t) / FAIL_END;

function failStory(L: FailLayout) {
  const liveLen = L.v40[0] - colRight(L);
  const newLen = L.v41[0] - colRight(L);
  return (t: number): Frame => {
    const st: Frame["st"] = {};
    /* The push arrives and the new version builds next to the live one */
    st.push = { x: newLen * lin(t, 300, 800), o: win(t, 300, 740, 80) };
    st.v41 = { o: p(t, 600, 900) * (1 - 0.55 * p(t, 4300, 4800)) };
    st.v41solid = { o: 1 - p(t, 4300, 4800) };
    st.sel = { o: win(t, 700, 2700, 250) };
    const build = lin(t, 900, 2700);
    st.clip = { x: L.well[0], sx: grow(build) };
    st.edgeln = { x: L.well[0] + L.well[2] * build, o: win(t, 900, 2550, 150) };
    st.building = { o: win(t, 900, 2650, 200) };
    st.checking = { o: win(t, 2750, 4200, 200) };
    st.removed = { o: p(t, 4300, 4600) };
    /* Three health checks, each answered with a 503 */
    for (let k = 0; k < 3; k++) {
      const a = 2800 + k * 450;
      st[`pr${k}`] = { x: newLen * lin(t, a, a + 380), o: win(t, a, a + 300, 80) };
      st[`tk${k}`] = { o: p(t, a + 260, a + 380) };
    }
    st.pill = { y: mix(4, 0, p(t, 4500, 4900)), o: p(t, 4500, 4900) };
    /* Traffic keeps reaching v40 the whole time */
    for (let i = 0; i < 4; i++) {
      const u = ((t + (i * 2000) / 4) % 2000) / 2000;
      const o = Math.min(1, u / 0.08) * (1 - Math.max(0, (u - 0.88) / 0.12));
      st[`d${i}`] = { x: liveLen * u, o };
    }
    const ph = p(t, 0, 250);
    st.ph = { x: trackX(L, Math.min(t, FAIL_END)), o: ph };
    st.prog = { x: L.track[0], sx: grow(Math.min(1, t / FAIL_END)), o: ph };
    FAIL_KEYS.forEach((k, i) => (st[`k${i}`] = { o: p(t, k.t - 60, k.t + 140) }));
    return { st };
  };
}

const traffic = (k: string) => /^d\d$/.test(k);
const FAIL_WIDE = loopStory(FAIL_T, failStory(WIDE), traffic);
const FAIL_NARROW = loopStory(FAIL_T, failStory(NARROW), traffic);

function SideBox({ x, w, y, h, icon, label }: { x: number; w: number; y: number; h: number; icon: "globe" | "github" | "activity"; label: string }) {
  const c = mid(y, h);
  return (
    <>
      <rect className="il-box" x={x} y={y} width={w} height={h} />
      <Ico name={icon} x={x + 9} y={c - 7} />
      <text className="il-t il-sm" x={x + 29} y={c + 4}>
        {label}
      </text>
    </>
  );
}

function FailScene({ L, frame, className }: { L: FailLayout; frame: (t: number) => Frame; className: string }) {
  const { root, b } = useScene(FAIL_T, FAIL_END + 200, frame);
  const id = useSvgId();
  const [cx, cw] = L.col;
  const right = colRight(L);
  const [ax, ay, aw, ah] = L.v40;
  const [bx, by, bw, bh] = L.v41;
  const [wx, wy, ww, wh] = L.well;
  const [ts, ti] = L.tile;
  const [t0, t1, ty] = L.track;
  const [px, py, pw, pt] = L.pill;
  const liveY = mid(...L.edge);
  const pushY = mid(...L.git);
  const probeY = mid(...L.health);
  const gap = L.ticks[1]! - L.ticks[0]!;
  const maskW = Math.min(32, gap - 4);
  const nameY = by + ti + ts / 2 - 1;
  return (
    <svg ref={root} className={`il ${className}`} viewBox={`0 0 ${L.w} ${L.h}`} aria-hidden="true">
      <HatchDefs id={id} />
      <defs>
        <clipPath id={`${id}c`}>
          <rect {...b("clip")} x="0" y={wy} width={ww} height={wh} />
        </clipPath>
      </defs>

      <SideBox x={cx} w={cw} y={L.edge[0]} h={L.edge[1]} icon="globe" label="edge" />
      <SideBox x={cx} w={cw} y={L.git[0]} h={L.git[1]} icon="github" label={L.push} />
      <SideBox x={cx} w={cw} y={L.health[0]} h={L.health[1]} icon="activity" label="/health" />

      <line className="il-line" x1={right} y1={liveY} x2={ax} y2={liveY} />
      <line className="il-guide" x1={right} y1={pushY} x2={bx} y2={pushY} />
      <line className="il-guide" x1={right} y1={probeY} x2={bx} y2={probeY} />
      {L.ticks.map((x, k) => (
        <g key={k}>
          <line className="il-tick" x1={x} y1={probeY - 3.5} x2={x} y2={probeY + 3.5} />
          {L.checkLabels && (
            <text className="il-t il-xs il-t-faint" x={x} y={probeY - 8} textAnchor="middle">
              check
            </text>
          )}
          <g {...b(`tk${k}`)}>
            <rect className="il-mask" x={x - maskW / 2} y={probeY - 17} width={maskW} height="12" />
            <line className="il-warn-solid" x1={x} y1={probeY - 3.5} x2={x} y2={probeY + 3.5} />
            <text className="il-t il-xs il-warn-t" x={x} y={probeY - 8} textAnchor="middle">
              503
            </text>
          </g>
        </g>
      ))}
      {[0, 1, 2].map((k) => (
        <circle key={k} {...b(`pr${k}`)} className="il-dot" cx={right} cy={probeY} r="2.5" />
      ))}
      <circle {...b("push")} className="il-dot" cx={right} cy={pushY} r="2.5" />

      {/* The live version: serving the whole time */}
      <rect className="il-box" x={ax} y={ay} width={aw} height={ah} />
      <rect className="il-box-blue" x={ax} y={ay} width={aw} height={ah} />
      <IconBox name="cloud" x={ax + ti} y={ay + (ah - ts) / 2} size={ts} blue />
      {L.domain ? (
        <>
          <text className="il-t il-strong" x={ax + ti + ts + 10} y={ay + ah / 2 - 3}>
            v40
          </text>
          <text className="il-t il-xs il-t-faint" x={ax + ti + ts + 10} y={ay + ah / 2 + 12}>
            horseai.example.com
          </text>
        </>
      ) : (
        <text className="il-t il-strong" x={ax + ti + ts + 8} y={ay + ah / 2 + 4}>
          v40
        </text>
      )}
      <Ico name="checkCircle" x={ax + aw - 56} y={ay + ah / 2 - 6} size={12} blue />
      <text className="il-t il-sm il-pill-t" x={ax + aw - 12} y={ay + ah / 2 + 4} textAnchor="end">
        live
      </text>

      {/* The new version: builds, fails its checks, is removed */}
      <rect className="il-box il-dash" x={bx} y={by} width={bw} height={bh} />
      <g {...b("v41")}>
        <rect {...b("v41solid")} className="il-box" x={bx} y={by} width={bw} height={bh} />
        <IconBox name="cloud" x={bx + ti} y={by + ti} size={ts} />
        <text className="il-t il-strong" x={bx + ti + ts + (L.domain ? 10 : 8)} y={nameY}>
          v41
        </text>
        <text className="il-t il-xs il-t-faint" x={bx + ti + ts + (L.domain ? 10 : 8)} y={nameY + 15}>
          9c0d4e2
        </text>
        <rect className="il-well" x={wx} y={wy} width={ww} height={wh} />
        <rect clipPath={`url(#${id}c)`} x={wx} y={wy} width={ww} height={wh} fill={`url(#${id}h)`} />
        <line {...b("edgeln")} className="il-blue-line" x1="0" y1={wy} x2="0" y2={wy + wh} />
      </g>
      <text {...b("building")} className="il-t il-sm il-t-mute" x={bx + bw - 12} y={nameY} textAnchor="end">
        building
      </text>
      <text {...b("checking")} className="il-t il-sm il-t-mute" x={bx + bw - 12} y={nameY} textAnchor="end">
        checking
      </text>
      <text {...b("removed")} className="il-t il-sm il-warn-t" x={bx + bw - 12} y={nameY} textAnchor="end">
        removed
      </text>
      <g {...b("sel")}>
        <Handles x0={bx} y0={by} x1={bx + bw} y1={by + bh} on />
      </g>

      <g {...b("pill")}>
        <rect className="il-pill" x={px - pw / 2} y={py - 11} width={pw} height="18" />
        <text className="il-t il-xs il-pill-t" x={px} y={py + 2} textAnchor="middle">
          {pt}
        </text>
      </g>

      {[0, 1, 2, 3].map((i) => (
        <circle key={i} {...b(`d${i}`)} className="il-dot" cx={right} cy={liveY} r="2.25" />
      ))}

      <line className="il-line" x1={t0} y1={ty} x2={t1} y2={ty} />
      <rect {...b("prog")} className="il-blue-fill" x="0" y={ty - 0.75} width={t1 - t0} height="1.5" />
      {FAIL_KEYS.map((k, i) => (
        <g key={k.label}>
          <Diamond x={trackX(L, k.t)} y={ty} />
          <g {...b(`k${i}`)}>
            <Diamond x={trackX(L, k.t)} y={ty} on />
          </g>
          <text className="il-t il-xs il-t-mute" x={trackX(L, k.t)} y={ty + 20} textAnchor="middle">
            {k.label}
          </text>
        </g>
      ))}
      <g {...b("ph")}>
        <line className="il-blue-line" x1="0" y1={ty - 12} x2="0" y2={ty + 8} />
        <rect className="il-blue-fill" x="-3.5" y={ty - 17} width="7" height="7" />
      </g>
    </svg>
  );
}

export function DeployDemo() {
  return (
    <div className="ld-demo">
      <FailScene L={WIDE} frame={FAIL_WIDE} className="il-wide" />
      <FailScene L={NARROW} frame={FAIL_NARROW} className="il-narrow" />
    </div>
  );
}
