// Runs the standalone build: the one start command for a Dockify app, a container or a plain host.
//
//   npm ci && npm run build && npm run start:standalone
//
// `output: "standalone"` traces the server from the repository root, so the server lands in
// .next/standalone/apps/site/server.js, and it serves static files only from the folders next to
// it. This copies .next/static and public there first (the build never does), then starts it with
// PORT (default 3007) and HOSTNAME (default 0.0.0.0).
import { spawn } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(site, ".next", "standalone", "apps", "site");
const server = join(app, "server.js");

if (!existsSync(server)) {
  console.error("start-standalone: no .next/standalone/apps/site/server.js; run npm run build first");
  process.exit(1);
}

for (const [from, to] of [
  [join(site, ".next", "static"), join(app, ".next", "static")],
  [join(site, "public"), join(app, "public")],
]) {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}

const child = spawn(process.execPath, [server], {
  cwd: app,
  stdio: "inherit",
  env: { ...process.env, PORT: process.env.PORT ?? "3007", HOSTNAME: process.env.HOSTNAME ?? "0.0.0.0" },
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
