/**
 * SVG logos are rebuilt, not filtered: a strict XML reader (no DOCTYPE, entities, CDATA or PIs), then a new
 * document written from an allowlist, every value checked after entity decoding. Nothing of the input is
 * copied through unread, so scripts, handlers, links and external references cannot reach the output.
 */

export const SVG_MAX_BYTES = 128 * 1024;
const MAX_ELEMENTS = 4_000;
const MAX_DEPTH = 64;
const MAX_ATTRIBUTES = 64;
const MAX_VALUE = 64 * 1024;
const MAX_PX = 4096;

export type SvgResult = { ok: true; svg: string; width: number; height: number } | { ok: false; reason: string };

interface Node {
  name: string;
  attrs: Array<[string, string]>;
  children: Array<Node | string>;
}

class SvgError extends Error {}
const fail = (reason: string): never => {
  throw new SvgError(reason);
};

const NAME = /^[A-Za-z_][\w.:-]{0,63}/;
const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Decodes the five XML entities and character references; anything else is not well-formed here. */
function decode(s: string): string {
  return s.replace(/&([^;&\s]{0,12});?/g, (whole, ref: string) => {
    if (!whole.endsWith(";")) fail("The SVG has a stray &");
    if (ref in ENTITY) return ENTITY[ref]!;
    const m = /^#(?:x([0-9a-fA-F]{1,6})|(\d{1,7}))$/.exec(ref);
    if (!m) fail("The SVG uses an entity Dockify does not accept");
    const code = m![1] !== undefined ? parseInt(m![1], 16) : Number(m![2]);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail("The SVG has an invalid character reference");
    return String.fromCodePoint(code);
  });
}

/** A strict reader for the XML subset a logo needs. Throws SvgError on anything outside it. */
function parse(text: string): Node {
  let i = 0;
  let count = 0;
  const root: Node = { name: "#document", attrs: [], children: [] };
  const stack: Node[] = [root];
  let sawRoot = false;
  const top = () => stack[stack.length - 1]!;

  while (i < text.length) {
    const lt = text.indexOf("<", i);
    const chunk = lt < 0 ? text.slice(i) : text.slice(i, lt);
    if (chunk) {
      if (stack.length === 1) {
        if (chunk.trim()) fail("The SVG has text outside its <svg> element");
      } else {
        top().children.push(decode(chunk));
      }
    }
    if (lt < 0) break;
    i = lt;
    if (text.startsWith("<?", i)) {
      const end = text.indexOf("?>", i);
      if (end < 0) fail("The SVG has an unfinished declaration");
      const body = text.slice(i + 2, end);
      // Only the XML declaration, and only before anything else.
      if (!/^xml(\s|$)/.test(body) || sawRoot || root.children.length) fail("The SVG has a processing instruction Dockify does not accept");
      i = end + 2;
      continue;
    }
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end < 0) fail("The SVG has an unfinished comment");
      i = end + 3;
      continue;
    }
    if (text.startsWith("<!", i)) fail("The SVG has a DOCTYPE, an entity or a CDATA section, which Dockify does not accept");
    if (text.startsWith("</", i)) {
      const m = NAME.exec(text.slice(i + 2));
      if (!m) fail("The SVG has a malformed closing tag");
      const name = m![0];
      let j = i + 2 + name.length;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] !== ">") fail("The SVG has a malformed closing tag");
      if (stack.length === 1 || top().name !== name) fail("The SVG's tags do not match");
      stack.pop();
      i = j + 1;
      continue;
    }
    const m = NAME.exec(text.slice(i + 1));
    if (!m) fail("The SVG has a malformed tag");
    const node: Node = { name: m![0], attrs: [], children: [] };
    let j = i + 1 + node.name.length;
    const seen = new Set<string>();
    for (;;) {
      const ws = j;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text.startsWith("/>", j) || text[j] === ">") break;
      if (j === ws) fail("The SVG has a malformed attribute");
      const an = NAME.exec(text.slice(j));
      if (!an) fail("The SVG has a malformed attribute");
      const aname = an![0];
      j += aname.length;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] !== "=") fail("The SVG has an attribute without a value");
      j++;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      const q = text[j];
      if (q !== '"' && q !== "'") fail("The SVG has an unquoted attribute value");
      const close = text.indexOf(q!, j + 1);
      if (close < 0) fail("The SVG has an unfinished attribute value");
      const raw = text.slice(j + 1, close);
      if (raw.includes("<")) fail("The SVG has a < inside an attribute value");
      if (raw.length > MAX_VALUE) fail("The SVG has an attribute value that is too long");
      if (seen.has(aname)) fail("The SVG repeats an attribute");
      seen.add(aname);
      node.attrs.push([aname, decode(raw)]);
      if (node.attrs.length > MAX_ATTRIBUTES) fail("The SVG has an element with too many attributes");
      j = close + 1;
    }
    const selfClosing = text.startsWith("/>", j);
    i = j + (selfClosing ? 2 : 1);
    if (++count > MAX_ELEMENTS) fail("The SVG has too many elements");
    if (stack.length === 1) {
      if (sawRoot) fail("The SVG has more than one root element");
      sawRoot = true;
    }
    top().children.push(node);
    if (!selfClosing) {
      stack.push(node);
      if (stack.length - 1 > MAX_DEPTH) fail("The SVG is nested too deeply");
    }
  }
  if (stack.length !== 1) fail("The SVG ends before its tags are closed");
  const svg = root.children.find((c): c is Node => typeof c !== "string");
  if (!svg || svg.name !== "svg") fail("The file is not an SVG image");
  return svg!;
}

/** Elements a logo draws with. Anything else goes, with everything inside it. */
const ELEMENTS = new Set([
  "svg", "g", "defs", "title", "desc", "symbol", "use", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "linearGradient", "radialGradient", "stop", "clipPath", "mask",
]);
/** Wrappers whose children may be kept although the element itself goes. */
const UNWRAP = new Set(["a", "switch"]);
const DRAWS = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "use"]);
/** Elements whose text is kept: names and labels, never code. */
const TEXT_ELEMENTS = new Set(["title", "desc", "text", "tspan"]);
/** Elements that may point at another element of the same file. */
const LINKING = new Set(["use", "linearGradient", "radialGradient"]);

/** Presentation and geometry attributes, by exact name. Each is also a CSS property style= may set. */
const PRESENTATION = new Set([
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "opacity", "clip-path", "clip-rule", "mask", "color",
  "display", "visibility", "stop-color", "stop-opacity", "font-family", "font-size", "font-weight", "font-style",
  "text-anchor", "dominant-baseline", "letter-spacing", "shape-rendering", "vector-effect", "paint-order",
]);
const GEOMETRY = new Set([
  "id", "d", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "fr", "width", "height", "points",
  "viewBox", "preserveAspectRatio", "transform", "offset", "gradientUnits", "gradientTransform", "spreadMethod",
  "clipPathUnits", "maskUnits", "maskContentUnits", "dx", "dy", "version",
]);
/** Attributes whose value may be url(#id), and nothing else of the url() kind. */
const PAINT = new Set(["fill", "stroke", "clip-path", "mask"]);
const LOCAL_REF = /^#[A-Za-z_][\w.-]{0,127}$/;
const LOCAL_URL = /^url\(\s*#[A-Za-z_][\w.-]{0,127}\s*\)$/;

/** A value with nothing that could reach outside the file or run: no url() but url(#id), no scheme, no CSS escapes. */
function safeValue(name: string, value: string): string | null {
  const v = value.replace(/[\t\n\r]+/g, " ").trim();
  if (v.length > MAX_VALUE || /[\u0000-\u001f\u007f\\<>]/.test(v)) return null;
  const lower = v.toLowerCase().replace(/\s+/g, "");
  if (/(javascript|vbscript|data|https?|ftp|file):/.test(lower) || lower.includes("expression(") || lower.includes("@import")) return null;
  if (lower.includes("url(")) return PAINT.has(name) && LOCAL_URL.test(v) ? v : null;
  if (name === "id" && !/^[A-Za-z_][\w.-]{0,127}$/.test(v)) return null;
  return v;
}

function styleDeclarations(style: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const decl of style.split(";")) {
    const at = decl.indexOf(":");
    if (at < 0) continue;
    const prop = decl.slice(0, at).trim().toLowerCase();
    const value = decl.slice(at + 1).replace(/!important\s*$/i, "").trim();
    if (!PRESENTATION.has(prop) || !value) continue;
    const safe = safeValue(prop, value);
    if (safe !== null) out.push([prop, safe]);
  }
  return out;
}

function cleanAttrs(node: Node): Array<[string, string]> {
  const out = new Map<string, string>();
  let style: Array<[string, string]> = [];
  for (const [name, value] of node.attrs) {
    if (name === "style") {
      style = styleDeclarations(value);
      continue;
    }
    if ((name === "href" || name === "xlink:href") && LINKING.has(node.name)) {
      const v = value.trim();
      if (LOCAL_REF.test(v)) out.set("href", v);
      continue;
    }
    if (!PRESENTATION.has(name) && !GEOMETRY.has(name)) continue;
    const safe = safeValue(name, value);
    if (safe !== null) out.set(name, safe);
  }
  // In CSS a style declaration wins over the attribute of the same name, so it does here too.
  for (const [k, v] of style) out.set(k, v);
  return [...out];
}

interface Clean {
  name: string;
  attrs: Array<[string, string]>;
  children: Array<Clean | string>;
}

function clean(node: Node): Array<Clean | string> {
  if (UNWRAP.has(node.name)) return node.children.flatMap((c) => (typeof c === "string" ? [] : clean(c)));
  if (!ELEMENTS.has(node.name)) return [];
  const attrs = cleanAttrs(node);
  // A use that points nowhere local draws nothing; keep the file free of dangling references.
  if (node.name === "use" && !attrs.some(([k]) => k === "href")) return [];
  const children: Array<Clean | string> = [];
  for (const c of node.children) {
    if (typeof c === "string") {
      if (TEXT_ELEMENTS.has(node.name) && c.trim()) children.push(c.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, 2_000));
    } else {
      children.push(...clean(c));
    }
  }
  return [{ name: node.name, attrs, children }];
}

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, "&quot;");

function write(n: Clean, root = false): string {
  const attrs = (root ? [["xmlns", "http://www.w3.org/2000/svg"] as [string, string], ...n.attrs.filter(([k]) => k !== "xmlns")] : n.attrs)
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join("");
  if (!n.children.length) return `<${n.name}${attrs}/>`;
  return `<${n.name}${attrs}>${n.children.map((c) => (typeof c === "string" ? escapeText(c) : write(c))).join("")}</${n.name}>`;
}

const draws = (n: Clean): boolean => DRAWS.has(n.name) || n.children.some((c) => typeof c !== "string" && draws(c));

/** A length in user units or px, as a positive number; anything else (%, em, garbage) is null. */
function length(v: string | undefined): number | null {
  const m = v ? /^(\d+(?:\.\d+)?)(?:px)?$/.exec(v.trim()) : null;
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The logo's size: the viewBox, else its width and height. A logo with neither cannot be scaled. */
function size(attrs: Array<[string, string]>): { width: number; height: number } | null {
  const a = new Map(attrs);
  const vb = a.get("viewBox")?.trim().split(/[\s,]+/).map(Number);
  let w: number | null = null;
  let h: number | null = null;
  if (vb && vb.length === 4 && vb.every(Number.isFinite) && vb[2]! > 0 && vb[3]! > 0) {
    w = vb[2]!;
    h = vb[3]!;
  } else {
    w = length(a.get("width"));
    h = length(a.get("height"));
  }
  if (!w || !h) return null;
  const clamp = (n: number) => Math.min(MAX_PX, Math.max(1, Math.round(n)));
  return { width: clamp(w), height: clamp(h) };
}

/** The input must be UTF-8 text of at most SVG_MAX_BYTES, and so must the output. */
export function sanitizeSvg(input: string | Uint8Array): SvgResult {
  try {
    let text: string;
    if (typeof input === "string") {
      text = input;
    } else {
      if (input.length > SVG_MAX_BYTES) return { ok: false, reason: "Use an SVG of 128 KB or less" };
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(input);
      } catch {
        return { ok: false, reason: "The SVG is not UTF-8 text" };
      }
    }
    text = text.replace(/^﻿/, "");
    if (text.length > SVG_MAX_BYTES) return { ok: false, reason: "Use an SVG of 128 KB or less" };
    const svg = parse(text);
    const [cleaned] = clean(svg) as [Clean];
    const dims = size(cleaned.attrs);
    if (!dims) return { ok: false, reason: "Give the SVG a viewBox, or a width and height in pixels" };
    if (!draws(cleaned)) return { ok: false, reason: "The SVG has nothing Dockify can draw" };
    const out = write(cleaned, true);
    if (new TextEncoder().encode(out).length > SVG_MAX_BYTES) return { ok: false, reason: "Use an SVG of 128 KB or less" };
    return { ok: true, svg: out, ...dims };
  } catch (e) {
    if (e instanceof SvgError) return { ok: false, reason: e.message };
    return { ok: false, reason: "The SVG could not be read" };
  }
}

/** Only a hint for which check to run: sanitizeSvg decides. */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 2048)).replace(/^﻿/, "").trimStart();
  return head.startsWith("<") && /<svg[\s>/]/i.test(head);
}
