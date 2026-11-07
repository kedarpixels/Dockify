/**
 * Email delivery over SMTP, with the server and login the owner stored (packages/email smtp.ts).
 *
 *   email_send   one message the api rendered and sealed (an email_message secret). The job names
 *                only that secret, so neither the payload nor lastError ever holds an address,
 *                a code or a link. The sealed row is deleted once the message is settled.
 *   alert email  the email channel of an alert rule: one message per admin, sent from the
 *                alert_notify job (observe/channels.ts).
 *   mailEach     the loop behind every message to several people. One refused recipient costs only
 *                that recipient's copy.
 *
 * SMTP has no idempotency. Every send carries a key that becomes a stable Message-ID, and the mailer
 * skips a key its server already accepted, so a retried job does not repeat what went out. What can
 * still repeat: a message whose accepting reply was lost, or one sent before a worker restart.
 *
 * A send that fails says something about the integration only when the stored settings are at fault
 * (MailError.settingsRefused: a refused login, a host the address rule refuses). A refused recipient
 * or from address is that one send's problem, and the login goes on working.
 */
import { readSecretValue, type Db, type Integration, type SecretVault } from "@dockify/db";
import { alert, MailError, readEmailConfig, type AlertKind, type AppRef, type EmailMessage, type Mailer, type SmtpServer } from "@dockify/email";
import { Redactor } from "@dockify/redact";
import { PermanentJobError } from "../errors.ts";

export interface EmailDeps {
  db: Db;
  vault: SecretVault;
  mail: Mailer;
}

interface Sender {
  server: SmtpServer;
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
  row: Integration;
}

interface SealedMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The email integration ready to send, or null when it is not set up. */
export async function loadSender(db: Db, vault: SecretVault): Promise<Sender | null> {
  const row = await db.integration.findUnique({ where: { kind_name: { kind: "email", name: "default" } } });
  if (!row?.secretId || row.status === "disconnected") return null;
  const password = await readSecretValue(db, vault, row.secretId);
  if (!password) return null;
  const c = readEmailConfig(row.config);
  if (!c.host || !c.fromAddress) return null;
  return {
    server: { host: c.host, port: c.port, tlsMode: c.tlsMode, username: c.username, password },
    fromName: c.fromName,
    fromAddress: c.fromAddress,
    replyTo: c.replyTo,
    row,
  };
}

/** Settings that cannot work mark the row, so the Settings card says so instead of failing silently. */
async function markRefused(db: Db, row: Integration, e: MailError): Promise<void> {
  if (!e.settingsRefused) return;
  await db.integration.update({ where: { id: row.id }, data: { status: "error", error: e.cardError } }).catch(() => undefined);
}

/** A send went through, so a row a refusal marked is wrong now: a replaced password, or an older verdict. */
async function markWorking(db: Db, row: Integration): Promise<void> {
  if (row.status !== "error") return;
  await db.integration.update({ where: { id: row.id }, data: { status: "connected", error: null } }).catch(() => undefined);
}

const ADDRESS = /[^\s<>()"',;:]+@[^\s<>()"',;:]+/g;
/** A server's explanation can quote any address, not only the recipient's. */
const withoutAddresses = (s: string): string => s.replace(ADDRESS, "[address]");

/** A failure as a job may repeat it: no server text, so no address. */
const statusOf = (e: MailError): string => `email failed: ${e.smtpCode ?? e.kind}`;

export interface Recipient {
  id: string;
  email: string;
}

/**
 * One message to several people. Each is tried whatever became of the last, so one departed
 * teammate's mailbox never silences the rest, on this try or a retry. Settings that cannot work stop
 * at once, since no send can, and so does no connection, since the next would only wait out the same
 * failure. A recipient the server refused goes on the activity log by name.
 *
 * Throws to retry when a send may still work (the mailer skips the ones already accepted),
 * PermanentJobError when nothing went out and nothing will. Only a status leaves in those: the
 * server's text could name a recipient. Returns how many went out.
 */
export async function mailEach(deps: EmailDeps, sender: Sender, users: Recipient[], message: EmailMessage, keyOf: (userId: string) => string): Promise<number> {
  let sent = 0;
  let retry: MailError | null = null;
  const refused: Array<{ user: Recipient; e: MailError }> = [];
  for (const user of users) {
    try {
      await deps.mail.send(sender.server, { fromName: sender.fromName, fromAddress: sender.fromAddress, replyTo: sender.replyTo, to: user.email, ...message, idempotencyKey: keyOf(user.id) });
      sent += 1;
    } catch (e) {
      if (!(e instanceof MailError)) throw e;
      if (e.settingsRefused) {
        await markRefused(deps.db, sender.row, e);
        throw new PermanentJobError(statusOf(e));
      }
      if (e.retry) retry ??= e;
      else refused.push({ user, e });
      if (e.noConnection) break;
    }
  }
  if (sent) await markWorking(deps.db, sender.row);
  if (retry) throw new Error(statusOf(retry));
  for (const { user, e } of refused) {
    await deps.db.activityLog
      .create({ data: { category: "system", action: "email.refused", verb: "could not email", actorType: "system", targetType: "user", targetId: user.id, targetLabel: user.email, failed: true, suffix: withoutAddresses(e.detail ?? e.message).slice(0, 300) } })
      .catch(() => undefined);
  }
  if (!sent && refused.length) throw new PermanentJobError(statusOf(refused[0]!.e));
  return sent;
}

function parseMessage(raw: string): SealedMessage {
  const m = JSON.parse(raw) as Partial<SealedMessage>;
  if (typeof m.to !== "string" || typeof m.subject !== "string" || typeof m.html !== "string" || typeof m.text !== "string") {
    throw new PermanentJobError("email_send: the sealed message is malformed");
  }
  return { to: m.to, subject: m.subject, html: m.html, text: m.text };
}

export interface EmailJob {
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

/** The email_send job body. Throws to retry, PermanentJobError to stop. */
export async function runEmailSend(deps: EmailDeps, job: EmailJob): Promise<"sent" | "skipped"> {
  const p = job.payload as { messageId?: unknown; inviteId?: unknown } | null;
  const messageId = p?.messageId;
  if (typeof messageId !== "string" || !UUID.test(messageId)) throw new PermanentJobError("email_send payload is malformed");
  const drop = () => deps.db.secret.delete({ where: { id: messageId } }).catch(() => undefined);
  // An invite's email reports back on its row: the team list is the one place its sender will look.
  const inviteId = typeof p?.inviteId === "string" && UUID.test(p.inviteId) ? p.inviteId : null;
  const report = async (emailStatus: "sent" | "failed", emailError: string | null) => {
    if (inviteId) await deps.db.invite.updateMany({ where: { id: inviteId }, data: { emailStatus, emailError: emailError?.slice(0, 500) ?? null } }).catch(() => undefined);
  };

  const raw = await readSecretValue(deps.db, deps.vault, messageId);
  // Gone means an earlier attempt already settled it.
  if (raw === null) return "skipped";
  const message = parseMessage(raw);
  const sender = await loadSender(deps.db, deps.vault);
  if (!sender) {
    await drop();
    await report("failed", "Email is not set up any more");
    throw new PermanentJobError("Email is not set up any more, so the message was dropped");
  }

  try {
    await deps.mail.send(sender.server, { fromName: sender.fromName, fromAddress: sender.fromAddress, replyTo: sender.replyTo, ...message, idempotencyKey: messageId });
  } catch (e) {
    if (!(e instanceof MailError)) {
      if (job.attempts >= job.maxAttempts) await report("failed", "The email could not be sent");
      throw e;
    }
    await markRefused(deps.db, sender.row, e);
    // A server's explanation can echo the recipient, the subject (which carries a code) or another address.
    const why = withoutAddresses(new Redactor().conceal([message.to, message.subject]).line(e.detail ?? e.message));
    if (!e.retry || job.attempts >= job.maxAttempts) {
      await drop();
      await report("failed", why);
      throw new PermanentJobError(`Email not sent: ${why}`);
    }
    throw new Error(`Email not sent yet: ${why}`);
  }
  await drop();
  await markWorking(deps.db, sender.row);
  await report("sent", null);
  return "sent";
}

export interface AlertEmail {
  eventId: string;
  transition: "firing" | "resolved";
  kind: AlertKind;
  title: string;
  detail: string;
  /** The app, as the dashboard shows it (with its signed icon links), or a plain place for a host or service alert. */
  where: AppRef | string;
  at: Date;
  url: string;
  /** The dashboard's public origin, where the email's logo, icons and fonts load from. */
  origin: string;
}

/** The email channel of an alert: one message to each admin (mailEach says what a failure does). */
export async function sendAlertEmails(deps: EmailDeps, a: AlertEmail): Promise<number> {
  const sender = await loadSender(deps.db, deps.vault);
  if (!sender) return 0;
  const [inst, members] = await Promise.all([
    deps.db.instance.findUnique({ where: { id: 1 }, select: { name: true } }),
    deps.db.member.findMany({ where: { role: { in: ["admin"] }, user: { disabledAt: null } }, select: { user: { select: { id: true, email: true } } } }),
  ]);
  const message = alert({ instanceName: inst?.name ?? "Dockify", origin: a.origin, kind: a.kind, state: a.transition, title: a.title, detail: a.detail, where: a.where, at: a.at, url: a.url });
  return mailEach(deps, sender, members.map((m) => m.user), message, (id) => `alert:${a.eventId}:${a.transition}:${id}`);
}
