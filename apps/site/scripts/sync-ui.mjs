// The site uses the dashboard's own UI primitives and base styles. They live in apps/web; this copies
// them here.
//
//   node scripts/sync-ui.mjs           copy the dashboard's files over the site's copies
//   node scripts/sync-ui.mjs --check   fail (exit 1) when a copy differs; runs before every build
//
// Edit a primitive in apps/web, then run the copy, so the site and the dashboard never drift.
// A checkout without apps/web (the site on its own) skips the check with a note.
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
