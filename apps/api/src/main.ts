import { loadKeyring } from "@dockify/crypto";
import { createDb, tcpProbe, upgradeLegacyServiceCredentials, waitUntilReachable, type WaitLog } from "@dockify/db";
import { buildApp } from "./app.ts";
import { ensureInstance } from "./boot.ts";
import { loadConfig } from "./config.ts";
import { followGitHubWebhook } from "./modules/integrations/dashboard-domain.ts";
import { defaultDeps } from "./modules/integrations/deps.ts";
import { seedEmailFromEnv, seedGitHubAppFromEnv } from "./modules/integrations/index.ts";

const config = loadConfig();
const ring = loadKeyring();
const db = createDb();

// After a host reboot Docker starts the api before Postgres takes connections. Wait for it with
// backoff, saying so once, instead of crashing and logging a stack per restart. The
// request logger only exists once the app is built, so these few lines are written directly.
const bootLog: WaitLog = {
  info: (msg, extra) => void process.stderr.write(`${JSON.stringify({ level: "info", msg, ...extra })}\n`),
  error: (msg, extra) => void process.stderr.write(`${JSON.stringify({ level: "error", msg, ...extra })}\n`),
};
const stop = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => stop.abort());
const url = process.env.DATABASE_URL;
const ready = await waitUntilReachable("the database", async () => {
  if (url) await tcpProbe(url)();
  await db.$queryRaw`SELECT 1`;
}, { log: bootLog, signal: stop.signal });
if (!ready) {
  await db.$disconnect();
  process.exit(0);
}

await ensureInstance(db, ring, config.publicUrl.origin, config.ingress);
// Managed services from older installs stored a bare password; rewrite those rows in the JSON
// shape once. Every reader takes both shapes, so this is tidiness: it never blocks the start, and
// it says something only when it changed or could not read a row.
const legacy = await upgradeLegacyServiceCredentials(db, ring).catch(() => ({ upgraded: 0, unreadable: [] as string[] }));
if (legacy.upgraded > 0) bootLog.info("service credentials moved to the current format", { upgraded: legacy.upgraded });
if (legacy.unreadable.length > 0) bootLog.error("service credentials that could not be read were left as they are", { unreadable: legacy.unreadable });
// A GitHub App the installer was given in the environment becomes the integrations row once.
await seedGitHubAppFromEnv(db, ring);
// So is a mail server, which lets setup verify the owner's email before Settings is reachable.
await seedEmailFromEnv(db, ring);
// After a change of address, the GitHub App's webhook follows. Never holds up the start.
void followGitHubWebhook(db, ring, defaultDeps(), config.publicUrl.origin).catch(() => undefined);

const { app } = await buildApp({ db, ring, config });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void app.close().then(() => db.$disconnect()).then(() => process.exit(0));
  });
}
await app.listen({ port: config.port, host: config.bind });
