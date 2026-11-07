/**
 * The small text helpers every template shares. Anything that came from an operator or a user
 * (an instance name, an app name, an address) is escaped before it reaches markup, and a link is
 * accepted only as an absolute https URL (plain http only for a loopback host in development).
 */

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes text for an HTML body or a quoted attribute. */
export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

export class EmailInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailInputError";
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The URL as a string when it is safe to put behind a button, else an EmailInputError. */
export function safeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new EmailInputError("A link in an email must be an absolute URL");
  }
  const ok = u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
  if (!ok || u.username || u.password) throw new EmailInputError("A link in an email must be https");
  return u.toString();
}

/** One line of plain text with no control characters, clipped so a subject never runs away. */
export function oneLine(value: string, max = 200): string {
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** "s***@example.com": enough for the owner to recognise an address, not enough to harvest it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "30 Oct 2026, 14:05 UTC". Always UTC: the reader's time zone is unknown to the server. */
export function utcTime(at: Date): string {
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
