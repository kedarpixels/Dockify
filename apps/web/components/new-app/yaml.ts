/*
 * A small YAML subset parser, enough for docker-compose files: block mappings and sequences
 * (including a sequence at its key's indent), "- key: value" items, plain, single and double
 * quoted scalars, flow [lists] and {maps}, | and > block scalars, and comments. Anchors, aliases,
 * merge keys, tags and multi-document files are refused with a clear message instead of being
 * guessed at. Values stay strings unless they read as a number, a boolean or null.
 */

export type Yaml = string | number | boolean | null | Yaml[] | { [key: string]: Yaml };

export class YamlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} on line ${line}`);
    this.line = line;
  }
}

interface Line {
  /** 1-based, for messages. */
  n: number;
  indent: number;
  /** The line after its indent, comments removed. */
  text: string;
  /** The line after its indent, untouched, for block scalars. */
  raw: string;
}

const MAX_LINES = 2000;
const MAX_DEPTH = 32;

/** Cuts a comment: a # at the start or after a space, outside quotes. */
function stripComment(s: string): string {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const prev = i ? s[i - 1]! : " ";
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if ((c === '"' || c === "'") && /[\s:[{,]/.test(prev)) quote = c;
    else if (c === "#" && /\s/.test(prev)) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

function toLines(src: string): Line[] {
  const out: Line[] = [];
  const rows = src.replace(/^﻿/, "").split(/\r?\n/);
  if (rows.length > MAX_LINES) throw new YamlError(`The file is longer than ${MAX_LINES} lines`, MAX_LINES);
  rows.forEach((row, i) => {
    const n = i + 1;
    const lead = /^[ \t]*/.exec(row)![0];
    if (lead.includes("\t") && row.trim()) throw new YamlError("Tabs cannot indent YAML", n);
    const raw = row.slice(lead.length).trimEnd();
    if (raw === "---" && !out.length) return;
    if (raw === "---" || raw === "...") throw new YamlError("Only one document is supported", n);
    if (raw.startsWith("%")) throw new YamlError("Directives are not supported", n);
    out.push({ n, indent: lead.length, raw, text: stripComment(raw) });
  });
  return out;
}

const isItem = (t: string) => t === "-" || t.startsWith("- ");

/** "key: rest" or "key:" with a plain or quoted key. A colon must be followed by a space or the end. */
function splitKey(t: string): [key: string, rest: string] | null {
  const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'{[\]#&*!|>%@`,-][^#]*?|-[^\s#][^#]*?)\s*:(?:\s+(.*))?$/.exec(t);
  if (!m) return null;
  const k = m[1]!;
  const key = k.startsWith('"') ? (JSON.parse(k) as string) : k.startsWith("'") ? k.slice(1, -1).replace(/''/g, "'") : k;
  return [key, (m[2] ?? "").trim()];
}

/** Splits flow content on top-level commas, keeping quotes and nested brackets whole. */
function splitFlow(s: string, n: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
    if (depth < 0) throw new YamlError("Unbalanced brackets", n);
  }
  if (quote || depth) throw new YamlError("Unclosed quote or bracket", n);
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter((p, i, all) => p !== "" || i < all.length - 1);
}

/* YAML escapes JSON lacks, rewritten before JSON.parse reads the rest. */
const YAML_ESCAPES: Record<string, string> = { "0": "\\u0000", a: "\\u0007", v: "\\u000b", e: "\\u001b", " ": " ", "/": "/", "\t": "\\t" };

function scalar(s: string, n: number, depth = 0): Yaml {
  const v = s.trim();
  if (depth > MAX_DEPTH) throw new YamlError("Nesting is too deep", n);
  if (v === "" || v === "~" || v === "null" || v === "Null" || v === "NULL") return null;
  if (/^[&*]/.test(v)) throw new YamlError("Anchors and aliases are not supported", n);
  if (v.startsWith("!")) throw new YamlError("Tags are not supported", n);
  if (v.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(v)) throw new YamlError("Unclosed double quote", n);
    try {
      return JSON.parse(v.replace(/\\(.)/g, (_, c: string) => YAML_ESCAPES[c] ?? `\\${c}`)) as string;
    } catch {
      throw new YamlError("Unknown escape in a double quoted string", n);
    }
  }
  if (v.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(v)) throw new YamlError("Unclosed single quote", n);
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.startsWith("[")) {
    if (!v.endsWith("]")) throw new YamlError("Unclosed [", n);
    return splitFlow(v.slice(1, -1), n).map((p) => scalar(p, n, depth + 1));
  }
  if (v.startsWith("{")) {
    if (!v.endsWith("}")) throw new YamlError("Unclosed {", n);
    const out: Record<string, Yaml> = {};
    for (const part of splitFlow(v.slice(1, -1), n)) {
      const kv = splitKey(part) ?? (/^[^:]+$/.test(part) ? ([part, ""] as [string, string]) : null);
      if (!kv) throw new YamlError("Expected key: value inside { }", n);
      out[kv[0]] = scalar(kv[1], n, depth + 1);
    }
    return out;
  }
  if (v === "true" || v === "True" || v === "TRUE") return true;
  if (v === "false" || v === "False" || v === "FALSE") return false;
  if (/^[-+]?\d+(\.\d+)?$/.test(v) && v.length < 16) return Number(v);
  return v;
}

class Parser {
  i = 0;
  readonly lines: Line[];
  constructor(lines: Line[]) {
    this.lines = lines;
  }

  get cur(): Line | undefined {
    return this.lines[this.i];
  }

  block(indent: number, depth: number): Yaml {
    if (depth > MAX_DEPTH) throw new YamlError("Nesting is too deep", this.cur?.n ?? 0);
    const l = this.cur;
    if (!l) return null;
    return isItem(l.text) ? this.seq(indent, depth) : this.map(indent, depth);
  }

  /** The value after "key:" or "-" with nothing on the line: a deeper block, a same-indent list, or null. */
  nested(indent: number, depth: number, sameIndentList: boolean): Yaml {
    const next = this.cur;
    if (next && next.indent > indent) return this.block(next.indent, depth + 1);
    if (sameIndentList && next && next.indent === indent && isItem(next.text)) return this.seq(indent, depth + 1);
    return null;
  }

  /** A | or > block scalar: every following line indented deeper than its key. */
  blockScalar(indent: number, head: string): string {
    const rows: Line[] = [];
    while (this.cur && this.cur.indent > indent) rows.push(this.lines[this.i++]!);
    if (!rows.length) return "";
    const base = Math.min(...rows.map((r) => r.indent));
    const text = rows.map((r) => " ".repeat(r.indent - base) + r.raw);
    const joined = head.startsWith("|") ? text.join("\n") : text.join(" ");
    return head.includes("-") ? joined : `${joined}\n`;
  }

  value(rest: string, l: Line, indent: number, depth: number): Yaml {
    if (rest === "") return this.nested(indent, depth, true);
    if (/^[|>][-+]?$/.test(rest)) return this.blockScalar(indent, rest);
    return scalar(rest, l.n, depth);
  }

  map(indent: number, depth: number): Record<string, Yaml> {
    const out: Record<string, Yaml> = {};
    while (this.cur) {
      const l = this.cur;
      if (l.indent < indent) break;
      if (l.indent > indent) throw new YamlError("Unexpected indentation", l.n);
      if (isItem(l.text)) throw new YamlError("Expected key: value, found a list item", l.n);
      const kv = splitKey(l.text);
      if (!kv) throw new YamlError("Expected key: value", l.n);
      const [key, rest] = kv;
      if (key === "<<") throw new YamlError("Merge keys are not supported", l.n);
      if (Object.hasOwn(out, key)) throw new YamlError(`Duplicate key ${key}`, l.n);
      this.i++;
      out[key] = this.value(rest, l, indent, depth);
    }
    return out;
  }

  seq(indent: number, depth: number): Yaml[] {
    const out: Yaml[] = [];
    while (this.cur) {
      const l = this.cur;
      if (l.indent !== indent || !isItem(l.text)) {
        if (l.indent > indent) throw new YamlError("Unexpected indentation", l.n);
        break;
      }
      const rest = l.text === "-" ? "" : l.text.slice(2).trimStart();
      if (rest === "") {
        this.i++;
        out.push(this.nested(indent, depth, false));
      } else if (isItem(rest) || splitKey(rest)) {
        // "- key: value" or "- - item": the item is a block that starts on this line, at the
        // column of its first character, so the rewritten line is parsed like any other.
        const at = l.indent + (l.text.length - rest.length);
        this.lines[this.i] = { n: l.n, indent: at, text: rest, raw: l.raw.slice(l.raw.length - rest.length) };
        out.push(this.block(at, depth + 1));
      } else {
        this.i++;
        out.push(/^[|>][-+]?$/.test(rest) ? this.blockScalar(indent, rest) : scalar(rest, l.n, depth));
      }
    }
    return out;
  }
}

/** Parses the subset. Throws YamlError with a line number on anything it does not support. */
export function parseYaml(src: string): Yaml {
  // Blank and comment-only lines carry nothing, so the parser never sees them.
  const lines = toLines(src).filter((l) => l.text !== "");
  if (!lines.length) return null;
  const first = lines[0]!;
  if (!isItem(first.text) && !splitKey(first.text)) {
    if (lines[1]) throw new YamlError("Unexpected content", lines[1].n);
    return scalar(first.text, first.n);
  }
  const p = new Parser(lines);
  const value = p.block(first.indent, 0);
  const left = p.cur;
  if (left) throw new YamlError(left.indent > first.indent ? "Unexpected indentation" : "Unexpected content", left.n);
  return value;
}
