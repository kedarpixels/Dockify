// Release notes come from the signed update manifest, but the page still treats them as untrusted.
// Run: node --test tests/ (Node 22.18+ strips the TypeScript types of the imported module).
import assert from "node:assert/strict";
import { test } from "node:test";
import { inlineText, parseInline, parseMarkdown, safeHref } from "../lib/markdown.ts";

const links = (nodes) => nodes.flatMap((n) => (n.t === "link" ? [n, ...links(n.c)] : n.t === "strong" ? links(n.c) : []));
const allLinks = (blocks) => blocks.flatMap((b) => (b.t === "ul" || b.t === "ol" ? b.items.flatMap(links) : links(b.c)));

test("only https and same-origin paths become links", () => {
  assert.equal(safeHref("https://example.com/notes"), "https://example.com/notes");
  assert.equal(safeHref("/server"), "/server");
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,<b>x</b>", "http://example.com", "//evil.com", "/\\evil.com", "vbscript:x", "https:/evil", "", "mailto:a@b.c"]) {
    assert.equal(safeHref(bad), null, bad);
  }
});

test("a hostile link keeps its text and loses its target", () => {
  const nodes = parseInline("see [this](javascript:alert(1)) now");
  assert.equal(links(nodes).length, 0);
  assert.equal(inlineText(nodes), "see this now");
});

test("raw HTML stays literal text", () => {
  const blocks = parseMarkdown('<script>alert("x")</script>\n\n<img src=x onerror=alert(1)>');
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { t: "p", c: [{ t: "text", v: '<script>alert("x")</script>' }] });
  assert.equal(inlineText(blocks[1].c), "<img src=x onerror=alert(1)>");
});

test("headings, lists, bold, code and links parse", () => {
  const md = "## Dockify 0.9.2\n\nIntro line\ncontinued.\n\n### Changes\n- **Fixed** a bug\n- Set `DOCKIFY_X`\n  wrapped\n1. First\n2. [Docs](https://example.com/d)";
  const b = parseMarkdown(md);
  assert.deepEqual(b.map((x) => x.t), ["heading", "p", "heading", "ul", "ol"]);
  assert.equal(b[0].level, 2);
  assert.equal(inlineText(b[1].c), "Intro line continued.");
  assert.deepEqual(b[3].items[0][0], { t: "strong", c: [{ t: "text", v: "Fixed" }] });
  assert.deepEqual(b[3].items[1][1], { t: "code", v: "DOCKIFY_X" });
  assert.equal(inlineText(b[3].items[1]), "Set DOCKIFY_X wrapped");
  assert.deepEqual(allLinks(b).map((l) => l.href), ["https://example.com/d"]);
});

test("code spans are never parsed further and escapes are literal", () => {
  assert.deepEqual(parseInline("`[x](https://example.com)`"), [{ t: "code", v: "[x](https://example.com)" }]);
  assert.deepEqual(parseInline("\\*\\*not bold\\*\\*"), [{ t: "text", v: "**not bold**" }]);
});

test("huge input is cut instead of stalling", () => {
  const blocks = parseMarkdown("[".repeat(200_000));
  assert.ok(inlineText(blocks[0].c).length <= 20_000);
});
