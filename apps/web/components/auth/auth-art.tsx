/*
 * The sign-in art: the Dockify whale drawn in deploy-heatmap cells, rounded squares in the heat
 * levels of the Overview year grid, so the brand reads as a year of deploys. The levels come from
 * public/dockify-mark.svg sampled on a 39 by 29 grid (cell coverage: solid inside, lighter steps
 * along the edge for a clean silhouette), cropped to the lit cells. Each digit is a heat level, 0
 * empty. Plain SVG at its native size, colours from the theme tokens, so it is crisp in both themes.
 */

const ROWS = [
  "00020000000000000000000000000000000",
  "00344000443000000000000000000000000",
  "00344000444000000000000000000000000",
  "00020030230000000000000000000000000",
  "00000444000000000000000000000000000",
  "00000444000000000000000000000000000",
  "00000243000000000000000000000000020",
  "00000000000000000000000044430004444",
  "00000000000000000000000044444244443",
  "00000034444443000000000004444444440",
  "00004444444444420000000000444444400",
  "00244444444444443000000000044444000",
  "02444444444444444300000000044440000",
  "04444444444444444440000000344440000",
  "34444444444444444444000002444430000",
  "44444444444444444444430034444400000",
  "44444444444444444444444444444300000",
  "44444444444444444444444444444000000",
  "44420344444444444444444444443000000",
  "44400044444444444444444444440000000",
  "44400244444444444444444444400000000",
  "34444444444444444444444444000000000",
  "04444444444444444444444430000000000",
  "04444444444444444444444200000000000",
  "00444444444444444444430000000000000",
  "00034444444444444330000000000000000",
];

const CELL = 7;
const STEP = 9;
const WIDTH = ROWS[0]!.length * STEP - (STEP - CELL);
const HEIGHT = ROWS.length * STEP - (STEP - CELL);

/**
 * The full-bleed panel at the right of the sign-in card: a quiet surface in the theme, the whale in
 * 446 lit cells that pop in left to right like the Overview grid, and one line about the product
 * at the foot, hung from the whale's left edge. Decorative, so hidden from assistive tech.
 */
export function AuthArt() {
  return (
    <div className="auth-art" aria-hidden="true" style={{ "--art-w": `${WIDTH}px`, "--art-h": `${HEIGHT}px` } as React.CSSProperties}>
      <svg className="auth-art-grid" width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} focusable="false">
        {ROWS.flatMap((row, r) =>
          Array.from(row, (level, q) =>
            level === "0" ? null : (
              <rect
                key={`${r}-${q}`}
                x={q * STEP}
                y={r * STEP}
                width={CELL}
                height={CELL}
                rx={1.5}
                data-l={level}
                style={{ animationDelay: `${q * 16 + r * 4}ms` }}
              />
            ),
          ),
        )}
      </svg>
      <p className="auth-art-line">
        <span className="auth-art-title">Your server, every deploy.</span>
        <span className="auth-art-sub">Apps, databases, domains and backups on one VPS.</span>
      </p>
    </div>
  );
}
