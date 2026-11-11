"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { INSTALL_CMD } from "@/lib/site";
import { Handles, HatchDefs, Ico, IconBox } from "./il";
import { along, type Frame, grow, lengthOf, lin, p, type Pt, useScene, useSvgId, win } from "./scene";

/* Two layouts of one story: WIDE (520 by 548, four projects, the command on top) from a 520px art column up,
   and NARROW (320 by 349, two projects) on phones. landing.css shows one or the other. It plays once and holds. */

type Rect = { x: number; y: number; w: number; h: number };

type HeroLayout = {
  w: number;
  h: number;
  /** The install command box on top, and the server answering it. */
  cmd: boolean;
  srv: Rect;
  /** Server head: icon, name and live count. */
  head: { icon: [number, number]; name: [number, number]; countX: number };
  edge: Rect & { label: string; tlsIconDx: number };
  row: { x: number; w: number; h: number; y0: number; gap: number };
  /** Inside a row, from its top left: the name and status baselines, the build well, the result line. */
  inRow: { nameDy: number; statusDy: number; domain: boolean; well: { dx: number; dy: number; w: number; h: number }; okDy: number };
  busTraffic: number;
  busBuild: number;
  git: Rect & { branch: boolean };
  gitX: number;
  dropY: number;
  bucket: Rect & { lockDx: number };
  backupX: number;
  projects: number;
  /** Shifts the server's own timeline: 0 after the command, negative with no command. */
  off: number;
  still: number;
};

const WIDE: HeroLayout = {
  w: 520,
  h: 548,
  cmd: true,
  srv: { x: 20.5, y: 92.5, w: 479, h: 360 },
  head: { icon: [40, 108.5], name: [62, 120], countX: 480 },
  edge: { x: 40.5, y: 136.5, w: 440, h: 28, label: "https, certificates", tlsIconDx: 107 },
  row: { x: 72.5, w: 408, h: 50, y0: 184.5, gap: 62 },
  inRow: { nameDy: 21, statusDy: 29, domain: true, well: { dx: 200, dy: 20, w: 108, h: 10 }, okDy: 29 },
  busTraffic: 44.5,
  busBuild: 58.5,
  git: { x: 20.5, y: 492.5, w: 150, h: 36, branch: true },
  gitX: 95.5,
  dropY: 438.5,
  bucket: { x: 330.5, y: 492.5, w: 170, h: 36, lockDx: 82 },
  backupX: 415.5,
  projects: 4,
  off: 0,
  still: 11600,
};

const NARROW: HeroLayout = {
  w: 320,
  h: 349,
  cmd: false,
  srv: { x: 12.5, y: 12.5, w: 295, h: 270 },
  head: { icon: [24, 24.5], name: [44, 36], countX: 296 },
  edge: { x: 24.5, y: 50.5, w: 271, h: 28, label: "https", tlsIconDx: 52 },
  row: { x: 60.5, w: 235, h: 56, y0: 96.5, gap: 68 },
  inRow: { nameDy: 24, statusDy: 24, domain: false, well: { dx: 50, dy: 36, w: 173, h: 8 }, okDy: 44 },
  busTraffic: 36.5,
  busBuild: 48.5,
  git: { x: 12.5, y: 302.5, w: 120, h: 34, branch: false },
  gitX: 72.5,
  dropY: 270.5,
  bucket: { x: 144.5, y: 302.5, w: 163, h: 34, lockDx: 76 },
  backupX: 226.5,
  projects: 2,
  off: -1900,
  still: 6800,
};

const T = Infinity;
const CMD_X = 50;

const PROJECTS = [
  { name: "horseai", domain: "horseai.example.com", ms: 38 },
  { name: "inkwell", domain: "inkwell.example.com", ms: 24 },
  { name: "brightlane", domain: "brightlane.example.com", ms: 51 },
  { name: "fieldnote", domain: "fieldnote.example.com", ms: 19 },
];

const STEP = 1500;
const LIVE = 1750;
const TRAFFIC_LOOP = 1700;

function story(L: HeroLayout, cmdW: number) {
  const projects = PROJECTS.slice(0, L.projects);
  const start = 2700 + L.off;
  const rowY = (i: number) => L.row.y0 + i * L.row.gap;
  const rowCy = (i: number) => rowY(i) + L.row.h / 2;
  const trafficPath = (i: number): Pt[] => [
    [L.busTraffic, L.edge.y + L.edge.h],
    [L.busTraffic, rowCy(i) - 7],
    [L.row.x, rowCy(i) - 7],
  ];
  const buildPath = (i: number): Pt[] => [
    [L.gitX, L.git.y],
    [L.gitX, L.dropY],
    [L.busBuild, L.dropY],
    [L.busBuild, rowCy(i) + 7],
    [L.row.x, rowCy(i) + 7],
  ];
  const o = L.off;

  return (t: number): Frame => {
    const st: Frame["st"] = {};

    /* The install command types, then the server answers */
    if (L.cmd) {
      const typed = lin(t, 300, 1700);
      st.type = { x: CMD_X, sx: grow(typed) };
      st.caret = { x: CMD_X + cmdW * typed, o: t < 1900 ? (Math.floor(t / 400) % 2 ? 0.25 : 1) : 1 - p(t, 1900, 2100) };
      st.installing = { o: win(t, 1800, 2400, 150) };
      st.ready = { o: p(t, 2400, 2650) };
    }
    st.srvSolid = { o: p(t, 2000 + o, 2500 + o) };
    st.srvSel = { o: win(t, Math.max(0, 1900 + o), 2700 + o, 250) };
    st.edge = { o: p(t, 2300 + o, 2700 + o) };
    st.srvHead = { o: p(t, 2200 + o, 2600 + o) };

    let live = 0;
    projects.forEach((_, i) => {
      const s = start + i * STEP;
      const on = p(t, s + LIVE, s + LIVE + 220);
      if (t >= s + LIVE) live++;
      const build = buildPath(i);
      const bl = lengthOf(build);
      const [gx, gy] = along(build, bl * lin(t, s, s + 520));
      st[`push${i}`] = { x: gx, y: gy, o: win(t, s, s + 460, 80) };
      st[`row${i}`] = { o: p(t, s + 320, s + 560) };
      st[`sel${i}`] = { o: win(t, s + 320, s + LIVE, 200) };
      st[`clip${i}`] = { x: L.row.x + L.inRow.well.dx, sx: grow(lin(t, s + 460, s + 1400)) };
      st[`well${i}`] = { o: p(t, s + 320, s + 560) * (1 - p(t, s + LIVE, s + LIVE + 260)) };
      st[`building${i}`] = { o: win(t, s + 420, s + 1400, 160) };
      st[`checking${i}`] = { o: win(t, s + 1400, s + LIVE - 60, 120) };
      st[`live${i}`] = { o: on };
      st[`blue${i}`] = { o: on };
      st[`ok${i}`] = { o: p(t, s + LIVE + 200, s + LIVE + 480) };
      st[`stub${i}`] = { o: on };
      const path = trafficPath(i);
      const len = lengthOf(path);
      for (let k = 0; k < 2; k++) {
        const u = ((t + (k * TRAFFIC_LOOP) / 2 + i * 260) % TRAFFIC_LOOP) / TRAFFIC_LOOP;
        const env = Math.min(1, u / 0.1) * (1 - Math.max(0, (u - 0.85) / 0.15));
        const [x, y] = along(path, len * u);
        st[`tr${i}${k}`] = { x, y, o: on * env };
      }
    });

    /* The night's backup: dumped, encrypted, sent, restored into a throwaway copy */
    const bs = start + (projects.length - 1) * STEP + LIVE + 500;
    const srvBottom = L.srv.y + L.srv.h;
    st.backup = { x: L.backupX, y: srvBottom + (L.bucket.y - srvBottom) * lin(t, bs, bs + 500), o: win(t, bs, bs + 420, 80) };
    st.bucketBlue = { o: p(t, bs + 450, bs + 700) };
    st.lockBlue = { o: p(t, bs + 450, bs + 700) };
    st.encrypted = { o: win(t, bs + 450, bs + 1500, 160) };
    st.restored = { o: p(t, bs + 1500, bs + 1760) };

    return { st, tx: { count: `${live} of ${projects.length} live` } };
  };
}

/* Until the face is in, the command is measured at Geist's average width; then for real. */
const GUESS = INSTALL_CMD.length * 6.25;

function HeroSvg({ L, className }: { L: HeroLayout; className: string }) {
  const cmdRef = useRef<SVGTextElement>(null);
  const [cmdW, setCmdW] = useState(GUESS);
  useEffect(() => {
    if (!L.cmd) return;
    let live = true;
    const measure = () => {
      if (live && cmdRef.current) setCmdW(cmdRef.current.getComputedTextLength());
    };
    measure();
    void document.fonts?.ready.then(measure);
    return () => {
      live = false;
    };
  }, [L.cmd]);
  const frame = useMemo(() => story(L, cmdW), [L, cmdW]);
  const { root, b, tx } = useScene(T, L.still, frame);
  const id = useSvgId();
  const { srv, edge, row, inRow, git, bucket } = L;
  const rowY = (i: number) => row.y0 + i * row.gap;
  const rowCy = (i: number) => rowY(i) + row.h / 2;
  const projects = PROJECTS.slice(0, L.projects);
  const last = projects.length - 1;

  return (
    <svg ref={root} className={`il il-hero ${className}`} viewBox={`0 0 ${L.w} ${L.h}`} aria-hidden="true">
      <HatchDefs id={id} />
      <defs>
        {L.cmd ? (
          <clipPath id={`${id}cmd`}>
            <rect {...b("type")} x="0" y="24" width={cmdW + 2} height="32" />
          </clipPath>
        ) : null}
        {projects.map((_, i) => (
          <clipPath key={i} id={`${id}w${i}`}>
            <rect {...b(`clip${i}`)} x="0" y={rowY(i) + inRow.well.dy} width={inRow.well.w} height={inRow.well.h} />
          </clipPath>
        ))}
      </defs>

      {/* The install command */}
      {L.cmd ? (
        <>
          <rect className="il-box" x="20.5" y="20.5" width="479" height="40" />
          <Ico name="terminal" x={30} y={33.5} />
          <text ref={cmdRef} className="il-t il-strong" x={CMD_X} y="44.5" clipPath={`url(#${id}cmd)`}>
            {INSTALL_CMD}
          </text>
          <rect {...b("caret")} className="il-blue-fill" x="0" y="33" width="1.5" height="15" />
          <text {...b("installing")} className="il-t il-t-mute" x="486" y="44.5" textAnchor="end">
            installing
          </text>
          <text {...b("ready")} className="il-t il-pill-t" x="486" y="44.5" textAnchor="end">
            ready
          </text>
          <line className="il-guide" x1="260.5" y1="60.5" x2="260.5" y2={srv.y} />
        </>
      ) : null}

      {/* The server */}
      <rect className="il-box il-dash" x={srv.x} y={srv.y} width={srv.w} height={srv.h} />
      <rect {...b("srvSolid")} className="il-box" x={srv.x} y={srv.y} width={srv.w} height={srv.h} />
      <g {...b("srvSel")}>
        <rect className="il-box-blue" x={srv.x} y={srv.y} width={srv.w} height={srv.h} />
        <Handles x0={srv.x} y0={srv.y} x1={srv.x + srv.w} y1={srv.y + srv.h} on />
      </g>
      <g {...b("srvHead")}>
        <Ico name="server" x={L.head.icon[0]} y={L.head.icon[1]} />
        <text className="il-t il-strong" x={L.head.name[0]} y={L.head.name[1]}>
          vps-01
        </text>
        <text {...tx("count")} className="il-t il-t-mute" x={L.head.countX} y={L.head.name[1]} textAnchor="end" />
      </g>

      {/* The edge: every domain comes in here, with its certificate */}
      <g {...b("edge")}>
        <rect className="il-box" x={edge.x} y={edge.y} width={edge.w} height={edge.h} />
        <Ico name="globe" x={edge.x + 10} y={edge.y + 7} />
        <text className="il-t il-sm" x={edge.x + 32} y={edge.y + 18}>
          edge
        </text>
        <Ico name="shieldCheck" x={edge.x + edge.w - edge.tlsIconDx} y={edge.y + 8} size={12} />
        <text className="il-t il-xs il-t-faint" x={edge.x + edge.w - 12} y={edge.y + 18} textAnchor="end">
          {edge.label}
        </text>
        <line className="il-line" x1={L.busTraffic} y1={edge.y + edge.h} x2={L.busTraffic} y2={rowCy(last) - 7} />
      </g>
      <line className="il-guide" x1={L.busBuild} y1={L.dropY} x2={L.busBuild} y2={rowCy(0) + 7} />
      <path className="il-guide" d={`M${L.gitX} ${git.y}V${L.dropY}H${L.busBuild}`} />

      {projects.map((pr, i) => {
        const y = rowY(i);
        const cy = rowCy(i);
        const wx = row.x + inRow.well.dx;
        const wy = y + inRow.well.dy;
        const statusY = y + inRow.statusDy;
        return (
          <g key={pr.name}>
            <rect className="il-well il-dash" x={row.x} y={y} width={row.w} height={row.h} />
            <line className="il-guide" x1={L.busBuild} y1={cy + 7} x2={row.x} y2={cy + 7} />
            <line {...b(`stub${i}`)} className="il-line" x1={L.busTraffic} y1={cy - 7} x2={row.x} y2={cy - 7} />
            <g {...b(`row${i}`)}>
              <rect className="il-box" x={row.x} y={y} width={row.w} height={row.h} />
              <IconBox name="cloud" x={row.x + 11} y={cy - 14} />
              <text className="il-t il-strong" x={row.x + 50} y={y + inRow.nameDy}>
                {pr.name}
              </text>
              {inRow.domain ? (
                <text className="il-t il-xs il-t-faint" x={row.x + 50} y={y + 36}>
                  {pr.domain}
                </text>
              ) : null}
            </g>
            <g {...b(`well${i}`)}>
              <rect className="il-well" x={wx} y={wy} width={inRow.well.w} height={inRow.well.h} />
              <rect clipPath={`url(#${id}w${i})`} x={wx} y={wy} width={inRow.well.w} height={inRow.well.h} fill={`url(#${id}h)`} />
            </g>
            <text {...b(`ok${i}`)} className="il-t il-xs il-t-faint" x={wx} y={y + inRow.okDy}>
              200 in {pr.ms} ms
            </text>
            <g {...b(`sel${i}`)}>
              <Handles x0={row.x} y0={y} x1={row.x + row.w} y1={y + row.h} on />
            </g>
            <g {...b(`blue${i}`)}>
              <rect className="il-box-blue" x={row.x} y={y} width={row.w} height={row.h} />
              <IconBox name="cloud" x={row.x + 11} y={cy - 14} blue />
            </g>
            <text {...b(`building${i}`)} className="il-t il-sm il-t-mute" x={row.x + row.w - 14} y={statusY} textAnchor="end">
              building
            </text>
            <text {...b(`checking${i}`)} className="il-t il-sm il-t-mute" x={row.x + row.w - 14} y={statusY} textAnchor="end">
              health check
            </text>
            <g {...b(`live${i}`)}>
              <Ico name="checkCircle" x={row.x + row.w - 50} y={statusY - 10} size={12} blue />
              <text className="il-t il-sm il-pill-t" x={row.x + row.w - 14} y={statusY} textAnchor="end">
                live
              </text>
            </g>
            <circle {...b(`push${i}`)} className="il-dot" cx="0" cy="0" r="2.5" />
            {[0, 1].map((k) => (
              <circle key={k} {...b(`tr${i}${k}`)} className="il-dot" cx="0" cy="0" r="2.5" />
            ))}
          </g>
        );
      })}

      {/* Where the code comes from, and where the backups go */}
      <rect className="il-box" x={git.x} y={git.y} width={git.w} height={git.h} />
      <Ico name="github" x={git.x + 12} y={git.y + git.h / 2 - 7} />
      <text className="il-t il-sm" x={git.x + 34} y={git.y + git.h / 2 + 4}>
        git push
      </text>
      {git.branch ? (
        <>
          <Ico name="branch" x={git.x + git.w - 50} y={git.y + 12} size={12} />
          <text className="il-t il-xs il-t-faint" x={git.x + git.w - 12} y={git.y + 22} textAnchor="end">
            main
          </text>
        </>
      ) : null}

      <line className="il-guide" x1={L.backupX} y1={srv.y + srv.h} x2={L.backupX} y2={bucket.y} />
      <rect className="il-box il-dash" x={bucket.x} y={bucket.y} width={bucket.w} height={bucket.h} />
      <rect {...b("bucketBlue")} className="il-box-blue" x={bucket.x} y={bucket.y} width={bucket.w} height={bucket.h} />
      <Ico name="archive" x={bucket.x + 12} y={bucket.y + bucket.h / 2 - 7} />
      <text className="il-t il-sm" x={bucket.x + 34} y={bucket.y + bucket.h / 2 + 4}>
        bucket
      </text>
      <g {...b("lockBlue")}>
        <Ico name="lock" x={bucket.x + bucket.lockDx} y={bucket.y + bucket.h / 2 - 6} size={12} blue />
      </g>
      <text {...b("encrypted")} className="il-t il-xs il-t-mute" x={bucket.x + bucket.w - 12} y={bucket.y + bucket.h / 2 + 4} textAnchor="end">
        encrypted
      </text>
      <text {...b("restored")} className="il-t il-xs il-pill-t" x={bucket.x + bucket.w - 12} y={bucket.y + bucket.h / 2 + 4} textAnchor="end">
        restored
      </text>
      <circle {...b("backup")} className="il-dot" cx="0" cy="0" r="2.5" />
    </svg>
  );
}

export function HeroScene() {
  return (
    <div className="sv-stage">
      <p className="sr">
        Dockify installs with one command, then projects such as horseai, inkwell, brightlane and fieldnote are deployed, built, health checked and
        go live on one server, with an encrypted backup sent to your bucket.
      </p>
      <HeroSvg L={WIDE} className="il-hero-wide" />
      <HeroSvg L={NARROW} className="il-hero-narrow" />
      <p className="sv-punch">
        <span>Your apps</span>
        <i aria-hidden="true" />
        <span>One server</span>
        <i aria-hidden="true" />
        <span>Open source</span>
      </p>
    </div>
  );
}
