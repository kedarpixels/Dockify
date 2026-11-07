import { describe, expect, it } from "vitest";
import { checkIconUpload, checkLogo, LOGO_MAX_BYTES } from "./icons.ts";
import { looksLikeSvg, sanitizeSvg } from "./svg.ts";

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>Acme</title><path fill="#2396ED" d="M2 2h20v20H2z"/></svg>';
const ok = (input: string) => {
  const r = sanitizeSvg(input);
  if (!r.ok) throw new Error(`expected a clean SVG, got: ${r.reason}`);
  return r.svg;
};

/** Nothing that can run, load or link survives, in any spelling. */
function assertInert(svg: string) {
  const lower = svg.toLowerCase();
  for (const bad of ["<script", "javascript", "vbscript", "foreignobject", "<image", "<iframe", "<a ", "<a>", "<animate", "<set", "<style", "<!doctype", "<!entity", "<![cdata", "<?", "data:", "expression(", "@import", "xlink", "&#"]) {
    expect(lower, bad).not.toContain(bad);
  }
  expect(lower).not.toMatch(/\son[a-z]+\s*=/);
  // The only absolute URL left is the SVG namespace itself.
  expect(lower.replace('xmlns="http://www.w3.org/2000/svg"', "")).not.toMatch(/https?:|\/\//);
}

describe("a clean logo", () => {
  it("is rebuilt with its drawing, title and size", () => {
    const r = sanitizeSvg(LOGO);
    expect(r).toEqual({ ok: true, svg: LOGO, width: 24, height: 24 });
  });
  it("keeps gradients, clip paths and local references", () => {
    const svg = ok(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="64" height="32">
      <defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient><clipPath id="c"><rect width="64" height="32"/></clipPath><path id="p" d="M0 0h1v1z"/></defs>
      <g clip-path="url(#c)"><rect fill="url(#g)" width="64" height="32"/><use xlink:href="#p"/></g></svg>`);
    expect(svg).toContain('fill="url(#g)"');
    expect(svg).toContain('clip-path="url(#c)"');
    expect(svg).toContain('<use href="#p"/>');
    assertInert(svg);
  });
  it("turns safe style declarations into attributes and drops the rest", () => {
    const svg = ok('<svg viewBox="0 0 4 4"><path style="fill: #f00; position: fixed; stroke:url(#s) !important" fill="#000" d="M0 0h4v4z"/></svg>');
    expect(svg).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><path fill="#f00" d="M0 0h4v4z" stroke="url(#s)"/></svg>');
  });
  it("keeps a link's drawing but not the link", () => {
    const svg = ok('<svg viewBox="0 0 4 4"><a href="https://evil.example"><path d="M0 0h4v4z"/></a></svg>');
    expect(svg).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><path d="M0 0h4v4z"/></svg>');
  });
  it("reads an XML declaration, comments and a byte order mark", () => {
    expect(ok(`﻿<?xml version="1.0" encoding="UTF-8"?>\n<!-- made with care -->\n${LOGO}`)).toBe(LOGO);
  });
});

describe("hostile SVGs", () => {
  const hostile: Array<[string, string]> = [
    ["script element", '<svg viewBox="0 0 4 4"><script>alert(1)</script><path d="M0 0h4v4z"/></svg>'],
    ["uppercase script", '<svg viewBox="0 0 4 4"><SCRIPT>alert(1)</SCRIPT><path d="M0 0h4v4z"/></svg>'],
    ["namespaced script", '<svg viewBox="0 0 4 4" xmlns:svg="http://www.w3.org/2000/svg"><svg:script>alert(1)</svg:script><path d="M0 0h4v4z"/></svg>'],
    ["event handlers", '<svg viewBox="0 0 4 4" onload="alert(1)"><path onclick="alert(1)" onmouseover="x()" d="M0 0h4v4z"/></svg>'],
    ["foreignObject", '<svg viewBox="0 0 4 4"><foreignObject><iframe src="https://evil.example"/></foreignObject><path d="M0 0h4v4z"/></svg>'],
    ["external image", '<svg viewBox="0 0 4 4"><image href="https://evil.example/x.png" width="4" height="4"/><path d="M0 0h4v4z"/></svg>'],
    ["external use", '<svg viewBox="0 0 4 4"><use href="https://evil.example/sprite.svg#a"/><path d="M0 0h4v4z"/></svg>'],
    ["data use", '<svg viewBox="0 0 4 4"><use xlink:href="data:image/svg+xml;base64,PHN2Zy8+"/><path d="M0 0h4v4z"/></svg>'],
    ["javascript link", '<svg viewBox="0 0 4 4"><a xlink:href="javascript:alert(1)"><path d="M0 0h4v4z"/></a></svg>'],
    ["entity encoded javascript", '<svg viewBox="0 0 4 4"><a href="&#106;avascript:alert(1)"><path d="M0 0h4v4z"/></a></svg>'],
    ["external fill", '<svg viewBox="0 0 4 4"><path fill="url(https://evil.example/#x)" d="M0 0h4v4z"/></svg>'],
    ["external style url", '<svg viewBox="0 0 4 4"><path style="fill:url(https://evil.example/a#b);background:url(//evil.example)" d="M0 0h4v4z"/></svg>'],
    ["css escapes", '<svg viewBox="0 0 4 4"><path style="fill:u\\72l(https://evil.example)" d="M0 0h4v4z"/></svg>'],
    ["style element", '<svg viewBox="0 0 4 4"><style>@import url(https://evil.example/x.css); path{fill:red}</style><path d="M0 0h4v4z"/></svg>'],
    ["animation to javascript", '<svg viewBox="0 0 4 4"><a><animate attributeName="href" to="javascript:alert(1)"/><set attributeName="onclick" to="alert(1)"/><path d="M0 0h4v4z"/></a></svg>'],
    ["filter with feImage", '<svg viewBox="0 0 4 4"><filter id="f"><feImage href="https://evil.example/x"/></filter><path filter="url(#f)" d="M0 0h4v4z"/></svg>'],
    ["unknown attributes", '<svg viewBox="0 0 4 4" xml:base="https://evil.example/" requiredExtensions="x"><path d="M0 0h4v4z" xlink:title="x"/></svg>'],
    ["control characters in a value", '<svg viewBox="0 0 4 4"><path fill="java&#9;script:x" d="M0 0h4v4z"/></svg>'],
  ];
  it.each(hostile)("%s: rebuilt without it", (_name, input) => {
    const svg = ok(input);
    assertInert(svg);
    expect(svg).toContain('<path d="M0 0h4v4z"/>');
  });

  const refused: Array<[string, string, RegExp]> = [
    ["a DOCTYPE with entities (billion laughs)", '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><svg viewBox="0 0 4 4"><text>&b;</text></svg>', /DOCTYPE/],
    ["an external entity", '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg viewBox="0 0 4 4"><text>&x;</text></svg>', /DOCTYPE/],
    ["an undeclared entity", '<svg viewBox="0 0 4 4"><text>&x;</text><path d="M0 0h4v4z"/></svg>', /entity/],
    ["CDATA", '<svg viewBox="0 0 4 4"><text><![CDATA[<script>alert(1)</script>]]></text></svg>', /CDATA/],
    ["a stylesheet processing instruction", '<?xml-stylesheet href="https://evil.example/x.css"?><svg viewBox="0 0 4 4"><path d="M0 0h4v4z"/></svg>', /processing instruction/],
    ["an unquoted attribute", "<svg viewBox=0><path d='M0 0h4v4z'/></svg>", /unquoted/],
    ["a repeated attribute", '<svg viewBox="0 0 4 4"><path d="M0 0h4v4z" d="M1 1"/></svg>', /repeats/],
    ["mismatched tags", '<svg viewBox="0 0 4 4"><g><path d="M0 0h4v4z"/></svg></g>', /match/],
    ["an unclosed document", '<svg viewBox="0 0 4 4"><g>', /closed/],
    ["two roots", `${LOGO}${LOGO}`, /more than one root/],
    ["an HTML page", "<html><body><svg/></body></html>", /not an SVG/],
    ["a < in a value", '<svg viewBox="0 0 4 4"><path d="M0 0<4"/></svg>', /inside an attribute/],
    ["no size", '<svg><path d="M0 0h4v4z"/></svg>', /viewBox/],
    ["nothing to draw", '<svg viewBox="0 0 4 4"><script>alert(1)</script></svg>', /nothing Dockify can draw/],
  ];
  it.each(refused)("%s: refused", (_name, input, reason) => {
    const r = sanitizeSvg(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });

  it("refuses deep nesting and too many elements", () => {
    expect(sanitizeSvg(`<svg viewBox="0 0 4 4">${"<g>".repeat(80)}<path d="M0 0h4v4z"/>${"</g>".repeat(80)}</svg>`)).toMatchObject({ ok: false, reason: expect.stringMatching(/nested/) });
    expect(sanitizeSvg(`<svg viewBox="0 0 4 4">${'<path d="M0 0h4v4z"/>'.repeat(4100)}</svg>`)).toMatchObject({ ok: false });
  });

  it("refuses bytes that are not UTF-8, and an oversized file", () => {
    expect(sanitizeSvg(new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0xff, 0xfe]))).toMatchObject({ ok: false, reason: expect.stringMatching(/UTF-8/) });
    expect(sanitizeSvg(`<svg viewBox="0 0 4 4"><title>${"a".repeat(140 * 1024)}</title></svg>`)).toMatchObject({ ok: false, reason: expect.stringMatching(/128 KB/) });
  });
});

describe("webhook logos", () => {
  const png = (w: number, h: number) => {
    const b = new Uint8Array(33);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(b.buffer).setUint32(16, w);
    new DataView(b.buffer).setUint32(20, h);
    return b;
  };
  const gif = (w: number, h: number) => {
    const b = new Uint8Array(16);
    b.set(new TextEncoder().encode("GIF89a"));
    new DataView(b.buffer).setUint16(6, w, true);
    new DataView(b.buffer).setUint16(8, h, true);
    return b;
  };

  it("takes PNG and GIF in any aspect ratio, at least 16 pixels a side", () => {
    expect(checkLogo(png(120, 40))).toMatchObject({ ok: true, image: { mime: "image/png", width: 120, height: 40 } });
    expect(checkLogo(gif(64, 64))).toMatchObject({ ok: true, image: { mime: "image/gif", width: 64, height: 64 } });
    expect(checkLogo(png(8, 8))).toMatchObject({ ok: false, reason: expect.stringMatching(/16 by 16/) });
  });

  it("stores an SVG only as its rebuild", () => {
    const r = checkLogo(new TextEncoder().encode(`<?xml version="1.0"?><svg viewBox="0 0 24 24" onload="alert(1)"><script>x()</script><path d="M2 2h20v20H2z"/></svg>`));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.image).toEqual({ mime: "image/svg+xml", width: 24, height: 24 });
      expect(new TextDecoder().decode(r.bytes)).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>');
    }
    expect(checkLogo(new TextEncoder().encode('<!DOCTYPE svg><svg viewBox="0 0 4 4"><path d="M0 0h4v4z"/></svg>'))).toMatchObject({ ok: false, reason: expect.stringMatching(/DOCTYPE/) });
  });

  it("refuses an HTML page, text, an empty file and an oversized one", () => {
    expect(checkLogo(new TextEncoder().encode("<html><script>alert(1)</script></html>"))).toMatchObject({ ok: false, reason: expect.stringMatching(/PNG, JPEG/) });
    expect(checkLogo(new TextEncoder().encode("hello"))).toMatchObject({ ok: false });
    expect(checkLogo(new Uint8Array())).toMatchObject({ ok: false, reason: "The logo is empty" });
    expect(checkLogo(new Uint8Array(LOGO_MAX_BYTES + 1))).toMatchObject({ ok: false, reason: expect.stringMatching(/128 KB/) });
  });

  it("leaves app and project uploads as they were: no SVG, no GIF", () => {
    expect(checkIconUpload(gif(64, 64)).ok).toBe(false);
    expect(checkIconUpload(new TextEncoder().encode(LOGO)).ok).toBe(false);
  });

  it("only treats markup with an svg element as a candidate", () => {
    expect(looksLikeSvg(new TextEncoder().encode(LOGO))).toBe(true);
    expect(looksLikeSvg(new TextEncoder().encode("<html></html>"))).toBe(false);
    expect(looksLikeSvg(png(16, 16))).toBe(false);
  });
});
