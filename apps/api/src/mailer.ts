/**
 * Outgoing email from the api. Email is optional per install: nothing here sends unless the owner
 * connected a mail server in Settings, Integrations, and every caller keeps working without it.
 *
 * A message is rendered here, sealed whole (recipient, subject and body) into one email_message
 * secret, and handed to the worker as an email_send job that names only the secret id. So the
 * jobs table, its lastError and every log line stay free of addresses, codes and links; the worker
 * opens the message through the audited secrets route, sends it over SMTP, retries on the queue
 * with a stable Message-ID, and deletes the sealed row once it is settled.
 */
import { randomUUID } from "node:crypto";
import { hashToken, type Keyring } from "@dockify/crypto";
import { enqueueTx, storeSecret, type Db, type Integration, type Prisma, type Tx } from "@dockify/db";
import { readEmailConfig, type EmailConfig, type EmailMessage } from "@dockify/email";
import type { RateLimits } from "./ratelimit.ts";

export const EMAIL_JOB_ATTEMPTS = 5;

export function emailConfigOf(row: Pick<Integration, "config">): EmailConfig {
  return readEmailConfig(row.config);
}

/** The email integration row when it can send, else null. */
export async function emailRow(db: Tx): Promise<Integration | null> {
  const row = await db.integration.findUnique({ where: { kind_name: { kind: "email", name: "default" } } });
  return row && row.secretId && row.status !== "disconnected" ? row : null;
}

export const emailEnabled = async (db: Tx): Promise<boolean> => (await emailRow(db)) !== null;

export async function instanceName(db: Tx): Promise<string> {
  return (await db.instance.findUnique({ where: { id: 1 }, select: { name: true } }))?.name ?? "Dockify";
}

/**
 * Per-recipient budget, keyed by a hash so the limiter never holds an address. False means this
 * address had enough mail for now; the caller decides whether that is an error or a quiet skip.
 */
export function allowRecipient(limits: RateLimits, to: string): boolean {
  return limits.recipient.take(hashToken(to.trim().toLowerCase())) === null;
}

/**
 * Seals one message and enqueues its send inside the caller's transaction. Returns the job id. With
 * inviteId the worker writes the outcome on that invite, so a refused address does not read as sent.
 */
export async function queueEmailTx(tx: Prisma.TransactionClient, ring: Keyring, to: string, message: EmailMessage, about: { inviteId?: string } = {}): Promise<string> {
  const ownerId = randomUUID();
  const body = JSON.stringify({ to: to.trim().toLowerCase(), subject: message.subject, html: message.html, text: message.text });
  const messageId = await storeSecret(tx, ring, { kind: "email_message", ownerType: "email", ownerId }, body, null);
  return enqueueTx(tx, { kind: "email_send", lane: "maintenance", payload: { messageId, ...about }, maxAttempts: EMAIL_JOB_ATTEMPTS });
}

/** queueEmailTx in its own transaction. */
export async function queueEmail(db: Db, ring: Keyring, to: string, message: EmailMessage): Promise<string> {
  return db.$transaction((tx) => queueEmailTx(tx, ring, to, message));
}
