"use client";

import { Diamond, Handles, Ico } from "./il";
import { type Frame, loopStory, mix, p, useScene, win } from "./scene";

/* Rollback: one click puts a kept image back live, with no rebuild. */

const RB_X = [56.5, 136.5, 216.5, 296.5];
const RB_V = ["v38", "v39", "v40", "v41"];
const RB_END = 2800;
const CARD = { w: 56, y: 34.5, h: 46 };
const BTN = { cx: RB_X[2]!, y: 148.5, w: 108, h: 22 };

function rollbackStory(t: number): Frame {
  const back = p(t, 1500, 2400);
  const x = mix(RB_X[3]!, RB_X[2]!, back);
  return {
    st: {
      ph: { x },
      sel: { x: x - RB_X[3]! },
      pick: { o: win(t, 500, 1700, 250) },
      btn: { o: p(t, 700, 1000) * (1 - p(t, 1250, 1400)), y: mix(3, 0, p(t, 700, 1000)) },
      press: { o: win(t, 1250, 2300, 150) },
      done: { o: p(t, 2300, 2600) },
      on41: { o: 1 - p(t, 1500, 1800) },
      on40: { o: p(t, 2100, 2400) },
      l41: { o: 1 - p(t, 1500, 1800) },
      l40: { o: p(t, 2100, 2400) },
    },
  };
}

const RB_T = 5600;
const rollbackFrame = loopStory(RB_T, rollbackStory);

function BtnFace({ icon, label, blue }: { icon: "rollback" | "checkCircle"; label: string; blue?: boolean }) {
  const x0 = BTN.cx - BTN.w / 2;
  const textW = label.length * 6;
  const left = BTN.cx - (12 + 6 + textW) / 2;
  return (
    <>
      <rect className={blue ? "il-pill" : "il-chip"} x={x0} y={BTN.y} width={BTN.w} height={BTN.h} />
      <Ico name={icon} x={left} y={BTN.y + 5} size={12} blue={blue} />
      <text className={blue ? "il-t il-xs il-pill-t" : "il-t il-xs il-strong"} x={left + 18} y={BTN.y + 14.5}>
        {label}
      </text>
    </>
  );
}

export function RollbackDemo() {
  const { root, b } = useScene(RB_T, RB_END + 200, rollbackFrame);
  return (
    <div className="ld-demo">
      <svg ref={root} className="il il-md" viewBox="0 0 352 184" aria-hidden="true">
        <Ico name="history" x={16.5} y={9} />
        <text className="il-t il-sm il-t-mute" x="36" y="20">
          kept images
        </text>
        <g {...b("l41")}>
          <Ico name="checkCircle" x={266} y={10} size={12} blue />
          <text className="il-t il-sm il-pill-t" x="336" y="20" textAnchor="end">
            live v41
          </text>
        </g>
        <g {...b("l40")}>
          <Ico name="checkCircle" x={266} y={10} size={12} blue />
          <text className="il-t il-sm il-pill-t" x="336" y="20" textAnchor="end">
            live v40
          </text>
        </g>
        {RB_X.map((x, i) => (
          <g key={i}>
            <rect className="il-box" x={x - CARD.w / 2} y={CARD.y} width={CARD.w} height={CARD.h} />
            <Ico name="layers" x={x - 7} y={CARD.y + 9} />
            <text className="il-t il-sm" x={x} y={CARD.y + 37} textAnchor="middle">
              {RB_V[i]}
            </text>
            <line className="il-guide" x1={x} y1={CARD.y + CARD.h + 4} x2={x} y2="114" />
          </g>
        ))}
        <rect {...b("pick")} className="il-box-blue il-dash" x={RB_X[2]! - CARD.w / 2} y={CARD.y} width={CARD.w} height={CARD.h} />
        <g {...b("sel")}>
          <rect className="il-box-blue" x={RB_X[3]! - CARD.w / 2 - 3} y={CARD.y - 3} width={CARD.w + 6} height={CARD.h + 6} />
          <Handles x0={RB_X[3]! - CARD.w / 2 - 3} y0={CARD.y - 3} x1={RB_X[3]! + CARD.w / 2 + 3} y1={CARD.y + CARD.h + 3} on />
        </g>
        <line className="il-line" x1="16.5" y1="124.5" x2="336.5" y2="124.5" />
        {RB_X.map((x, i) => (
          <Diamond key={i} x={x} y={124.5} />
        ))}
        <g {...b("on41")}>
          <Diamond x={RB_X[3]!} y={124.5} on />
        </g>
        <g {...b("on40")}>
          <Diamond x={RB_X[2]!} y={124.5} on />
        </g>
        <g {...b("ph")}>
          <line className="il-blue-line" x1="0" y1="110" x2="0" y2="134" />
          <rect className="il-blue-fill" x="-3.5" y="104" width="7" height="7" />
        </g>
        <g {...b("btn")}>
          <BtnFace icon="rollback" label="roll back" />
        </g>
        <g {...b("press")}>
          <BtnFace icon="rollback" label="roll back" blue />
        </g>
        <g {...b("done")}>
          <BtnFace icon="checkCircle" label="no rebuild" blue />
        </g>
      </svg>
    </div>
  );
}
