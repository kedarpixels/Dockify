/**
 * Host-side account rescue (`dockify admin ...`), run over SSH inside the api container, never over HTTP.
 * set-domain and factory-reset need host root and live in the wrapper (installer/install.sh); only `check-domain` runs here.
 * Every account change ends the user's sessions, remembered browsers and pending sign ins, so a stolen cookie dies with it.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { hash as argonHash } from "@node-rs/argon2";
import { loadKeyring, type Keyring } from "@dockify/crypto";
import { createDb, defaultServerId, rewrapSecretRows, type Db } from "@dockify/db";
import { audit } from "./audit.ts";
import { hostProblem } from "./modules/integrations/dashboard-domain.ts";
import { revokeApiTokens, revokeSessions, voidResetLinks } from "./sessions.ts";

export type AdminCommand = "reset-password" | "disable-mfa" | "revoke-sessions";
const COMMANDS: AdminCommand[] = ["reset-password", "disable-mfa", "revoke-sessions"];

export const USAGE = `usage: dockify admin <${COMMANDS.join("|")}> <email>\n       dockify admin set-domain <host> | --sslip\n       dockify admin factory-reset [--delete-backups]\n       dockify admin reset-link\n       dockify admin rewrap-secrets`;

export function parseAdminArgs(argv: string[]): { command: AdminCommand; email: string } | null {
  const [command, email, ...rest] = argv;
  if (!command || !email || rest.length) return null;
  if (!COMMANDS.includes(command as AdminCommand)) return null;
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return null;
  return { command: command as AdminCommand, email: email.toLowerCase() };
}

/** A password strong enough to hand over once: 24 random bytes, URL-safe. */
export const generatePassword = (): string => randomBytes(24).toString("base64url");

/** Returns the text to print. Throws when the user does not exist. */
export async function runAdmin(db: Db, command: AdminCommand, email: string): Promise<string> {
  const user = await db.user.findUnique({ where: { email } });
  if (!user) throw new Error(`No user with the email ${email}`);
  // Nothing to turn off: leave the sessions and the activity log alone.
  if (command === "disable-mfa" && !user.totpConfirmedAt) return `Two-factor sign in is not on for ${email}. Nothing changed.`;
  const password = command === "reset-password" ? generatePassword() : null;
  const passwordHash = password ? await argonHash(password) : null;
  let tokens = 0;
  await db.$transaction(async (tx) => {
    if (passwordHash) {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash, passwordChangedAt: new Date() } });
      await voidResetLinks(tx, user.id);
      tokens = await revokeApiTokens(tx, user.id);
    }
    if (command === "disable-mfa") {
      await tx.user.update({ where: { id: user.id }, data: { totpSecretId: null, totpConfirmedAt: null, totpLastUsedStep: null } });
      if (user.totpSecretId) await tx.secret.delete({ where: { id: user.totpSecretId } });
    }
    await revokeSessions(tx, user.id);
    await tx.trustedDevice.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.loginChallenge.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: new Date() } });
    // The activity log reads "Dockify <verb> <email> <suffix>": a system row shows no person.
    const verb = { "reset-password": "reset the password of", "disable-mfa": "turned off two-factor sign-in for", "revoke-sessions": "signed out every session of" }[command];
    await audit(tx, {
      category: "access", action: `admin.${command}`, verb, suffix: "from the server (dockify admin)",
      actorType: "system", actorId: null, actorName: "host admin", targetType: "user", targetId: user.id, targetLabel: user.email,
    });
  });
  if (password) {
    const mfa = user.totpConfirmedAt ? `\nTwo-factor sign in is still on. If the authenticator is lost too, run: dockify admin disable-mfa ${email}` : "";
    return `New password for ${email}: ${password}\nEvery session of this user was ended${tokens ? `, and ${tokens} API token${tokens === 1 ? " was" : "s were"} revoked` : ""}. Sign in and change it.${mfa}`;
  }
  return command === "disable-mfa"
    ? `Two-factor sign-in is off for ${email}, and every session was ended. Sign in with the password, then turn two-factor on again.`
    : `Every session of ${email} was ended.`;
}

/**
 * For an agent that lost its volume and key: clearing the pin lets a join token work again.
 * The host command writes a new token first and the old hash is dropped here, so whoever read the old
 * token cannot race the new key; nothing joins until the worker restarts and offers the new one.
 */
export async function resetLink(db: Db): Promise<string> {
  const id = await defaultServerId(db);
  await db.$transaction(async (tx) => {
    await tx.server.update({ where: { id }, data: { certPin: null, joinTokenHash: null } });
    await audit(tx, {
      category: "access", action: "admin.reset-link", verb: "forgot the key of", suffix: "from the server (dockify admin)",
      actorType: "system", actorId: null, actorName: "host admin", targetType: "server", targetId: id, targetLabel: "this server's agent",
    });
  });
  return "This server's agent key is forgotten. Now run: dockify restart worker agent";
}

/**
 * Finishes a master key rotation in one transaction, so a failure leaves every row readable under the keys
 * that opened it before. Only after this can the old key leave master_key_previous.
 */
export async function rewrapSecrets(db: Db, ring: Keyring): Promise<string> {
  const count = await db.$transaction(
    async (tx) => {
      const n = await rewrapSecretRows(tx, ring);
      await tx.instance.updateMany({ where: { id: 1 }, data: { masterKeyFingerprint: ring.active } });
      await audit(tx, {
        category: "access", action: "admin.rewrap-secrets", verb: "re-sealed the stored secrets of", suffix: "from the server (dockify admin)",
        actorType: "system", actorId: null, actorName: "host admin", targetType: "instance", targetLabel: "this server", changes: [{ key: "secrets", before: null, after: String(n) }],
      });
      return n;
    },
    // A long pause beats a half done rotation.
    { maxWait: 60_000, timeout: 30 * 60_000 },
  );
  return count
    ? `${count} secret${count === 1 ? " was" : "s were"} re-sealed under key ${ring.active}. The previous key can now be removed from secrets/master_key_previous; see the Security docs.`
    : `Every secret is already sealed under key ${ring.active}. Nothing changed.`;
}

/**
 * A master key file newer than the running api means the api still seals with the old key, and
 * could not open what this command re-seals. In a container PID 1 is the api, or its init.
 */
export function apiStaleProblem(keyWrittenMs: number, apiStartedMs: number): string | null {
  return keyWrittenMs > apiStartedMs ? "The api started before this master key was written. Restart it first: dockify restart api" : null;
}

function apiStartedMs(): number | null {
  if (!existsSync("/proc/1/stat")) return null;
  const stat = readFileSync("/proc/1/stat", "utf8");
  // The fields after the command name; start time is field 22, in ticks since boot (100 a second on Linux).
  const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
  const boot = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
  return Number.isFinite(ticks) && Number.isFinite(boot) ? boot * 1000 + (ticks / 100) * 1000 : null;
}

async function main(): Promise<void> {
  if (process.argv[2] === "check-domain" && process.argv[3]) {
    const db = createDb();
    const problem = await hostProblem(db, process.argv[3]).finally(() => db.$disconnect());
    if (problem) process.stderr.write(`${problem.message}\n`);
    process.exit(problem ? 2 : 0);
  }
  if (process.argv[2] === "reset-link" && process.argv.length === 3) {
    const db = createDb();
    process.stdout.write(`${await resetLink(db).finally(() => db.$disconnect())}\n`);
    return;
  }
  if (process.argv[2] === "rewrap-secrets" && process.argv.length === 3) {
    const file = process.env.DOCKIFY_MASTER_KEY_FILE;
    const started = apiStartedMs();
    const problem = file && started !== null ? apiStaleProblem(statSync(file).mtimeMs, started) : null;
    if (problem) {
      process.stderr.write(`${problem}\n`);
      process.exit(1);
    }
    const db = createDb();
    try {
      process.stdout.write(`${await rewrapSecrets(db, loadKeyring())}\n`);
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\nNothing was changed: every secret still opens with the keys that opened it before.\n`);
      process.exitCode = 1;
    } finally {
      await db.$disconnect();
    }
    return;
  }
  const args = parseAdminArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(64);
  }
  const db = createDb();
  try {
    process.stdout.write(`${await runAdmin(db, args.command, args.email)}\n`);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
