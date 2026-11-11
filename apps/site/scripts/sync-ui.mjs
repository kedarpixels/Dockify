// Copies the dashboard's UI primitives and base styles from apps/web over the site's copies.
// --check fails (exit 1) when a copy differs and runs before every build; a checkout without apps/web skips it.
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, "..");
const web = join(site, "..", "web");

/** [file in apps/web, file in apps/site]. */
const FILES = [
  ["components/ui/theme-switch.tsx", "components/ui/theme-switch.tsx"],
  ["components/ui/copy-button.tsx", "components/ui/copy-button.tsx"],
  ["components/ui/tip-guard.tsx", "components/ui/tip-guard.tsx"],
  ["components/ui/rule.tsx", "components/ui/rule.tsx"],
  ["components/ui/shortcuts.ts", "components/ui/shortcuts.ts"],
  ["components/ui/cx.ts", "components/ui/cx.ts"],
  ["components/ui/burger.tsx", "components/ui/burger.tsx"],
  ["app/styles/foundation-shared.css", "app/styles/foundation-shared.css"],
];

const check = process.argv.includes("--check");

if (!existsSync(join(web, "components", "ui"))) {
  console.log("sync-ui: apps/web is not here, so the shared primitives were not checked");
  process.exit(0);
}

const drift = [];
for (const [from, to] of FILES) {
  const a = join(web, from);
  const b = join(site, to);
  const same = existsSync(b) && readFileSync(a).equals(readFileSync(b));
  if (same) continue;
  if (check) drift.push(to);
  else {
    copyFileSync(a, b);
    console.log(`sync-ui: copied ${from}`);
  }
}

if (drift.length) {
  console.error(`sync-ui: these differ from apps/web:\n  ${drift.join("\n  ")}\nRun: node scripts/sync-ui.mjs`);
  process.exit(1);
}
console.log(check ? `sync-ui: ${FILES.length} shared primitives match apps/web` : "sync-ui: done");
