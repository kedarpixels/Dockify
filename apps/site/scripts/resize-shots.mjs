// Writes a 1440px variant beside each 2880px product shot, so a screen at DPR 1 downloads half the width.
// Run it after replacing a shot. sharp ships with Next.js, so it needs no extra dependency.
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
