/*
 * The stand-in QR code for the design preview, shared by setup, invites and Settings. It is drawn
 * from the secret so each key gets its own pattern, laid out like a real version 2 code (25 by 25
 * modules): three finder squares with their light margins, the timing lines and the alignment
 * square. It is not scannable; the setup key and the otpauth link beside it are the real way in,
 * so it stays aria-hidden. A real build shows the API's QR image instead.
 */

const N = 25;

/* FNV-1a over the secret seeds an xorshift32 stream: the same secret always draws the same code. */
function bitStream(seed: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  let x = h || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return (x & 1) === 1;
  };
}

/* Concentric squares: dark ring, light ring, dark core. `ring` 0 is the outer edge. */
const square = (ring: number, darkRings: number[]) => darkRings.includes(ring);

/** The fixed parts of the code at (r, c), or null where data modules go. */
function fixedModule(r: number, c: number): boolean | null {
  // Finder squares (7 by 7) and their one-module light margin.
  for (const [fr, fc] of [
    [0, 0],
    [0, N - 7],
    [N - 7, 0],
  ] as const) {
    const y = r - fr;
    const x = c - fc;
    if (y >= -1 && y <= 7 && x >= -1 && x <= 7) {
      if (y < 0 || y > 6 || x < 0 || x > 6) return false;
      return square(Math.min(y, x, 6 - y, 6 - x), [0, 2, 3]);
    }
  }
  // Alignment square (5 by 5) centred on module 18, 18.
  const ay = r - 16;
  const ax = c - 16;
  if (ay >= 0 && ay <= 4 && ax >= 0 && ax <= 4) return square(Math.min(ay, ax, 4 - ay, 4 - ax), [0, 2]);
  // Timing lines between the finders.
  if (r === 6) return c % 2 === 0;
  if (c === 6) return r % 2 === 0;
  return null;
}

/** 25 by 25 modules on the page colour; `className` sizes it (the module size is a CSS var). */
export function PseudoQr({ secret, className }: { secret: string; className?: string }) {
  const next = bitStream(secret);
  const cells: boolean[] = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) cells.push(fixedModule(r, c) ?? next());

  return (
    <div className={`auth-qr${className ? ` ${className}` : ""}`} aria-hidden="true">
      {cells.map((on, i) => (
        <span key={i} data-on={on ? "" : undefined} />
      ))}
    </div>
  );
}
