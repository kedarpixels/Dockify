/*
 * A tiny Markdown reader for release notes from the signed update manifest. It returns a plain
 * tree that components/ui/markdown.tsx turns into React elements, so nothing is ever parsed as HTML:
 * raw tags stay literal text. Supported: headings, paragraphs, bullet and numbered lists, bold,
 * inline code and links. A link is kept only when it is https: or a same-origin path; any other
 * target (javascript:, data:, http:, protocol relative) leaves just its text.
 *
 * Pure and dependency free so tests/markdown.test.mjs can run it under plain `node --test`.
 */

export type MdInline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: MdInline[] }
  | { t: "link"; href: string; c: MdInline[] };

export type MdBlock =
  | { t: "heading"; level: number; c: MdInline[] }
  | { t: "p"; c: MdInline[] }
  | { t: "ul"; items: MdInline[][] }
  | { t: "ol"; items: MdInline[][] };

/** Notes longer than this are cut, so a hostile manifest cannot stall the page. */
const MAX_MARKDOWN = 20_000;

/** The link target to render, or null to show the text only. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (!href || /[\s\u0000-\u001f\\]/.test(href)) return null;
  if (href.startsWith("/")) return href.startsWith("//") ? null : href;
  if (!/^https:\/\//i.test(href)) return null;
  try {
    const u = new URL(href);
    return u.protocol === "https:" && u.hostname ? u.href : null;
  } catch {
    return null;
  }
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;

export function parseMarkdown(src: string): MdBlock[] {
  const lines = String(src ?? "").slice(0, MAX_MARKDOWN).replace(/\r\n?/g, "\n").split("\n");
  const out: MdBlock[] = [];
  let para: string[] = [];
  let list: { t: "ul" | "ol"; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) out.push({ t: "p", c: parseInline(para.join(" ")) });
    para = [];
  };
  const flushList = () => {
    if (list) out.push({ t: list.t, items: list.items.map(parseInline) });
    list = null;
  };

  for (const line of lines) {
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flushPara();
      flushList();
      out.push({ t: "heading", level: h[1]!.length, c: parseInline(h[2]!) });
      continue;
    }
    const b = BULLET.exec(line);
    const n = b ? null : NUMBERED.exec(line);
    if (b || n) {
      const kind = b ? "ul" : "ol";
      flushPara();
      if (list && list.t !== kind) flushList();
      if (!list) list = { t: kind, items: [] };
      list.items.push((b ?? n)![1]!.trim());
      continue;
    }
    // An indented line under a list item continues that item; anything else is paragraph text.
    if (list && /^\s+/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return out;
}

/** Inline spans: `code`, **bold** (or __bold__), [text](target), backslash escapes; the rest is text. */
export function parseInline(src: string, depth = 0): MdInline[] {
  const out: MdInline[] = [];
  let text = "";
  const push = (node: MdInline) => {
    if (text) out.push({ t: "text", v: text });
    text = "";
    out.push(node);
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "\\" && i + 1 < src.length && /[!-/:-@[-`{-~]/.test(src[i + 1]!)) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        push({ t: "code", v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && src[i + 1] === ch && depth < 4) {
      const mark = ch + ch;
      const end = src.indexOf(mark, i + 2);
      if (end > i + 2) {
        push({ t: "strong", c: parseInline(src.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
    }
    if (ch === "[" && depth < 4) {
      const link = readLink(src, i);
      if (link) {
        const label = parseInline(link.label, depth + 1);
        const href = safeHref(link.target);
        if (href) push({ t: "link", href, c: label });
        else
          for (const node of label) {
            if (node.t === "text") text += node.v;
            else push(node);
          }
        i = link.end;
        continue;
      }
    }
    text += ch;
    i++;
  }
  if (text) out.push({ t: "text", v: text });
  return out;
}

/** `[label](target)` starting at `at`, with balanced brackets in the label and parens in the target. */
function readLink(src: string, at: number): { label: string; target: string; end: number } | null {
  // Labels and targets are short; bounding the scan keeps a run of brackets linear.
  let depth = 0;
  let close = -1;
  for (let j = at; j < Math.min(src.length, at + 500); j++) {
    if (src[j] === "\\") {
      j++;
      continue;
    }
    if (src[j] === "[") depth++;
    else if (src[j] === "]" && --depth === 0) {
      close = j;
      break;
    }
  }
  if (close < 0 || src[close + 1] !== "(") return null;
  let parens = 0;
  for (let j = close + 1; j < Math.min(src.length, close + 2_000); j++) {
    if (src[j] === "(") parens++;
    else if (src[j] === ")" && --parens === 0) {
      const target = src.slice(close + 2, j).trim().replace(/\s+"[^"]*"$/, "");
      return { label: src.slice(at + 1, close), target, end: j + 1 };
    }
  }
  return null;
}

/** The notes as plain text, for an accessible summary or a toast. */
export function inlineText(nodes: MdInline[]): string {
  return nodes.map((n) => (n.t === "text" || n.t === "code" ? n.v : inlineText(n.c))).join("");
}
