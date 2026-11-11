/**
 * App, project and webhook icons: what the api answers about an icon, the write body, and the image
 * checks the api (uploads, logo links) and the worker (favicons) both run. The checks read magic
 * bytes and the header's own dimensions; nothing here decodes pixels. SVG is accepted as a fetched
 * favicon or a webhook logo, never as an upload, and only as the document sanitizeSvg rebuilds
 * (svg.ts).
 */
import { z } from "zod";
import { Iso, Slug, Uuid } from "./common.ts";
import { looksLikeSvg, sanitizeSvg } from "./svg.ts";

export const IconChoice = z.enum(["auto", "upload"]);
export type IconChoice = z.infer<typeof IconChoice>;
export const IconSource = z.enum(["favicon", "upload"]);
export type IconSource = z.infer<typeof IconSource>;

export const ICON_UPLOAD_MAX_BYTES = 128 * 1024;
export const FAVICON_MAX_BYTES = 64 * 1024;
export const ICON_MIN_PX = 32;
const MAX_PX = 4096;

export const IconMime = z.enum(["image/png", "image/jpeg", "image/webp", "image/x-icon"]);
export type IconMime = z.infer<typeof IconMime>;

export const IconImageRef = z.object({
  /** A sha256 prefix: changes whenever the bytes do, so the URL can be cached for good. */
  version: z.string().regex(/^[a-f0-9]{12}$/),
  source: IconSource,
  width: z.number().int(),
  height: z.number().int(),
});
export type IconImageRef = z.infer<typeof IconImageRef>;

export const FaviconFacts = z.object({
  origin: z.string().nullable(),
  fetchedAt: Iso.nullable(),
  checkedAt: Iso.nullable(),
  error: z.string().nullable(),
});

/** A frontend a project can show the favicon of: its display name and the host the favicon came from. */
export const FaviconApp = z.object({
  id: Uuid,
  name: z.string(),
  environment: z.string(),
  host: z.string().nullable(),
});
export type FaviconApp = z.infer<typeof FaviconApp>;

/** What a project's icon is: the folder (the default), the favicon of an app the owner chose, or an upload. */
export const ProjectIconMode = z.enum(["folder", "app", "upload"]);
export type ProjectIconMode = z.infer<typeof ProjectIconMode>;

/** Projects only: the icon's mode, the app chosen, and the frontends the owner can choose from. */
export const ProjectFavicon = z.object({
  mode: ProjectIconMode,
  /** The app the owner chose, or null. */
  pick: Uuid.nullable(),
  /** The app the shown favicon comes from: the chosen one while it has a favicon, else null (the folder shows). */
  from: Uuid.nullable(),
  /** Every frontend of the project with a fetched favicon, the most public first. */
  apps: z.array(FaviconApp),
});
export type ProjectFavicon = z.infer<typeof ProjectFavicon>;

export const IconState = z.object({
  choice: IconChoice,
  /**
   * The image shown now: the upload, an app's own favicon while its choice is auto, or a project's
   * chosen app's favicon. Null shows the kind's tile, or for a project the folder.
   */
  image: IconImageRef.nullable(),
  /** A frontend's last favicon fetch, or for a project the chosen app's favicon. */
  favicon: FaviconFacts.nullable(),
  /** Projects only: the mode, the chosen app and the frontends to choose from. */
  borrow: ProjectFavicon.optional(),
});
export type IconState = z.infer<typeof IconState>;

/** Every app and project whose icon is not the plain default, keyed by app id and project slug. */
export const IconMap = z.object({
  apps: z.record(Uuid, IconState),
  projects: z.record(Slug, IconState),
});
export type IconMap = z.infer<typeof IconMap>;

/** 128 KB of bytes is at most 174,764 base64 characters. */
const Base64 = z.string().max(174_764).regex(/^[A-Za-z0-9+/]+={0,2}$/, "Send the image as base64");

export const SetIconBody = z.discriminatedUnion("choice", [
  z.strictObject({ choice: z.literal("auto") }),
  z.strictObject({ choice: z.literal("upload"), image: Base64 }),
]);
export type SetIconBody = z.infer<typeof SetIconBody>;

/** A project's icon write: the folder, the favicon of one of its frontends, or an upload. */
export const SetProjectIconBody = z.discriminatedUnion("choice", [
  z.strictObject({ choice: z.literal("folder") }),
  z.strictObject({ choice: z.literal("app"), appId: Uuid }),
  z.strictObject({ choice: z.literal("upload"), image: Base64 }),
]);
export type SetProjectIconBody = z.infer<typeof SetProjectIconBody>;

export const IconQuery = z.strictObject({ v: z.string().regex(/^[a-f0-9]{12}$/).optional() });
export const AppIconParams = z.strictObject({ id: Uuid });
export const ProjectIconParams = z.strictObject({ slug: Slug });
/**
 * A signed mail icon link's token (the api mints and checks it: crypto's signMailIcon). Loose on
 * purpose: anything that is not a token this instance signed answers 404 from the handler, never
 * a 400 that would tell a guesser how close it got.
 */
export const MailIconParams = z.strictObject({ token: z.string().min(1).max(128) });

// ------------------------------------------------------------------ sniffing

export interface SniffedImage {
  mime: IconMime;
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + ((b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!);
const u32le = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)) + ((b[o + 3]! << 24) >>> 0);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
const sized = (mime: IconMime, width: number, height: number): SniffedImage | null =>
  width >= 1 && height >= 1 && width <= MAX_PX && height <= MAX_PX ? { mime, width, height } : null;

function png(b: Uint8Array): SniffedImage | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !sig.every((v, i) => b[i] === v) || ascii(b, 12, 4) !== "IHDR") return null;
  return sized("image/png", u32be(b, 16), u32be(b, 20));
}

function jpeg(b: Uint8Array): SniffedImage | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1]!;
    if (marker === 0xff) {
      o += 1;
      continue;
    }
    const len = u16be(b, o + 2);
    if (len < 2) return null;
    // SOF0 to SOF15, minus DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return sized("image/jpeg", u16be(b, o + 7), u16be(b, o + 5));
    }
    o += 2 + len;
  }
  return null;
}

function webp(b: Uint8Array): SniffedImage | null {
  if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return sized("image/webp", u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = u32le(b, 21);
    return sized("image/webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8X") return sized("image/webp", u24le(b, 24) + 1, u24le(b, 27) + 1);
  return null;
}

/** The largest entry of an icon directory, after checking every entry points inside the file. */
function ico(b: Uint8Array): SniffedImage | null {
  if (b.length < 22 || u16le(b, 0) !== 0 || u16le(b, 2) !== 1) return null;
  const count = u16le(b, 4);
  if (count < 1 || count > 64 || 6 + count * 16 > b.length) return null;
  let best = 0;
  let width = 0;
  let height = 0;
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const w = b[e] || 256;
    const h = b[e + 1] || 256;
    const size = u32le(b, e + 8);
    const offset = u32le(b, e + 12);
    if (size < 1 || offset < 6 + count * 16 || offset + size > b.length) return null;
    if (w * h > best) {
      best = w * h;
      width = w;
      height = h;
    }
  }
  return sized("image/x-icon", width, height);
}

/** The type and size of an image by its magic bytes, or null for anything else (SVG included). */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  return png(bytes) ?? jpeg(bytes) ?? webp(bytes) ?? ico(bytes);
}

export type ImageCheck = { ok: true; image: SniffedImage } | { ok: false; reason: string };

/** An owner's upload: png, jpg or webp, at most 128 KB, square and at least 32px. */
export function checkIconUpload(bytes: Uint8Array): ImageCheck {
  if (bytes.length === 0) return { ok: false, reason: "The image is empty" };
  if (bytes.length > ICON_UPLOAD_MAX_BYTES) return { ok: false, reason: "Use an image of 128 KB or less" };
  const image = sniffImage(bytes);
  if (!image || image.mime === "image/x-icon") return { ok: false, reason: "Use a PNG, JPG or WebP image" };
  if (image.width < ICON_MIN_PX || image.height < ICON_MIN_PX) return { ok: false, reason: "Use an image of at least 32 by 32 pixels" };
  if (image.width !== image.height) return { ok: false, reason: "Use a square image" };
  return { ok: true, image };
}

/**
 * A fetched favicon: png, ico, webp, jpg or svg, at most 64 KB as it arrived, at least 16px for a
 * raster. Many sites declare only an SVG icon. Like a logo's, an SVG is stored only as sanitizeSvg's
 * rebuild, never as it arrived: `bytes` is what to store.
 */
export function checkFavicon(bytes: Uint8Array): LogoCheck {
  if (bytes.length === 0) return { ok: false, reason: "The favicon is empty" };
  if (bytes.length > FAVICON_MAX_BYTES) return { ok: false, reason: "The favicon is larger than 64 KB" };
  const image = sniffImage(bytes);
  if (image) {
    if (image.width < 16 || image.height < 16) return { ok: false, reason: "The favicon is smaller than 16 pixels" };
    return { ok: true, image, bytes };
  }
  if (looksLikeSvg(bytes)) {
    const svg = sanitizeSvg(bytes);
    if (!svg.ok) return svg;
    return { ok: true, image: { mime: SVG_MIME, width: svg.width, height: svg.height }, bytes: new TextEncoder().encode(svg.svg) };
  }
  return { ok: false, reason: "The favicon is not a PNG, ICO, WebP, JPG or SVG image" };
}

// ------------------------------------------------------------------ webhook logos

export const LOGO_MAX_BYTES = 128 * 1024;
export const LogoMime = z.enum(["image/png", "image/jpeg", "image/webp", "image/x-icon", "image/gif", "image/svg+xml"]);
export type LogoMime = z.infer<typeof LogoMime>;
/** The one stored type an email or a GitHub comment cannot be trusted to draw, so those never link to it. */
export const SVG_MIME = "image/svg+xml" satisfies LogoMime;

/** A GIF's logical screen size, from the header. */
function gif(b: Uint8Array): SniffedLogo | null {
  if (b.length < 13 || (ascii(b, 0, 6) !== "GIF87a" && ascii(b, 0, 6) !== "GIF89a")) return null;
  const width = u16le(b, 6);
  const height = u16le(b, 8);
  return width >= 1 && height >= 1 && width <= MAX_PX && height <= MAX_PX ? { mime: "image/gif", width, height } : null;
}

export interface SniffedLogo {
  mime: LogoMime;
  width: number;
  height: number;
}

/** The bytes to store for a logo: the input, or for an SVG the rebuilt document. */
export type LogoCheck = { ok: true; image: SniffedLogo; bytes: Uint8Array } | { ok: false; reason: string };

/**
 * A webhook's logo, uploaded or downloaded from the owner's link: PNG, JPEG, WebP, GIF, ICO or SVG,
 * at most 128 KB, at least 16 pixels a side for a raster. Any aspect ratio: the dashboard fits it
 * into its tile. An SVG is stored only as sanitizeSvg's rebuild, never as it arrived.
 */
export function checkLogo(bytes: Uint8Array): LogoCheck {
  if (bytes.length === 0) return { ok: false, reason: "The logo is empty" };
  if (bytes.length > LOGO_MAX_BYTES) return { ok: false, reason: "Use a logo of 128 KB or less" };
  const raster = sniffImage(bytes) ?? gif(bytes);
  if (raster) {
    if (raster.width < 16 || raster.height < 16) return { ok: false, reason: "Use a logo of at least 16 by 16 pixels" };
    return { ok: true, image: { mime: raster.mime, width: raster.width, height: raster.height }, bytes };
  }
  if (looksLikeSvg(bytes)) {
    const svg = sanitizeSvg(bytes);
    if (!svg.ok) return svg;
    return { ok: true, image: { mime: SVG_MIME, width: svg.width, height: svg.height }, bytes: new TextEncoder().encode(svg.svg) };
  }
  return { ok: false, reason: "Use a PNG, JPEG, WebP, GIF, ICO or SVG image" };
}

/** 128 KB of bytes is at most 174,764 base64 characters. */
export const LogoBase64 = z.string().max(174_764).regex(/^[A-Za-z0-9+/]+={0,2}$/, "Send the image as base64");
