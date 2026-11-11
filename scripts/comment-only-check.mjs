// Proves a diff only touched comments and whitespace: every changed .ts/.tsx/.js/.mjs/.css file
// in the working tree is compared with HEAD after both are reprinted without comments.
// Usage, from the repo root: node scripts/comment-only-check.mjs [path ...]
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const ts = require("typescript");

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
const scope = process.argv.slice(2);
const changed = git("diff", "--name-only", "HEAD", "--", ...scope)
  .split("\n")
  .filter((f) => /\.(ts|tsx|js|mjs|css)$/.test(f));

const printer = ts.createPrinter({ removeComments: true });
const code = (file, text) => {
  if (file.endsWith(".css")) return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return printer.printFile(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind));
};

let bad = 0;
for (const file of changed) {
  if (!existsSync(file)) {
    console.log(`DELETED  ${file}`);
    bad++;
    continue;
  }
  let before;
  try {
    before = git("show", `HEAD:${file}`);
  } catch {
    console.log(`NEW      ${file}`);
    bad++;
    continue;
  }
  const after = readFileSync(file, "utf8");
  if (code(file, before) !== code(file, after)) {
    console.log(`CODE     ${file}`);
    bad++;
  }
}
console.log(`${changed.length} files checked, ${bad} with more than comment changes`);
process.exit(bad ? 1 : 0);
