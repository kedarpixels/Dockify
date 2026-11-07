"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Corners } from "@/components/ui/rule";
import { INSTALL_CMD } from "@/lib/site";
import { Ico } from "./il";
import { useInView } from "./motion";
import { type Frame, grow, lin, mix, p, useScene, useSvgId, win } from "./scene";

/* "Three steps": each step is a small fragment of the real flow, joined by one dashed line that a
   blue dot crosses once. Each fragment plays once when it comes on screen, then holds for good. */

const ONCE = Infinity;
const END = 4000;

const CMD = INSTALL_CMD;
const CMD_X = 30.5;
/* Widths are estimates until the font is in; then the real text is measured. */
const GUESS = { cmd: CMD.length * 5.6, l3: 36 + "setup link ready".length * 5.6 + 4 };

const installFrame = (m: typeof GUESS) => (t: number): Frame => {
  const typed = lin(t, 300, 1700);
  const blink = t < END && Math.floor(t / 500) % 2 ? 0.15 : 1;
  return {
    st: {
      clip: { x: CMD_X, sx: grow(typed) },
      caret: { x: CMD_X + 2 + m.cmd * typed, o: t < 1800 ? 1 : 1 - p(t, 1800, 1900) },
      caret2: { x: m.l3, o: t < 2700 ? 0 : blink },
      l2: { o: p(t, 1900, 2150), x: mix(-3, 0, p(t, 1900, 2150)) },
      l3: { o: p(t, 2450, 2700), x: mix(-3, 0, p(t, 2450, 2700)) },
    },
  };
};

function InstallFrag() {
  const cmdRef = useRef<SVGTextElement>(null);
  const l3Ref = useRef<SVGTextElement>(null);
  const [m, setM] = useState(GUESS);
  useEffect(() => {
    let live = true;
    const measure = () => {
      if (!live || !cmdRef.current || !l3Ref.current) return;
      setM({ cmd: cmdRef.current.getComputedTextLength(), l3: 36 + l3Ref.current.getComputedTextLength() + 4 });
    };
    measure();
    void document.fonts?.ready.then(measure);
    return () => {
      live = false;
    };
  }, []);
  const frame = useMemo(() => installFrame(m), [m]);
  const { root, b } = useScene(ONCE, END, frame, END);
  const id = useSvgId();
  return (
    <svg ref={root} className="il il-step" viewBox="0 0 340 112" aria-hidden="true">
      <defs>
        <clipPath id={`${id}c`}>
          <rect {...b("clip")} x="0" y="32" width={m.cmd + 1} height="18" />
        </clipPath>
      </defs>
      <rect className="il-box" x="8.5" y="6.5" width="323" height="99" />
      <line className="il-well" x1="8.5" y1="26.5" x2="331.5" y2="26.5" />
      <Ico name="terminal" x={18} y={10.5} size={12} />
      <text className="il-t il-xs il-t-faint" x="36" y="20">
        root@vps
      </text>
      <text className="il-t il-xs il-pill-t" x="18" y="45">
        $
      </text>
      <text ref={cmdRef} className="il-t il-xs il-strong" x={CMD_X} y="45" clipPath={`url(#${id}c)`}>
        {CMD}
      </text>
      <rect {...b("caret")} className="il-blue-fill" x="0" y="36" width="5" height="11" />
      <g {...b("l2")}>
        <Ico name="checkCircle" x={18} y={57} size={12} blue />
        <text className="il-t il-xs il-t-mute" x="36" y="66">
          firewall, docker, tunnel
        </text>
      </g>
      <g {...b("l3")}>
        <Ico name="link" x={18} y={77} size={12} blue />
        <text ref={l3Ref} className="il-t il-xs il-strong" x="36" y="86">
          setup link ready
        </text>
      </g>
      <rect {...b("caret2")} className="il-blue-fill" x="0" y="77" width="5" height="11" />
    </svg>
  );
}

const REPOS = ["horseai/docs", "horseai/app", "horseai/site"];
const ROW_Y = (i: number) => 44 + i * 22;

function repoFrame(t: number): Frame {
  return {
    st: {
      hi: { y: mix(0, 22, p(t, 900, 1400)), o: p(t, 300, 550) },
      pick: { o: p(t, 1500, 1750) },
      c0: { o: p(t, 1800, 2050), x: mix(-4, 0, p(t, 1800, 2050)) },
      c1: { o: p(t, 2200, 2450), x: mix(-4, 0, p(t, 2200, 2450)) },
      c2: { o: p(t, 2700, 2950), x: mix(-4, 0, p(t, 2700, 2950)) },
    },
  };
}

function TagChip({ y, icon, label }: { y: number; icon: "branch" | "folderOpen"; label: string }) {
  return (
    <>
      <rect className="il-chip" x="206.5" y={y} width="116" height="20" />
      <Ico name={icon} x={215} y={y + 4} size={12} />
      <text className="il-t il-xs il-strong" x="233" y={y + 13.5}>
        {label}
      </text>
    </>
  );
}

function RepoFrag() {
  const { root, b } = useScene(ONCE, END, repoFrame, END);
  return (
    <svg ref={root} className="il il-step" viewBox="0 0 340 112" aria-hidden="true">
      <rect className="il-box" x="8.5" y="6.5" width="323" height="99" />
      <Ico name="github" x={18} y={11.5} size={12} />
      <text className="il-t il-xs il-t-faint" x="36" y="21">
        pick a repo
      </text>
      <line className="il-guide" x1="196.5" y1="34" x2="196.5" y2="98" />
      <g {...b("hi")}>
        <rect className="il-pill" x="14.5" y={ROW_Y(0) - 10.5} width="176" height="20" />
      </g>
      {REPOS.map((r, i) => (
        <text key={r} className="il-t il-sm" x="24" y={ROW_Y(i) + 3.5}>
          {r}
        </text>
      ))}
      <g {...b("pick")}>
        <Ico name="checkCircle" x={172} y={ROW_Y(1) - 6.5} size={12} blue />
      </g>
      <g {...b("c0")}>
        <TagChip y={34.5} icon="branch" label="main" />
      </g>
      <g {...b("c1")}>
        <TagChip y={57.5} icon="folderOpen" label="apps/web" />
      </g>
      <g {...b("c2")}>
        <Ico name="checkCircle" x={215} y={83.5} size={12} blue />
        <text className="il-t il-xs il-pill-t" x="233" y="93">
          connected
        </text>
      </g>
    </svg>
  );
}

const BAR = { x: 254.5, y: 63.5, w: 66, h: 8 };

function pushFrame(t: number): Frame {
  const u = lin(t, 700, 1300);
  const build = lin(t, 1350, 2550);
  return {
    st: {
      chip: { x: mix(-6, 0, p(t, 200, 600)), o: p(t, 200, 600) },
      dot: { x: 36 * u, o: win(t, 700, 1200, 120) },
      building: { o: win(t, 1300, 2550, 150) },
      bar: { o: win(t, 1300, 2550, 150) },
      fill: { x: BAR.x, sx: grow(build) },
      live: { o: p(t, 2600, 2850) },
    },
  };
}

function PushFrag() {
  const { root, b } = useScene(ONCE, END, pushFrame, END);
  const id = useSvgId();
  return (
    <svg ref={root} className="il il-step" viewBox="0 0 340 112" aria-hidden="true">
      <defs>
        <pattern id={`${id}b`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="4" className="il-hatch-blue" />
        </pattern>
        <clipPath id={`${id}c`}>
          <rect {...b("fill")} x="0" y={BAR.y} width={BAR.w} height={BAR.h} />
        </clipPath>
      </defs>
      <g {...b("chip")}>
        <rect className="il-chip" x="8.5" y="44.5" width="120" height="24" />
        <Ico name="commit" x={16} y={50.5} size={12} />
        <text className="il-t il-sm il-t-mute" x="34" y="60.5">
          main
          <tspan className="il-strong" dx="5">
            9c0d4e2
          </tspan>
        </text>
      </g>
      <line className="il-guide" x1="128.5" y1="56.5" x2="164.5" y2="56.5" />
      <circle {...b("dot")} className="il-dot" cx="128.5" cy="56.5" r="2.5" />
      <rect className="il-box" x="164.5" y="28.5" width="167" height="56" />
      <Ico name="globe" x={174} y={37} size={12} />
      <text className="il-t il-xs il-strong" x="192" y="46.5">
        horseai.example.com
      </text>
      <g {...b("building")}>
        <Ico name="loader" x={174} y={61.5} size={12} />
        <text className="il-t il-xs il-t-mute" x="192" y="71">
          building
        </text>
      </g>
      <g {...b("bar")}>
        <rect className="il-well" x={BAR.x} y={BAR.y} width={BAR.w} height={BAR.h} />
        <rect clipPath={`url(#${id}c)`} x={BAR.x} y={BAR.y} width={BAR.w} height={BAR.h} fill={`url(#${id}b)`} />
      </g>
      <g {...b("live")}>
        <rect className="il-box-blue" x="164.5" y="28.5" width="167" height="56" />
        <Ico name="checkCircle" x={174} y={61.5} size={12} blue />
        <text className="il-t il-xs il-pill-t" x="192" y="71">
          live
        </text>
        <text className="il-t il-xs il-t-faint" x="320.5" y="71" textAnchor="end">
          no downtime
        </text>
      </g>
    </svg>
  );
}

const STEPS = [
  { title: "Install.", line: "One command on a fresh Ubuntu server.", frag: <InstallFrag /> },
  { title: "Add a repository.", line: "Any repository, with or without a Dockerfile, from GitHub or by its URL.", frag: <RepoFrag /> },
  { title: "Deploy.", line: "A stateless app swaps with zero downtime, after its health check.", frag: <PushFrag /> },
];

export function Steps() {
  const ref = useRef<HTMLDivElement>(null);
  const on = useInView(ref);
  return (
    <div className="ld-steps-wrap" ref={ref} data-on={on || undefined}>
      <span className="ld-steps-link" aria-hidden="true">
        <span className="ld-steps-run">
          <i />
        </span>
      </span>
      <ol className="ld-steps">
        {STEPS.map((s, i) => (
          <li key={s.title} className="ld-step">
            <Corners />
            <div className="ld-step-art">{s.frag}</div>
            <div className="ld-step-text">
              <span className="ld-step-n pixel">0{i + 1}</span>
              <div>
                <h3 className="ld-h3">{s.title}</h3>
                <p>{s.line}</p>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
