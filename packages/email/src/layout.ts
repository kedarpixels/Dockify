/**
 * The one email layout: the dashboard's ruled frame. Hand-written for mail clients: nested tables,
 * inline styles, bgcolor and width attributes for Outlook. Light is the inline default; dark comes
 * from a prefers-color-scheme block that overrides by class, so a client that ignores it keeps the
 * light design instead of a broken half-dark one.
 *
 * The frame is a nine-column table: gutter | 2 | rail | 2 | 594 | 2 | rail | 2 | gutter. The two
 * 1px rails stand 600px apart on a white page that runs edge to edge; every rule crosses the whole
 * page, and a 5px node sits on each crossing (the 2px columns beside each rail are the node's
 * overhang). Sections are parted by 40px dither bands: a 6px checker tile as the background image
 * of the band cells, over a solid light grey, which is what Outlook for Windows paints instead.
 *
 * Brand assets ride on the instance's own origin: the whale, the tone badge, the kind tiles and
 * folder, the dither tiles, the fact and footer icons and the button arrow. Every word is real text:
 * "Dockify" in the header and each title in Geist Pixel Square, the rest in Geist. Two faces load
 * with @font-face inside @media screen (Apple Mail, iOS and Samsung render them; Outlook for Windows
 * never sees the rule and keeps its fallback instead of swapping the message to Times New Roman).
 * Gmail drops web fonts, so there the text is Helvetica Neue or Arial, at the same size and spacing.
 *
 * An image with a dark variant is a pair: the light one shows inline, the dark one is hidden inline
 * and the dark rules swap them. A client without prefers-color-scheme (Gmail) keeps the light one.
 *
 * Phones: one media query lets the 594px column give way, so the rails sit at the screen edges,
 * fact labels stack over their values, and a project chip loses its dividers and wraps between
 * its segments. No scripts, forms, stylesheet links or @import: clients block them and the tests
 * forbid them.
 *
 * `theme` forces one look for the dashboard preview: "light" drops the dark block, "dark" applies
 * it without the media query. Real sends use "auto".
 */
import { esc, safeUrl } from "./html.ts";

export type Theme = "auto" | "light" | "dark";

/** The accent a message carries: the glyph in its key tile. */
export type Tone = "info" | "success" | "warning" | "critical";

export interface EmailMessage {
  subject: string;
  html: string;
  text: string;
}

/** An app's kind, as the apps table stores it. It picks the kind tile in a project chip. */
export type AppKind = "frontend" | "backend" | "bot" | "postgres" | "redis" | "s3";

/** Where something happened, as the dashboard shows it: the project, its environment and the app. */
export interface AppRef {
  projectName: string;
  projectSlug: string;
  /** "production", "development", ... */
  env: string;
  appName: string;
  appKind: AppKind;
  /** A public, signed link to the project's own icon (/api/icons/mail/<token>). Absent or null shows the folder tile. */
  projectIcon?: string | null;
  /** The same for the app: its upload or favicon. Absent or null shows the kind tile. */
  appIcon?: string | null;
}

/** The plain spelling of a place, for subjects and the text part: "horseai / production / web". */
export const whereText = (where: AppRef | string): string => (typeof where === "string" ? where : `${where.projectSlug} / ${where.env} / ${where.appName}`);

/** A fact's value: text, or a place shown as the dashboard's project chip. */
export type FactValue = string | AppRef;

/** One fact row: label, value and, optionally, the fact icon to use instead of the one its label picks. */
export type FactRow = readonly [label: string, value: FactValue, icon?: FactIcon];

export type Block =
  | { kind: "p"; text: string }
  | { kind: "code"; code: string; label: string }
  | { kind: "button"; label: string; url: string }
  /** A secondary link in the blue text colour, under the copy it belongs to. Never a second button. */
  | { kind: "link"; label: string; url: string }
  | { kind: "facts"; rows: ReadonlyArray<FactRow> }
  | { kind: "note"; text: string }
  /** A few lines of build output, shown as they are in a monospaced tile. Text only: never parsed. */
  | { kind: "log"; label: string; lines: readonly string[] };

export interface Email {
  subject: string;
  /** The grey line inbox lists show after the subject. */
  preheader: string;
  heading: string;
  blocks: Block[];
  /** The accent. Defaults to "info" (the blue). */
  tone?: Tone;
  /** Why this email was sent, for the footer. A full sentence. */
  reason: string;
  /** What to do if the reader did not expect it. A full sentence, or null for none. */
  ignore: string | null;
}

export interface Brand {
  /** The Dockify instance name the owner chose at setup. */
  instanceName: string;
  /** The dashboard's public origin, so the logo, icons and fonts load from it. No origin, no assets. */
  origin?: string;
}

// No system UI faces: where web fonts are dropped, Helvetica Neue or Arial is the closest clean match
// to Geist and reads the same on every platform, with no Segoe drifting in on Windows.
const SANS = "'Geist','Helvetica Neue',Helvetica,Arial,sans-serif";
// The dashboard's page-heading face (--font-pixel). Falls back to Geist, then the same stack.
const PIXEL = "'Geist Pixel Square','Geist','Helvetica Neue',Helvetica,Arial,sans-serif";

/** foundation.css tokens: light inline, dark by class. */
interface Palette {
  bg: string;
  line: string;
  node: string;
  /** What a client without background images paints for a dither band. */
  band: string;
  ink: string;
  ink2: string;
  ink3: string;
  blue: string;
}

const L: Palette = { bg: "#ffffff", line: "#e8e8e8", node: "#d4d4d4", band: "#f5f5f5", ink: "#0a0a0a", ink2: "#404040", ink3: "#737373", blue: "#0070f3" };
const D: Palette = { bg: "#0a0a0a", line: "#1e1e1e", node: "#333333", band: "#111111", ink: "#ededed", ink2: "#bdbdbd", ink3: "#8f8f8f", blue: "#0070f3" };

/** The drawn glyph a key tile shows when there is no origin to load the badge image from. */
const GLYPH: Record<Tone, { char: string; light: string; dark: string }> = {
  info: { char: "i", light: "#0070f3", dark: "#52a8ff" },
  success: { char: "✓", light: "#1a7f37", dark: "#57c47d" },
  warning: { char: "!", light: "#9a5e08", dark: "#e9bd73" },
  critical: { char: "!", light: "#c62a2f", dark: "#ff8a8d" },
};

/** A URL inside a single-quoted CSS url(''): drop line breaks and escape what could end the string. */
const cssUrl = (u: string) => u.replace(/[\n\r]/g, "").replace(/[\\']/g, (c) => `\\${c}`);

/** An absolute, checked URL of one brand asset on the instance origin. */
const asset = (origin: string, file: string) => safeUrl(`${origin}/${file}`);

function darkRules(origin?: string): string {
  const dither = origin ? `;background-image:url('${cssUrl(asset(origin, "dk-dither-dark.png"))}')!important` : "";
  return [
    `.dk-bg{background-color:${D.bg}!important}`,
    `.dk-line{background-color:${D.line}!important}`,
    `.dk-node{background-color:${D.node}!important}`,
    `.dk-dither{background-color:${D.band}!important${dither}}`,
    `.dk-ink{color:${D.ink}!important}`,
    `.dk-ink2{color:${D.ink2}!important}`,
    `.dk-muted{color:${D.ink3}!important}`,
    `.dk-rule{border-color:${D.line}!important}`,
    `.dk-key{background-color:${D.bg}!important;border-color:${D.line}!important}`,
    `.dk-link{color:${GLYPH.info.dark}!important}`,
    ".dk-l{display:none!important}.dk-d{display:inline-block!important}.dk-db{display:block!important}",
    ...(["info", "success", "warning", "critical"] as const).map((t) => `.dk-glyph-${t}{color:${GLYPH[t].dark}!important}`),
  ].join("");
}

/**
 * Phones: the 594px column gives way (gutters to 0, the inner cells to auto), the rails sit at the
 * edges, content padding tightens, the title steps down one size, a fact label stacks over its
 * value, and a project chip drops its dividers and wraps between segments, so no divider can
 * start a line.
 */
const PHONE =
  "@media (max-width:620px){" +
  ".dk-gut{width:0!important}.dk-in{width:auto!important}" +
  ".dk-pad{padding-left:20px!important;padding-right:20px!important}" +
  ".dk-h1{font-size:28px!important;line-height:36px!important}" +
  ".dk-lab{display:block!important;width:auto!important;padding:0 0 4px!important}.dk-val{display:block!important}" +
  ".dk-div{display:none!important}.dk-seg{display:inline-block!important;padding:2px 14px 2px 0!important}" +
  ".dk-code{font-size:28px!important;letter-spacing:7px!important;padding:12px 18px 12px 25px!important}" +
  "}";

/**
 * Separate style tags, each one rule set: Gmail is known to throw away a whole tag over an at-rule it
 * dislikes, and nested at-rules (the faces, the dark block) must not take the frame's rules with them.
 */
function styleBlock(theme: Theme, origin?: string): string {
  // A font fetch is not a stylesheet link or @import, so the safety tests allow it. The rules sit
  // in @media screen, which Outlook for Windows ignores, so it keeps the fallback stack.
  const font = (family: string, weight: string, file: string) =>
    `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url('${cssUrl(asset(origin ?? "", file))}') format('woff2')}`;
  const faces = origin ? `@media screen{${font("Geist", "100 900", "geist-sans.woff2")}${font("Geist Pixel Square", "400 700", "geist-pixel.woff2")}}` : "";
  const base =
    // border-collapse:separate keeps border-radius on bordered cells (collapsed borders square the
    // corners in WebKit); every table carries cellspacing="0" and border-spacing 0, so the grid
    // stays seamless.
    "body{margin:0;padding:0;-webkit-text-size-adjust:100%}table{border-collapse:separate;border-spacing:0}td{padding:0}a{text-decoration:none}img{border:0;outline:none}" +
    PHONE;
  const tag = (css: string) => (css ? `<style>${css}</style>` : "");
  const head = tag(base) + tag(faces);
  if (theme === "light") return head;
  if (theme === "dark") return head + tag(darkRules(origin));
  // Outlook.com marks a darkened message with data-ogsc instead of answering the media query.
  return `${head}${tag(`@media (prefers-color-scheme:dark){${darkRules(origin)}}`)}${tag("[data-ogsc] .dk-l{display:none!important}[data-ogsc] .dk-d{display:inline-block!important}[data-ogsc] .dk-db{display:block!important}")}`;
}

// ---------------------------------------------------------------- the grid

const INNER = 594;
/** A cell that is only colour. */
const Z = "font-size:0;line-height:0;mso-line-height-rule:exactly;";

const cell = (cls: string, color: string, attrs: string, style: string) =>
  `<td${attrs ? ` ${attrs}` : ""} class="${cls}" bgcolor="${color}" style="background-color:${color};${Z}${style}"></td>`;
const bgCell = (style = "", attrs = "", cls = "") => cell(`dk-bg${cls}`, L.bg, attrs, style);
const gutCell = (style = "", attrs = "") => cell("dk-bg dk-gut", L.bg, attrs, style);
const lineCell = (style = "", attrs = "", cls = "") => cell(`dk-line${cls}`, L.line, attrs, style);
const nodeCell = (w: number, style = "") => cell("dk-node", L.node, `width="${w}"`, `width:${w}px;${style}`);
/** A dither cell: the 6px tile over a solid fallback; x and y shift the tile so neighbouring cells stay in phase. */
function ditherCell(origin: string | undefined, x: number, y: number, style = "", attrs = "", cls = ""): string {
  const image = origin ? `background-image:url(${esc(asset(origin, "dk-dither-light.png"))});background-repeat:repeat;background-position:${x}px ${y}px;` : "";
  return `<td${attrs ? ` ${attrs}` : ""} class="dk-dither${cls}" bgcolor="${L.band}" style="background-color:${L.band};${image}${Z}${style}"></td>`;
}

/** The rail column cell for a content row: 1px of line colour. */
const rail = () => lineCell("width:1px;", 'width="1"');

type Ground = "bg" | "dither";

/**
 * One rule across the page: three rows (2 + 1 + 2 px) so the 5px nodes centre on the hairline.
 * `above` and `below` say what the 2px strips sit on: the page or a dither band.
 */
function rule(origin: string | undefined, above: Ground, below: Ground): string {
  const strip = (ground: Ground, y: number) => {
    const h = 'height="2"';
    const hs = "height:2px;";
    const g = (x: number) => (ground === "dither" ? ditherCell(origin, x, y, hs, h, " dk-gut") : gutCell(hs, h));
    const c = ground === "dither"
      ? ditherCell(origin, -2, y, `width:${INNER}px;${hs}`, `width="${INNER}" ${h}`, " dk-in")
      : bgCell(`width:${INNER}px;${hs}`, `width="${INNER}" ${h}`, " dk-in");
    return `<tr>${g(0)}${nodeCell(2, hs)}${nodeCell(1, hs)}${nodeCell(2, hs)}${c}${nodeCell(2, hs)}${nodeCell(1, hs)}${nodeCell(2, hs)}${g(-2)}</tr>`;
  };
  const hair = `<tr>${lineCell("height:1px;", 'height="1"', " dk-gut")}${nodeCell(2, "height:1px;")}${nodeCell(1, "height:1px;")}${nodeCell(2, "height:1px;")}${lineCell(`width:${INNER}px;height:1px;`, `width="${INNER}" height="1"`, " dk-in")}${nodeCell(2, "height:1px;")}${nodeCell(1, "height:1px;")}${nodeCell(2, "height:1px;")}${lineCell("height:1px;", 'height="1"', " dk-gut")}</tr>`;
  // The band interior is 40px: rows 0-1 are the top rule's lower strip, 38-39 the bottom rule's upper strip (38 mod 6 = 2).
  return strip(above, above === "dither" ? -2 : 0) + hair + strip(below, 0);
}

/** The 36px body of a dither band; with the two 2px strips of its rules it is the dashboard's 40px of dither. */
function band(origin: string | undefined): string {
  const d = (attrs: string) => ditherCell(origin, 0, -2, "height:36px;", `${attrs} height="36"`);
  return `<tr>${d('colspan="2"')}${rail()}${d('colspan="3"')}${rail()}${d('colspan="2"')}</tr>`;
}

/** A section break: rule, 36px of dither, rule. */
const sep = (origin: string | undefined) => rule(origin, "bg", "dither") + band(origin) + rule(origin, "dither", "bg");

/** A content row: the 598px between the rails, with its own padding. */
function row(inner: string, o: { pad?: string; border?: boolean; height?: number } = {}): string {
  const pad = o.pad ?? "0 32px";
  const b = o.border ? `border-top:1px solid ${L.line};` : "";
  const h = o.height ? ` height="${o.height}"` : "";
  const hs = o.height ? `height:${o.height}px;` : "";
  return `<tr>${gutCell()}${bgCell("width:2px;", 'width="2"')}${rail()}<td colspan="3"${h} class="dk-bg dk-pad${o.border ? " dk-rule" : ""}" bgcolor="${L.bg}" valign="middle" style="background-color:${L.bg};padding:${pad};${b}${hs}vertical-align:middle">${inner}</td>${rail()}${bgCell("width:2px;", 'width="2"')}${gutCell()}</tr>`;
}

// ---------------------------------------------------------------- the pieces

const T = (size: number, lh: number, weight: number, color: string) => `font-family:${SANS};font-size:${size}px;line-height:${lh}px;font-weight:${weight};color:${color};`;

/**
 * A light and dark pair of one image. `style` is shared; the dark one starts hidden, and the dark
 * rules swap them (`block` picks which display it swaps to). Outlook for Windows skips the dark one.
 */
function pair(light: string, dark: string, attrs: string, style: string, block: boolean): string {
  const shown = block ? "dk-db" : "dk-d";
  return `<img class="dk-l" src="${esc(light)}" ${attrs} style="${style}"><!--[if !mso]><!--><img class="${shown}" src="${esc(dark)}" ${attrs} style="${style}display:none;mso-hide:all"><!--<![endif]-->`;
}

/** A vertical gap between two items in one content row. */
const GAP = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="24" style="height:24px;font-size:0;line-height:0;mso-line-height-rule:exactly">&nbsp;</td></tr></table>`;

/**
 * The head: the whale, "Dockify" as text in the dashboard's wordmark face (Geist Pixel Square, 18px,
 * weight 400), and the instance name at the right end. With no origin (no assets) a blue "D" tile
 * stands in for the whale.
 */
function head(instance: string, origin?: string): string {
  const logo = origin
    ? `<img src="${esc(asset(origin, "dk-logo.png"))}" width="40" height="29" alt="" style="display:block;width:40px;height:29px;border:0;outline:none">`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="30" height="30" align="center" valign="middle" bgcolor="${L.blue}" style="width:30px;height:30px;border-radius:8px;background-color:${L.blue};${T(16, 30, 700, "#ffffff")}">D</td></tr></table>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle;width:${origin ? 40 : 30}px">${logo}</td>
<td class="dk-ink" style="vertical-align:middle;padding-left:12px;font-family:${PIXEL};font-size:18px;line-height:24px;font-weight:400;color:${L.ink}">Dockify</td>
<td class="dk-muted" align="right" style="vertical-align:middle;text-align:right;${T(13, 18, 400, L.ink3)}">${esc(instance)}</td>
</tr></table>`;
}

/**
 * The 40px key tile at the top of the card (the dashboard's IconTile on surface-key) holding the
 * tone's geist-icon as an image, so it looks identical in every client. No origin, no image: a
 * drawn glyph in the tone's colour, swapped for dark by class.
 */
function keyTile(tone: Tone, origin?: string): string {
  const inner = origin
    ? pair(asset(origin, `dk-badge-${tone}.png`), asset(origin, `dk-badge-${tone}-dark.png`), 'width="18" height="18" alt=""', "display:block;width:18px;height:18px;border:0;outline:none;", true)
    : `<span class="dk-glyph-${tone}" style="${T(18, 38, 700, GLYPH[tone].light)}">${esc(GLYPH[tone].char)}</span>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="38" height="38" align="center" valign="middle" class="dk-key" bgcolor="${L.bg}" style="width:38px;height:38px;border:1px solid ${L.line};border-radius:10px;background-color:${L.bg};font-size:0;line-height:0">${inner}</td>
</tr></table>`;
}

/** The title in the dashboard's pixel display face, set like its page headings (32/40, -0.01em). */
function title(text: string): string {
  return `<h1 class="dk-ink dk-h1" style="margin:0;font-family:${PIXEL};font-feature-settings:'ss09';font-size:32px;line-height:40px;font-weight:400;letter-spacing:-0.32px;color:${L.ink}">${esc(text)}</h1>`;
}
const lead = (text: string) => `<p class="dk-muted" style="margin:8px 0 0;${T(15, 24, 400, L.ink3)}">${esc(text)}</p>`;
const para = (text: string) => `<p class="dk-ink2" style="margin:0;${T(15, 24, 400, L.ink2)}">${esc(text)}</p>`;
const note = (text: string) => `<p class="dk-muted" style="margin:0;${T(13, 20, 400, L.ink3)}">${esc(text)}</p>`;

function code(value: string, label: string): string {
  // One block, not per-digit cells: it selects and copies as the bare "482913" in a single tap, where
  // separate cells copy with tabs between them and no mail client can offer a working copy button (no
  // JS). Tabular figures keep the digits evenly spaced; the extra left padding cancels the trailing
  // letter-spacing so the number sits optically centred in its tile.
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td>
<div class="dk-muted" style="${T(11, 16, 600, L.ink3)}letter-spacing:1px;text-transform:uppercase;margin-bottom:10px">${esc(label)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="dk-code dk-key dk-ink" bgcolor="${L.bg}" align="center" aria-label="${esc(label)}" style="padding:14px 24px 14px 34px;background-color:${L.bg};border:1px solid ${L.line};border-radius:10px;font-family:${SANS};font-size:34px;line-height:40px;font-weight:600;letter-spacing:10px;font-variant-numeric:tabular-nums;mso-line-height-rule:exactly;color:${L.ink}">${esc(value)}</td></tr></table>
</td></tr></table>`;
}

/** Build output: 12/18 monospace in a keyed tile, wrapping long lines. Every line escaped. */
function logBlock(label: string, lines: readonly string[]): string {
  const mono = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";
  const body = lines.map((l) => esc(l)).join("<br>");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed"><tr><td>
<div class="dk-muted" style="${T(11, 16, 600, L.ink3)}letter-spacing:1px;text-transform:uppercase;margin-bottom:10px">${esc(label)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed"><tr><td class="dk-key dk-ink2" bgcolor="${L.bg}" style="padding:12px 14px;background-color:${L.bg};border:1px solid ${L.line};border-radius:10px;font-family:${mono};font-size:12px;line-height:18px;mso-line-height-rule:exactly;color:${L.ink2};word-break:break-word;overflow-wrap:anywhere">${body}</td></tr></table>
</td></tr></table>`;
}

/** The dashboard's primary button: 36px, radius 8, solid blue, 14px medium, the arrow glyph after the label. */
function button(label: string, rawUrl: string, origin?: string): string {
  const url = esc(safeUrl(rawUrl));
  // A white 16px ArrowRight (the dashboard's own geist-icon) after the label. The key's 8px gap is
  // drawn into the image: Gmail drops a margin with a negative side, and Outlook drops image padding.
  // Image off or an old client just drops it, and the labelled button stands on its own.
  const arrow = origin
    ? `<img src="${esc(asset(origin, "dk-arrow-gap.png"))}" width="24" height="16" alt="" style="display:inline-block;vertical-align:-3px;width:24px;height:16px;border:0">`
    : "";
  // The button only: the link carries a secret token, so the raw URL is never shown as copyable text.
  // Padding on the td, not the anchor: Word ignores padding on an inline-block <a>, so the blue box
  // would hug the label in Outlook. On the td it holds everywhere.
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td class="dk-btn" align="center" height="36" bgcolor="${L.blue}" style="height:36px;padding:0 16px;border-radius:8px;background-color:${L.blue};mso-line-height-rule:exactly">
<a href="${url}" target="_blank" rel="noopener" style="display:block;${T(14, 20, 500, "#ffffff")}text-decoration:none;white-space:nowrap">${esc(label)}${arrow}</a>
</td></tr></table>`;
}

/** A secondary link: 14px medium in the accent blue (a lighter blue in dark, by class), no underline, as the dashboard's text links. */
function textLink(label: string, rawUrl: string): string {
  return `<a href="${esc(safeUrl(rawUrl))}" target="_blank" rel="noopener" class="dk-link" style="${T(14, 20, 500, L.blue)}text-decoration:none">${esc(label)}</a>`;
}

/** A button and the link that follows it share one row: stacked, a text link never lines up with a rounded button's edge. */
function buttonWithLink(btn: string, link: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle">${btn}</td><td width="16" style="width:16px;font-size:0;line-height:0">&nbsp;</td><td valign="middle">${link}</td></tr></table>`;
}

/** The fact icons that exist as /dk-f-<name>.png on the instance origin. */
export type FactIcon = "device" | "ip" | "time" | "app" | "source" | "github" | "role" | "user" | "mail" | "why" | "version" | "commit" | "database" | "status";

// A small muted geist-icon for a fact row, chosen by its label unless the row names one. Order
// matters: the first match wins ("IP address" must reach ip before "address" reaches mail).
const FACT_ICONS: ReadonlyArray<readonly [RegExp, FactIcon]> = [
  [/device/i, "device"],
  [/\bip\b/i, "ip"],
  [/when|start|fail|resolved|expir/i, "time"],
  [/app|where/i, "app"],
  [/source/i, "source"],
  [/role/i, "role"],
  [/invited|sent by/i, "user"],
  [/address|from|email/i, "mail"],
  [/why|what/i, "why"],
  [/version|before/i, "version"],
];
export const factIcon = (label: string): FactIcon | null => FACT_ICONS.find(([re]) => re.test(label))?.[1] ?? null;

/** The kind tiles that exist as /dk-kind-<name>.png on the instance origin, by app kind. */
const KIND_TILE: Record<AppKind, string> = { frontend: "web", backend: "api", bot: "bot", postgres: "postgres", redis: "redis", s3: "minio" };

const ENV_NAMES: Record<string, string> = { production: "Production", development: "Development", preview: "Preview", staging: "Staging" };
const envName = (env: string) => ENV_NAMES[env] ?? env.charAt(0).toUpperCase() + env.slice(1);

/**
 * The project chip, as the dashboard draws it: the project's icon (its upload, else the folder),
 * its name, the EnvTag (the branch glyph; ink for production, muted for the rest) and the app
 * with its icon (its upload or favicon, else its kind tile), parted by thin vertical dividers in
 * the frame's line colour. Each segment is a cell, so the chip is one line; on phones the dividers
 * hide and the segments wrap between themselves. No origin, no images: the three names stand alone.
 */
function chip(ref: AppRef, origin?: string): string {
  const prod = ref.env === "production";
  const pic = (src: string | null | undefined, fallback: string, px: number, gap: number, rounded: boolean) => {
    if (!origin) return "";
    const url = src ? safeUrl(src) : asset(origin, fallback);
    return `<img src="${esc(url)}" width="${px}" height="${px}" alt="" style="display:inline-block;vertical-align:middle;width:${px}px;height:${px}px;border:0;outline:none;margin-right:${gap}px;${rounded ? "border-radius:6px;" : ""}">`;
  };
  const seg = (inner: string) => `<td class="dk-seg" style="vertical-align:middle;white-space:nowrap">${inner}</td>`;
  const divider =
    `<td class="dk-div" style="vertical-align:middle;padding:0 12px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${lineCell("width:1px;height:16px;", 'width="1" height="16"')}</tr></table></td>`;
  const name = (text: string, cls: string, size: number, weight: number, color: string) =>
    `<span class="${cls}" style="${T(size, 20, weight, color)}vertical-align:middle">${esc(text)}</span>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
${seg(pic(ref.projectIcon, "dk-folder.png", 24, 8, !!ref.projectIcon) + name(ref.projectName, "dk-ink", 14, 500, L.ink))}
${divider}
${seg(pic(null, "dk-f-source.png", 14, 5, false) + name(envName(ref.env), prod ? "dk-ink" : "dk-muted", 13, 400, prod ? L.ink : L.ink3))}
${divider}
${seg(pic(ref.appIcon, `dk-kind-${KIND_TILE[ref.appKind]}.png`, 24, 8, !!ref.appIcon) + name(ref.appName, "dk-ink", 14, 500, L.ink))}
</tr></table>`;
}

/** One fact row, rail to rail: the label with its glyph in a 146px column, the value beside it. */
function factRow([label, value, icon]: FactRow, origin?: string): string {
  const name = origin ? (icon ?? factIcon(label)) : null;
  const ic = name
    ? pair(asset(origin ?? "", `dk-f-${name}.png`), asset(origin ?? "", `dk-f-${name}-dark.png`), 'width="14" height="14" alt=""', "width:14px;height:14px;border:0;vertical-align:-2px;margin-right:8px;", false)
    : "";
  const v = typeof value === "string" ? `<span class="dk-ink" style="${T(14, 20, 500, L.ink)}word-break:break-word">${esc(value)}</span>` : chip(value, origin);
  const inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="146" class="dk-lab dk-muted" style="width:146px;vertical-align:middle;padding-right:16px;${T(13, 20, 500, L.ink3)}">${ic}${esc(label)}</td>
<td class="dk-val" style="vertical-align:middle">${v}</td>
</tr></table>`;
  return row(inner, { pad: "10px 32px", border: true });
}

function textBlock(b: Block): string {
  switch (b.kind) {
    case "p":
    case "note":
      return b.text;
    case "log":
      return `${b.label}:\n${b.lines.join("\n")}`;
    case "code":
      return `${b.label}: ${b.code}`;
    case "button":
    case "link":
      return `${b.label}: ${safeUrl(b.url)}`;
    case "facts":
      return b.rows.map(([k, v]) => `${k}: ${whereText(v)}`).join("\n");
  }
}

/** The project's public repository and website, which the footer links to. */
export const REPO_URL = "https://github.com/kedarpixels/Dockify";
export const SITE_URL = "https://dockify.sh";

/** A row of brand links under the footer text: the project's GitHub repository and its website,
 * drawn with the dashboard's muted geist-icons. The images load from the instance, so the row is
 * drawn only when an origin carries them. */
function social(origin: string): string {
  const link = (href: string, name: string, alt: string) =>
    `<td style="padding-right:14px"><a href="${esc(safeUrl(href))}" target="_blank" rel="noopener" style="text-decoration:none">${pair(asset(origin, `${name}.png`), asset(origin, `${name}-dark.png`), `width="18" height="18" alt="${alt}"`, "display:block;width:18px;height:18px;border:0;outline:none;", true)}</a></td>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px"><tr>
${link(REPO_URL, "dk-s-github", "GitHub")}
${link(SITE_URL, "dk-s-web", "Dockify website")}
</tr></table>`;
}

/** The instance origin as scheme://host[:port], whatever the caller passed (a trailing slash, a path,
 * spaces). Anything that is not an http(s) URL means no brand assets rather than broken ones. */
function originOf(raw: string | undefined): string | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The card: the key tile, the pixel title and the lead (the first paragraph) as the sign-in card
 * lays out its head, then the blocks. Runs of text, buttons, codes and notes become padded rows
 * with 24px between items; facts become rail-to-rail rows, and a run after them sits on a rule.
 */
function card(email: Email, tone: Tone, origin?: string): string {
  const rows: string[] = [];
  let run: string[] = [];
  let first = true;
  let afterFacts = false;
  const push = (html: string) => {
    if (run.length) run.push(GAP);
    run.push(html);
  };
  const flush = (last: boolean) => {
    if (!run.length) return;
    const top = first ? 32 : afterFacts ? 20 : 0;
    const bottom = last ? 32 : 24;
    rows.push(row(run.join(""), { pad: `${top}px 32px ${bottom}px`, border: afterFacts }));
    run = [];
    first = false;
    afterFacts = false;
  };
  const blocks = [...email.blocks];
  const leadBlock = blocks[0]?.kind === "p" ? blocks.shift() : undefined;
  const leadText = leadBlock && leadBlock.kind === "p" ? leadBlock.text : null;
  push(
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td>${keyTile(tone, origin)}</td></tr><tr><td height="24" style="height:24px;font-size:0;line-height:0;mso-line-height-rule:exactly">&nbsp;</td></tr></table>` +
      title(email.heading) +
      (leadText ? lead(leadText) : ""),
  );
  blocks.forEach((b, i) => {
    switch (b.kind) {
      case "p":
        push(para(b.text));
        break;
      case "note":
        push(note(b.text));
        break;
      case "code":
        push(code(b.code, b.label));
        break;
      case "log":
        push(logBlock(b.label, b.lines));
        break;
      case "button": {
        const next = blocks[i + 1];
        push(next?.kind === "link" ? buttonWithLink(button(b.label, b.url, origin), textLink(next.label, next.url)) : button(b.label, b.url, origin));
        break;
      }
      case "link":
        if (blocks[i - 1]?.kind !== "button") push(textLink(b.label, b.url));
        break;
      case "facts":
        flush(false);
        for (const r of b.rows) rows.push(factRow(r, origin));
        afterFacts = true;
        break;
    }
    if (i === blocks.length - 1) flush(true);
  });
  flush(true);
  return rows.join("\n");
}

/** Renders one email into its subject, HTML and plain text parts. */
export function render(email: Email, brand: Brand, theme: Theme = "auto"): EmailMessage {
  const instance = brand.instanceName.trim() || "Dockify";
  const origin = originOf(brand.origin);
  const tone = email.tone ?? "info";
  const scheme = theme === "auto" ? "light dark" : theme;
  const footer = [`Sent by ${instance} running Dockify.`, email.reason, email.ignore].filter((s): s is string => !!s);

  const foot = footer
    .map((line, i) => `<p class="${i === 0 ? "dk-ink2" : "dk-muted"}" style="margin:0 0 ${i === footer.length - 1 ? 0 : 4}px;${T(13, 20, i === 0 ? 500 : 400, i === 0 ? L.ink2 : L.ink3)}">${esc(line)}</p>`)
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="${scheme}">
<meta name="supported-color-schemes" content="${scheme}">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(email.subject)}</title>
${styleBlock(theme, origin)}
</head>
<body class="dk-bg" bgcolor="${L.bg}" style="margin:0;padding:0;background-color:${L.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${esc(email.preheader)}${"&#847;&zwnj;&nbsp;".repeat(40)}</div>
<table role="presentation" class="dk-bg" width="100%" bgcolor="${L.bg}" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${L.bg}">
${row(head(instance, origin), { pad: "0 32px", height: 56 })}
${rule(origin, "bg", "bg")}
${row("", { height: 24 })}
${sep(origin)}
${card(email, tone, origin)}
${sep(origin)}
${row(foot + (origin ? social(origin) : ""), { pad: "24px 32px 28px" })}
${rule(origin, "bg", "bg")}
${row("", { height: 28 })}
</table>
</body>
</html>`;

  const text = [
    `Dockify / ${instance}`,
    "",
    email.heading,
    "",
    ...email.blocks.flatMap((b) => [textBlock(b), ""]),
    ...footer,
    "",
    `GitHub: ${REPO_URL}`,
    `Website: ${SITE_URL}`,
  ].join("\n");

  return { subject: email.subject, html, text };
}
