import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { SITE_HOST } from "./config";

/* Social cards, drawn in the site's own language: the ruled frame with nodes where the rules cross
   the rails, two 50% Bayer dither bands, the pixel display face for the title, Geist for the rest,
   and the blue accent. Every route ships two cards, dark first, then light. */

const OG_SIZE = { width: 1200, height: 630 };
const OG_CONTENT_TYPE = "image/png";

type Theme = "dark" | "light";

/* The foundation.css tokens for each theme. The dither runs one step darker than --cloud-core in
   dark so the checker survives the thumbnail scale; everything else is the token as is. */
const PALETTE: Record<Theme, { bg: string; ink: string; ink3: string; line: string; node: string; dither: string; blue: string }> = {
  dark: { bg: "#0a0a0a", ink: "#ededed", ink3: "#8f8f8f", line: "#1e1e1e", node: "#333333", dither: "#1a1a1a", blue: "#0a84ff" },
  light: { bg: "#ffffff", ink: "#0a0a0a", ink3: "#6b6b6b", line: "#e8e8e8", node: "#d4d4d4", dither: "#ececec", blue: "#0070f3" },
};

/* Frame geometry, in px on the 1200 x 630 card. */
const RAIL_L = 64;
const RAIL_R = 1136;
const BAND = 42;
const TOP = 96; /* the header row ends here, the first band starts */
const BOTTOM = 510; /* the second band starts here */

const ASSETS = path.join(process.cwd(), "components", "seo", "assets");

let assets: Promise<{ pixel: Buffer; regular: Buffer; medium: Buffer; logo: string }> | undefined;

function loadAssets() {
  assets ??= Promise.all([
    readFile(path.join(ASSETS, "GeistPixel-Square.ttf")),
    readFile(path.join(ASSETS, "Geist-Regular.ttf")),
    readFile(path.join(ASSETS, "Geist-Medium.ttf")),
    readFile(path.join(ASSETS, "logo.png")),
  ]).then(([pixel, regular, medium, logo]) => ({ pixel, regular, medium, logo: `data:image/png;base64,${logo.toString("base64")}` }));
  return assets;
}

/** The two image entries every opengraph-image file returns from generateImageMetadata. */
export function ogVariants(alt: string) {
  return (["dark", "light"] as const).map((id) => ({ id, alt, size: OG_SIZE, contentType: OG_CONTENT_TYPE }));
}

function dither(color: string) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_SIZE.width}" height="${BAND}" shape-rendering="crispEdges">` +
    `<defs><pattern id="d" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M0 0h3v3H0zM3 3h3v3H3z" fill="${color}"/></pattern></defs>` +
    `<rect width="100%" height="100%" fill="url(#d)"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function sizeFor(title: string) {
  if (title.length <= 24) return 92;
  if (title.length <= 46) return 74;
  return 60;
}

export type OgCard = {
  /** Display title, set in the pixel face. */
  title: string;
  /** Trailing words of the title drawn in the accent, for example "and sleep.". */
  accent?: string;
  /** Short line above the title, after the blue dot. */
  kicker: string;
  /** One line under the second band. Keep it under about 90 characters. */
  line: string;
  /** Short label at the bottom right in the accent, usually the path, for example "/install". */
  tag: string;
};

export async function renderOg(card: OgCard, id: string | number) {
  const theme: Theme = id === "light" ? "light" : "dark";
  const c = PALETTE[theme];
  const { pixel, regular, medium, logo } = await loadAssets();
  const band = dither(c.dither);

  const words = card.title.split(/\s+/);
  const accentFrom = card.accent ? words.length - card.accent.split(/\s+/).length : words.length;
  const fontSize = sizeFor(card.title);

  const hRule = (top: number) => (
    <div key={`r${top}`} style={{ position: "absolute", left: 0, top, width: OG_SIZE.width, height: 1, background: c.line }} />
  );
  const node = (x: number, y: number) => (
    <div key={`n${x}-${y}`} style={{ position: "absolute", left: x - 2, top: y - 2, width: 5, height: 5, background: c.node }} />
  );
  const crossings = [TOP, TOP + BAND + 1, BOTTOM, BOTTOM + BAND + 1];

  return new ImageResponse(
    (
      <div style={{ position: "relative", display: "flex", width: "100%", height: "100%", background: c.bg, fontFamily: "Geist" }}>
        {/* Dither bands, full bleed, between their rules. */}
        <img src={band} width={OG_SIZE.width} height={BAND} style={{ position: "absolute", left: 0, top: TOP + 1 }} />
        <img src={band} width={OG_SIZE.width} height={BAND} style={{ position: "absolute", left: 0, top: BOTTOM + 1 }} />
        {crossings.map(hRule)}

        {/* Rails, full height, over the bands. */}
        <div style={{ position: "absolute", left: RAIL_L, top: 0, width: 1, height: OG_SIZE.height, background: c.line }} />
        <div style={{ position: "absolute", left: RAIL_R, top: 0, width: 1, height: OG_SIZE.height, background: c.line }} />
        {crossings.flatMap((y) => [node(RAIL_L, y), node(RAIL_R, y)])}

        {/* Header row: the Dockify whale (the dashboard's 131 by 96 logo, drawn at 44 by 32) and the
            wordmark, host on the right. */}
        <div
          style={{
            position: "absolute",
            left: RAIL_L + 1,
            top: 0,
            width: RAIL_R - RAIL_L - 1,
            height: TOP,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 40px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <img src={logo} width={44} height={32} />
            <div style={{ fontFamily: "Geist", fontWeight: 500, fontSize: 30, color: c.ink, letterSpacing: -0.5 }}>Dockify</div>
          </div>
          <div style={{ fontSize: 22, color: c.ink3 }}>{SITE_HOST}</div>
        </div>

        {/* Body: kicker, then the title in the pixel face. */}
        <div
          style={{
            position: "absolute",
            left: RAIL_L + 1,
            top: TOP + BAND + 2,
            width: RAIL_R - RAIL_L - 1,
            height: BOTTOM - TOP - BAND - 2,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            padding: "0 40px",
            gap: 26,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 24, color: c.ink3 }}>
            <div style={{ width: 10, height: 10, borderRadius: 999, background: c.blue }} />
            {card.kicker}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", fontFamily: "Geist Pixel", fontSize, lineHeight: 1.08, letterSpacing: -1 }}>
            {words.map((w, i) => (
              <span key={i} style={{ color: i >= accentFrom ? c.blue : c.ink, marginRight: i < words.length - 1 ? fontSize * 0.32 : 0 }}>
                {w}
              </span>
            ))}
          </div>
        </div>

        {/* Footer row: one line, the tag in the accent. */}
        <div
          style={{
            position: "absolute",
            left: RAIL_L + 1,
            top: BOTTOM + BAND + 2,
            width: RAIL_R - RAIL_L - 1,
            height: OG_SIZE.height - BOTTOM - BAND - 2,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 40px",
            gap: 32,
          }}
        >
          <div style={{ display: "flex", flex: 1, fontSize: 21, lineHeight: 1.3, color: c.ink3 }}>{card.line}</div>
          <div style={{ display: "flex", flexShrink: 0, whiteSpace: "nowrap", fontWeight: 500, fontSize: 22, color: c.blue }}>{card.tag}</div>
        </div>
      </div>
    ),
    {
      ...OG_SIZE,
      fonts: [
        { name: "Geist Pixel", data: pixel, weight: 500, style: "normal" },
        { name: "Geist", data: regular, weight: 400, style: "normal" },
        { name: "Geist", data: medium, weight: 500, style: "normal" },
      ],
    },
  );
}
