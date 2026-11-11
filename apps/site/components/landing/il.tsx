import { Icon, type IconName } from "@/components/icon";

export function HatchDefs({ id }: { id: string }) {
  return (
    <defs>
      <pattern id={`${id}h`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="6" className="il-hatch" />
      </pattern>
      <pattern id={`${id}b`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="6" className="il-hatch-blue" />
      </pattern>
    </defs>
  );
}

/** Small square handles on the four corners of a box. */
export function Handles({ x0, y0, x1, y1, on }: { x0: number; y0: number; x1: number; y1: number; on?: boolean }) {
  return (
    <>
      {(
        [
          [x0, y0],
          [x1, y0],
          [x0, y1],
          [x1, y1],
        ] as const
      ).map(([x, y], i) => (
        <rect key={i} className={on ? "il-handle il-handle-on" : "il-handle"} x={x - 2.5} y={y - 2.5} width={5} height={5} />
      ))}
    </>
  );
}

/** A keyframe diamond centred on (x, y). */
export function Diamond({ x, y, on }: { x: number; y: number; on?: boolean }) {
  return <rect className={on ? "il-diamond il-diamond-on" : "il-diamond"} x={x - 3.5} y={y - 3.5} width="7" height="7" transform={`rotate(45 ${x} ${y})`} />;
}

/** A product icon placed in the drawing with its top left at (x, y). */
export function Ico({ name, x, y, size = 14, blue }: { name: IconName; x: number; y: number; size?: 12 | 14 | 16; blue?: boolean }) {
  return (
    <g className={blue ? "il-ic il-ic-blue" : "il-ic"} transform={`translate(${x} ${y})`}>
      <Icon name={name} size={size} />
    </g>
  );
}

/** A hairline square holding one icon, top left at (x, y). `blue` draws the live state. */
export function IconBox({ x, y, name, size = 28, blue }: { x: number; y: number; name: IconName; size?: number; blue?: boolean }) {
  const ic = size >= 26 ? 14 : 12;
  return (
    <>
      <rect className={blue ? "il-box il-box-on" : "il-box"} x={x} y={y} width={size} height={size} />
      <Ico name={name} x={x + (size - ic) / 2} y={y + (size - ic) / 2} size={ic} blue={blue} />
    </>
  );
}
