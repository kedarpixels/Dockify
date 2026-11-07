/**
 * Email over SMTP, optional per install: the owner enters their own mail server, login, a from name
 * and address and an optional reply-to. The settings are tried before they are kept, then the
 * password is sealed; it never comes back, not even a hint of it. packages/email smtp.ts holds the
 * address rule, TLS and what each failure means. Presets are the form's business: nothing here knows
 * a provider.
 *
 * Row: integrations kind email, name "default". config { host, port, tlsMode, username, fromName,
 * fromAddress, replyTo }, secretId the password (integration_token).
 */
import { readSecret, type Keyring } from "@dockify/crypto";
import { storeSecret, type Integration, type Tx } from "@dockify/db";
import {
  formatFrom, mailPolicyFromEnv, MailError, serverProblem, testEmail, tlsModeFor, type EmailConfig, type MailField, type MailPolicy, type SmtpServer, type TlsMode,
} from "@dockify/email";
import type { integrations as I } from "@dockify/contracts";
import type { z } from "zod";
import type { Handlers } from "../../app.ts";
import { audit } from "../../audit.ts";
import { HttpError, rateLimited } from "../../errors.ts";
import { allowRecipient, emailConfigOf, instanceName } from "../../mailer.ts";
import { requireSession, who, type IntegrationDeps } from "./deps.ts";
import { asJson, dropIntegration, findIntegration, openSecret, replaceSecret, setupDone } from "./store.ts";

const label = "Email";
const TARGET = "Mail server";

/** Which form field each failure names, as a code the web can read. */
const FIELD_CODES: Record<MailField, string> = {
  host: "EMAIL_HOST", port: "EMAIL_PORT", tlsMode: "EMAIL_TLS", username: "EMAIL_LOGIN", password: "EMAIL_LOGIN", fromAddress: "EMAIL_FROM",
};

/** A send's failure as the HttpError the form shows. Plain words, with the server's own when they help. */
export function mailProblem(e: unknown, action: string): HttpError {
  if (!(e instanceof MailError)) return new HttpError(502, `Could not ${action}`, "EMAIL_FAILED");
  const refused = e.kind === "recipient" || e.kind === "sender" || e.kind === "rejected";
  const message = refused && e.detail ? `${e.message} The server said: ${e.detail}` : e.message;
  const code = e.field ? FIELD_CODES[e.field] : refused ? "EMAIL_REFUSED" : "EMAIL_FAILED";
  return new HttpError(e.settingsRefused || refused ? 400 : 502, message, code, e.field ? { field: e.field } : undefined);
}

export async function emailView(db: Tx, row?: Integration | null) {
  const r = row === undefined ? await findIntegration(db, "email") : row;
  if (!r) return null;
  const c = emailConfigOf(r);
  return {
    host: c.host,
    port: c.port,
    tlsMode: c.tlsMode,
    username: c.username,
    hasPassword: r.secretId !== null,
    fromName: c.fromName,
    fromAddress: c.fromAddress,
    replyTo: c.replyTo,
    connectedAt: r.createdAt.toISOString(),
    error: r.error ?? null,
  };
}

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Seeds the row once from the installer's environment (DOCKIFY_SMTP_HOST, _PORT, _USER, and
 * DOCKIFY_SMTP_PASSWORD or its _FILE form, with DOCKIFY_EMAIL_FROM and DOCKIFY_EMAIL_FROM_NAME), so
 * the owner's email can be verified at setup. It is not dialled here: a blocked port must not stop
 * the api booting, and setup says so when the first code cannot go out.
 */
export async function seedEmailFromEnv(db: Tx, ring: Keyring, env: NodeJS.ProcessEnv = process.env, policy: MailPolicy = mailPolicyFromEnv(env)): Promise<boolean> {
  const password = readSecret("DOCKIFY_SMTP_PASSWORD", env);
  const host = env.DOCKIFY_SMTP_HOST?.trim().toLowerCase();
  const username = env.DOCKIFY_SMTP_USER?.trim();
  const port = Number(env.DOCKIFY_SMTP_PORT?.trim() || 587);
  const fromAddress = env.DOCKIFY_EMAIL_FROM?.trim().toLowerCase();
  if (!password || !host || !HOST.test(host) || !username || !fromAddress || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromAddress) || serverProblem(host, port, policy)) return false;
  // Only before setup completes. The secret files stay mounted, so seeding on every boot would bring
  // back an integration the owner disconnected (or a password they rotated away) at the next restart.
  if ((await setupDone(db)) || (await findIntegration(db, "email"))) return false;
  const fromName = (env.DOCKIFY_EMAIL_FROM_NAME?.trim() || "Dockify").replace(/["<>\\\r\n]/g, "").slice(0, 60) || "Dockify";
  const config: EmailConfig = { host, port, tlsMode: tlsModeFor(port), username, fromName, fromAddress, replyTo: null };
  const row = await db.integration.create({ data: { kind: "email", name: "default", config: asJson({ ...config }) } });
  const secretId = await storeSecret(db, ring, { kind: "integration_token", ownerType: "integration", ownerId: row.id }, password, null);
  await db.integration.update({ where: { id: row.id }, data: { secretId } });
  return true;
}

type Settings = z.infer<typeof I.EmailConnectBody>;

/**
 * The server and login a set of form values means. A blank password keeps the stored one, but only
 * for the server and login it was stored for: re-pointing the form would otherwise hand the stored
 * password to any host, so a changed host or username needs the password typed again.
 */
async function serverFrom(body: Settings, existing: Integration | null, open: () => Promise<string | null>, policy: MailPolicy): Promise<SmtpServer> {
  const problem = serverProblem(body.host, body.port, policy);
  if (problem) throw mailProblem(problem, "check the mail server");
  if (body.password) return { host: body.host, port: body.port, tlsMode: body.tlsMode, username: body.username, password: body.password };
  const stored = existing ? emailConfigOf(existing) : null;
  const sameLogin = stored && stored.host === body.host && stored.username === body.username;
  const password = sameLogin ? await open() : null;
  if (!password) throw new HttpError(400, stored && !sameLogin ? "Enter the password again: a stored password only goes to the server and username it was saved for." : "Enter the password", "EMAIL_LOGIN", { field: "password" });
  return { host: body.host, port: body.port, tlsMode: body.tlsMode, username: body.username, password };
}

const isDraft = (body: unknown): body is Settings => !!body && typeof body === "object" && "host" in body;

export function emailHandlers(deps: IntegrationDeps): Handlers {
  const policy = mailPolicyFromEnv();
  return {
    "integrations.email.connect": async ({ body, actor, req, ctx }) => {
      const existing = await findIntegration(ctx.db, "email");
      const server = await serverFrom(body, existing, () => (existing ? openSecret(ctx.db, ctx.ring, existing) : Promise.resolve(null)), policy);
      const fromAddress = body.fromAddress.toLowerCase();
      // Tried before it is kept, so what the card says connected did connect and log in.
      await deps.mail.verify(server).catch((e: unknown) => {
        throw mailProblem(e, "check the mail server");
      });
      const config = asJson({ host: server.host, port: server.port, tlsMode: server.tlsMode, username: server.username, fromName: body.fromName, fromAddress, replyTo: body.replyTo?.toLowerCase() ?? null });
      const row = await ctx.db.$transaction(async (tx) => {
        const r = existing
          ? await tx.integration.update({ where: { id: existing.id }, data: { config, status: "connected", error: null, lastCheckedAt: new Date() } })
          : await tx.integration.create({ data: { kind: "email", name: "default", config, lastCheckedAt: new Date() } });
        // No hint: a few characters of a mail password are worth more than a few of a random key.
        if (body.password) await replaceSecret(tx, ctx.ring, r, "primary", "integration_token", body.password, "");
        await audit(tx, {
          category: "config", action: existing ? "integration.email.update" : "integration.email.connect",
          verb: existing ? "updated the email settings" : "connected email", targetType: "integration", targetLabel: TARGET, ...who(actor, req),
        });
        return tx.integration.findUniqueOrThrow({ where: { id: r.id } });
      });
      return (await emailView(ctx.db, row))!;
    },

    "integrations.email.delete": async ({ actor, req, ctx }) => {
      await ctx.db.$transaction(async (tx) => {
        const row = await findIntegration(tx, "email");
        if (!row) return;
        await dropIntegration(tx, row);
        await audit(tx, { category: "config", action: "integration.email.delete", verb: "disconnected email", targetType: "integration", targetLabel: TARGET, ...who(actor, req) });
      });
      return undefined;
    },

    "integrations.email.test": async ({ body, actor, req, reply, ctx }) => {
      const a = requireSession(actor);
      const row = await findIntegration(ctx.db, "email");
      const open = () => (row ? openSecret(ctx.db, ctx.ring, row) : Promise.resolve(null));
      // The form's values when it sent them, unsaved; else what is stored, whose verdict the card shows.
      const draft = isDraft(body) ? body : null;
      const c = draft ?? (row && row.status !== "disconnected" ? emailConfigOf(row) : null);
      if (!c || !c.host) throw new HttpError(409, `${label} is not connected`, "NOT_CONNECTED");
      const password = draft ? null : await open();
      if (!draft && !password) throw new HttpError(409, `${label} is not connected`, "NOT_CONNECTED");
      const server = draft ? await serverFrom(draft, row, open, policy) : { host: c.host, port: c.port, tlsMode: c.tlsMode as TlsMode, username: c.username, password: password! };
      const user = await ctx.db.user.findUniqueOrThrow({ where: { id: a.userId }, select: { email: true, name: true } });
      if (!allowRecipient(ctx.limits, user.email)) throw rateLimited(reply, 120);
      const fromAddress = c.fromAddress.toLowerCase();
      const from = formatFrom(c.fromName, fromAddress);
      // The test must look exactly like the real emails, brand assets included: it says so in its copy.
      const message = testEmail({ instanceName: await instanceName(ctx.db), origin: ctx.config.publicUrl.origin, sentBy: user.name, from });
      try {
        await deps.mail.send(server, { fromName: c.fromName, fromAddress, to: user.email, replyTo: c.replyTo?.toLowerCase() ?? null, ...message });
      } catch (e) {
        // Only what is stored can have a verdict on the card: a draft says nothing about it.
        if (!draft && row && e instanceof MailError && e.settingsRefused) await ctx.db.integration.update({ where: { id: row.id }, data: { status: "error", error: e.cardError, lastCheckedAt: new Date() } });
        throw mailProblem(e, "send the test email");
      }
      if (!draft && row && row.status === "error") await ctx.db.integration.update({ where: { id: row.id }, data: { status: "connected", error: null, lastCheckedAt: new Date() } });
      await audit(ctx.db, { category: "config", action: "integration.email.test", verb: "sent a test email", targetType: "integration", targetLabel: TARGET, ...who(actor, req) });
      return { to: user.email };
    },
  };
}
