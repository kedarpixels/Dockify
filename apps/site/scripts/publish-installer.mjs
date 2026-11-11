// Copies the installer scripts, each with its SHA-256, into public/ and the release notes into content/releases/.
// Runs before every build (npm "prebuild"), so the site never serves a stale script or stale notes.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const pub = join(here, "..", "public");

/** Publishes a bootstrap at /<entry> and the full script at /<full>, with its SHA-256 beside it. */
function publish(bootstrap, entry, script, full) {
  copyFileSync(join(repo, "installer", bootstrap), join(pub, entry));
  copyFileSync(join(repo, "installer", script), join(pub, full));
  const sum = createHash("sha256").update(readFileSync(join(pub, full))).digest("hex");
  writeFileSync(join(pub, `${full}.sha256`), `${sum}  ${full}\n`);
  return sum;
}
const sum = publish("bootstrap.sh", "install.sh", "install.sh", "installer.sh");
console.log(`installer published, sha256 ${sum.slice(0, 12)}`);
const usum = publish("uninstall-bootstrap.sh", "uninstall.sh", "uninstall.sh", "uninstaller.sh");
console.log(`uninstaller published, sha256 ${usum.slice(0, 12)}`);

const notesSrc = join(repo, "docs", "releases");
const notesOut = join(here, "..", "content", "releases");
rmSync(notesOut, { recursive: true, force: true });
mkdirSync(notesOut, { recursive: true });
const notes = existsSync(notesSrc) ? readdirSync(notesSrc).filter((n) => n.endsWith(".md")) : [];
for (const n of notes) copyFileSync(join(notesSrc, n), join(notesOut, n));
console.log(`release notes published, ${notes.length} file${notes.length === 1 ? "" : "s"}`);
