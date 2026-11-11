import { describe, expect, it } from "vitest";
import { checkFavicon, checkIconUpload, IconMap, SetIconBody, SetProjectIconBody, sniffImage } from "./icons.ts";

function pngOf(w: number, h: number, pad = 0): Uint8Array {
  const b = new Uint8Array(33 + pad);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

const jpegOf = (w: number, h: number) =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0]);

function webpOf(kind: "VP8 " | "VP8L" | "VP8X", w: number, h: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0);
  b.set([..."WEBP"].map((c) => c.charCodeAt(0)), 8);
  b.set([...kind].map((c) => c.charCodeAt(0)), 12);
  const v = new DataView(b.buffer);
  if (kind === "VP8 ") {
    b.set([0x9d, 0x01, 0x2a], 23);
    v.setUint16(26, w, true);
    v.setUint16(28, h, true);
  } else if (kind === "VP8L") {
    b[20] = 0x2f;
    v.setUint32(21, ((w - 1) | ((h - 1) << 14)) >>> 0, true);
  } else {
    b.set([(w - 1) & 255, ((w - 1) >> 8) & 255, 0, (h - 1) & 255, ((h - 1) >> 8) & 255, 0], 24);
  }
  return b;
}

function icoOf(sizes: number[], offsetOverride?: number): Uint8Array {
  const head = 6 + sizes.length * 16;
  const b = new Uint8Array(head + sizes.length * 8);
  const v = new DataView(b.buffer);
  v.setUint16(2, 1, true);
  v.setUint16(4, sizes.length, true);
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    b[e] = s === 256 ? 0 : s;
    b[e + 1] = s === 256 ? 0 : s;
    v.setUint32(e + 8, 8, true);
    v.setUint32(e + 12, offsetOverride ?? head + i * 8, true);
  });
  return b;
}

const text = (s: string) => new TextEncoder().encode(s);

describe("sniffImage", () => {
  it("reads the type and size of png, jpeg, webp and ico by their headers", () => {
    expect(sniffImage(pngOf(64, 48))).toEqual({ mime: "image/png", width: 64, height: 48 });
    expect(sniffImage(jpegOf(120, 90))).toEqual({ mime: "image/jpeg", width: 120, height: 90 });
    expect(sniffImage(webpOf("VP8 ", 50, 40))).toEqual({ mime: "image/webp", width: 50, height: 40 });
    expect(sniffImage(webpOf("VP8L", 64, 64))).toEqual({ mime: "image/webp", width: 64, height: 64 });
    expect(sniffImage(webpOf("VP8X", 300, 200))).toEqual({ mime: "image/webp", width: 300, height: 200 });
    expect(sniffImage(icoOf([16, 32, 256]))).toEqual({ mime: "image/x-icon", width: 256, height: 256 });
  });

  it("refuses SVG, HTML, a lying extension and truncated or corrupt headers", () => {
    expect(sniffImage(text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffImage(text("<?xml version=\"1.0\"?><svg/>"))).toBeNull();
    expect(sniffImage(text("<!doctype html><html></html>"))).toBeNull();
    expect(sniffImage(pngOf(64, 64).subarray(0, 20))).toBeNull();
    expect(sniffImage(pngOf(0, 64))).toBeNull();
    expect(sniffImage(pngOf(10_000, 10_000))).toBeNull();
    expect(sniffImage(icoOf([32], 9_999))).toBeNull();
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBeNull();
  });
});

describe("checkIconUpload", () => {
  it("takes a square png, jpg or webp of 32px or more up to 128 KB", () => {
    expect(checkIconUpload(pngOf(64, 64)).ok).toBe(true);
    expect(checkIconUpload(jpegOf(32, 32)).ok).toBe(true);
    expect(checkIconUpload(webpOf("VP8L", 512, 512)).ok).toBe(true);
    expect(checkIconUpload(pngOf(64, 64, 128 * 1024 - 33)).ok).toBe(true);
  });

  it("refuses ico, svg, small, oblong and oversized images, each with its reason", () => {
    expect(checkIconUpload(icoOf([64]))).toEqual({ ok: false, reason: "Use a PNG, JPG or WebP image" });
    expect(checkIconUpload(text("<svg/>"))).toEqual({ ok: false, reason: "Use a PNG, JPG or WebP image" });
    expect(checkIconUpload(pngOf(16, 16))).toEqual({ ok: false, reason: "Use an image of at least 32 by 32 pixels" });
    expect(checkIconUpload(pngOf(64, 48))).toEqual({ ok: false, reason: "Use a square image" });
    expect(checkIconUpload(pngOf(64, 64, 128 * 1024))).toEqual({ ok: false, reason: "Use an image of 128 KB or less" });
    expect(checkIconUpload(new Uint8Array())).toEqual({ ok: false, reason: "The image is empty" });
  });
});

describe("checkFavicon", () => {
  it("takes an SVG only as the rebuilt document, so nothing that runs is ever stored", () => {
    const r = checkFavicon(text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" onload="alert(1)"><script>alert(2)</script><path d="M2 2h20v20z"/></svg>'));
    expect(r).toMatchObject({ ok: true, image: { mime: "image/svg+xml", width: 24, height: 24 } });
    const stored = r.ok ? new TextDecoder().decode(r.bytes) : "";
    expect(stored).toContain("<path");
    expect(stored).not.toMatch(/onload|script|alert/);
    // The 64 KB cap is on what the site sent, the same as for a raster.
    expect(checkFavicon(text(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20z"/>${" ".repeat(64 * 1024)}</svg>`))).toEqual({ ok: false, reason: "The favicon is larger than 64 KB" });
  });


  it("takes ico, png, webp and jpg up to 64 KB and refuses the rest", () => {
    expect(checkFavicon(icoOf([16, 32])).ok).toBe(true);
    const raster = pngOf(180, 180);
    expect(checkFavicon(raster)).toMatchObject({ ok: true, image: { mime: "image/png", width: 180 }, bytes: raster });
    expect(checkFavicon(text("<svg/>"))).toEqual({ ok: false, reason: "Give the SVG a viewBox, or a width and height in pixels" });
    expect(checkFavicon(text("<!doctype html><html><body><svg viewBox='0 0 8 8'><path d='M0 0h8v8z'/></svg></body></html>")).ok).toBe(false);
    expect(checkFavicon(text("plain words"))).toEqual({ ok: false, reason: "The favicon is not a PNG, ICO, WebP, JPG or SVG image" });
    expect(checkFavicon(pngOf(8, 8)).ok).toBe(false);
    expect(checkFavicon(pngOf(32, 32, 64 * 1024)).ok).toBe(false);
  });
});

describe("icon schemas", () => {
  it("accepts automatic and an upload, and refuses a preset, a stray field or non-base64 text", () => {
    expect(SetIconBody.safeParse({ choice: "auto" }).success).toBe(true);
    expect(SetIconBody.safeParse({ choice: "upload", image: "iVBORw0KGgo=" }).success).toBe(true);
    expect(SetIconBody.safeParse({ choice: "preset", preset: "redis" }).success).toBe(false);
    expect(SetIconBody.safeParse({ choice: "auto", preset: "bot" }).success).toBe(false);
    expect(SetIconBody.safeParse({ choice: "upload", image: "<svg>" }).success).toBe(false);
    expect(SetIconBody.safeParse({ choice: "upload", image: "A".repeat(200_000) }).success).toBe(false);
  });

  it("takes a project's icon as the folder, one app's favicon or an upload, never automatic", () => {
    const app = "0f0e0d0c-0000-4000-8000-0000000000aa";
    expect(SetProjectIconBody.safeParse({ choice: "folder" }).success).toBe(true);
    expect(SetProjectIconBody.safeParse({ choice: "app", appId: app }).success).toBe(true);
    expect(SetProjectIconBody.safeParse({ choice: "upload", image: "iVBORw0KGgo=" }).success).toBe(true);
    expect(SetProjectIconBody.safeParse({ choice: "auto" }).success).toBe(false);
    expect(SetProjectIconBody.safeParse({ choice: "auto", appId: app }).success).toBe(false);
    expect(SetProjectIconBody.safeParse({ choice: "app" }).success).toBe(false);
    expect(SetProjectIconBody.safeParse({ choice: "app", appId: "frontend" }).success).toBe(false);
    expect(SetProjectIconBody.safeParse({ choice: "folder", appId: app }).success).toBe(false);
  });

  it("keys the map by app id and project slug", () => {
    const state = { choice: "auto", image: null, favicon: null };
    expect(IconMap.safeParse({ apps: { "0f0e0d0c-0000-4000-8000-0000000000aa": state }, projects: { horseai: state } }).success).toBe(true);
    expect(IconMap.safeParse({ apps: { "not-an-id": state }, projects: {} }).success).toBe(false);
  });
});
