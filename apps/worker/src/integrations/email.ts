/**
 * Email over SMTP. An email_send job names only a sealed email_message secret, so neither the payload
 * nor lastError ever holds an address, a code or a link. SMTP has no idempotency: each send's key
 * becomes a stable Message-ID and the mailer skips a key its server already accepted.
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
 * Each recipient is tried whatever became of the last. Throws to retry when a send may still work,
 * PermanentJobError when nothing will; both carry only a status, as server text could name a recipient.
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

/** Throws to retry, PermanentJobError to stop. */
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
  where: AppRef | string;
  at: Date;
  url: string;
  origin: string;
}

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
