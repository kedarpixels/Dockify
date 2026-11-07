// Writes the 1440px variant of each product shot next to the 2880px original, so a screen at
// DPR 1 downloads half the width (components/landing/shot-picture.tsx picks one with srcset):
//
//   node scripts/resize-shots.mjs
//
// public/shots/<name>-<theme>.webp (2880 x 1800) gives public/shots/<name>-<theme>-1440.webp.
// sharp ships with Next.js, so this needs no extra dependency. Run it after replacing a shot.
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "shots");
for (const name of readdirSync(dir).filter((n) => /^[a-z]+-(light|dark)\.webp$/.test(n))) {
  const out = name.replace(/\.webp$/, "-1440.webp");
  const info = await sharp(join(dir, name)).resize({ width: 1440, kernel: "lanczos3" }).webp({ quality: 86, effort: 6 }).toFile(join(dir, out));
  console.log(`${out} ${info.width}x${info.height} ${Math.round(info.size / 1024)} KB`);
}
