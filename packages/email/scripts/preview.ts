/**
 * Writes every template, and every variant (samples.ts SAMPLE_VARIANTS), with its sample data:
 *   <out>/<name>.html        light
 *   <out>/<name>-dark.html   dark
 *   <out>/index.html         links to all of them
 *
 * <out> is the first argument, or a dockify-email-previews folder in the system temp folder.
 *
 * Run with `pnpm --filter @dockify/email preview`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { esc } from "../src/html.ts";
import { renderSample, SAMPLE_VARIANTS, TEMPLATE_LABELS, TEMPLATE_NAMES, VARIANT_LABELS } from "../src/samples.ts";

const out = `${process.argv[2] ?? join(tmpdir(), "dockify-email-previews")}/`;
mkdirSync(out, { recursive: true });

const links: string[] = [];
const labels: Record<string, string> = { ...TEMPLATE_LABELS, ...VARIANT_LABELS };
for (const name of [...TEMPLATE_NAMES, ...SAMPLE_VARIANTS]) {
  writeFileSync(`${out}${name}.html`, renderSample(name, "light").html);
  writeFileSync(`${out}${name}-dark.html`, renderSample(name, "dark").html);
  links.push(`<li>${esc(labels[name] ?? name)}: <a href="${name}.html">light</a>, <a href="${name}-dark.html">dark</a></li>`);
}
writeFileSync(
  `${out}index.html`,
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Dockify email previews</title></head><body style="font-family:system-ui,sans-serif;padding:32px"><h1>Dockify email previews</h1><ul>${links.join("")}</ul></body></html>\n`,
);
process.stdout.write(`Wrote ${(TEMPLATE_NAMES.length + SAMPLE_VARIANTS.length) * 2} previews to ${out}\n`);
