import { callJson } from "@/lib/client-api";
import { UPLOAD_MAX_BYTES, UPLOAD_MIN_PX, type IconBody, type IconResult, type IconTarget } from "@/lib/icons";

/* The Icon card's browser half: the one write through app/api/icons, and the upload prep that
   crops to a centered square and shrinks it before the server checks it again by magic bytes. */

/** Sends one icon write through callJson, so offline and a lapsed session read as everywhere. Never throws. */
export async function sendIcon(t: IconTarget, body: IconBody): Promise<IconResult> {
  const r = await callJson<IconResult | null>("/api/icons", { body: { ...t, body } });
  if (r.ok) return r.data ?? { ok: false, source: "api", error: "This dashboard sent something it cannot read" };
  // A refusal still carries the route's own answer: keep where it came from.
  const source = r.body?.source === "preview" || r.body?.source === "none" ? r.body.source : "api";
  return { ok: false, source, error: r.error, status: r.status };
}

const TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
/** Large enough for a 40px icon on a 3x screen, small enough to stay far under the cap. */
const EDGE = 256;

export type Prepared = { ok: true; blob: Blob; base64: string } | { ok: false; reason: string };

const toBlob = (c: HTMLCanvasElement, type: string, q?: number) => new Promise<Blob | null>((r) => c.toBlob(r, type, q));

async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** A square PNG or WebP of at most 256px and 128 KB, or the reason the file cannot be one. */
export async function prepareUpload(file: File): Promise<Prepared> {
  if (!TYPES.has(file.type)) return { ok: false, reason: "Use a PNG, JPG or WebP image" };
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return { ok: false, reason: "That file could not be read as an image" };
  }
  const side = Math.min(bmp.width, bmp.height);
  if (side < UPLOAD_MIN_PX) {
    bmp.close();
    return { ok: false, reason: "Use an image of at least 32 by 32 pixels" };
  }
  if (bmp.width === bmp.height && bmp.width <= EDGE && file.size <= UPLOAD_MAX_BYTES) {
    bmp.close();
    return { ok: true, blob: file, base64: await base64Of(file) };
  }
  const out = Math.min(side, EDGE);
  const canvas = document.createElement("canvas");
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bmp.close();
    return { ok: false, reason: "This browser cannot resize images" };
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out);
  bmp.close();
  for (const [type, q] of [["image/png", undefined], ["image/webp", 0.9], ["image/webp", 0.75]] as const) {
    const blob = await toBlob(canvas, type, q);
    if (blob && blob.size <= UPLOAD_MAX_BYTES) return { ok: true, blob, base64: await base64Of(blob) };
  }
  return { ok: false, reason: "Use an image of 128 KB or less" };
}
