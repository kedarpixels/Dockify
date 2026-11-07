/**
 * The one way Dockify sends mail: SMTP over TLS, with the owner's own server and login. No provider
 * code; a provider is only the host, port and login the owner enters.
 *
 *   The address rule  the host is resolved once through net-guard, every answer must be public and
 *                     not this server's own, and the checked address is what the socket dials. The
 *                     name stays for SNI and certificate verification, so DNS rebinding cannot move
 *                     the connection and a certificate for another name is refused.
 *   TLS               implicit TLS or STARTTLS, nothing else. Mail and credentials never cross an
 *                     unencrypted connection: a server that will not upgrade is a failed send.
 *   Time              connect, greeting and each quiet gap have limits, and a deadline covers the
 *                     whole exchange, so a server that drips a byte at a time cannot hold a worker
 *                     lane or an api request.
 *   Failures          every failure is a MailError saying what went wrong in plain words, whether a
 *                     retry can help and whether the stored settings are at fault. Nothing from the
 *                     server reaches the error without the password taken out.
 *   Retries           SMTP has no idempotency. A send with an idempotency key carries a Message-ID
 *                     made from it, so a repeat is recognisable, and this process remembers the keys
 *                     a server accepted, so a retried job skips those. A repeat is still possible
 *                     when the reply to DATA is lost or the process restarts between attempts.
 */
import { createHash } from "node:crypto";
import { isIP, Socket } from "node:net";
import nodemailer from "nodemailer";
import { isPublicAddress, isPublicHostname, OutboundError, pinPublicHost, type AsyncResolver } from "@dockify/net-guard";
import { MARK, Redactor } from "@dockify/redact";

export type TlsMode = "implicit" | "starttls";

/** The ports mail is sent on. Any other port is refused, so this can never probe another service. */
export const SMTP_PORTS = [25, 465, 587, 2465, 2525, 2587] as const;

/** Implicit TLS on 465 and 2465, STARTTLS everywhere else. */
export const tlsModeFor = (port: number): TlsMode => (port === 465 || port === 2465 ? "implicit" : "starttls");

export interface SmtpServer {
  host: string;
  port: number;
  tlsMode: TlsMode;
  username: string;
  password: string;
}

/** The non-secret half of the email integration row. */
export interface EmailConfig {
  host: string;
  port: number;
  tlsMode: TlsMode;
  username: string;
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
}

/** Reads a row's config. A row that cannot send has an empty host or from address. */
export function readEmailConfig(config: unknown): EmailConfig {
  const c = (config && typeof config === "object" && !Array.isArray(config) ? config : {}) as Record<string, unknown>;
  const port = typeof c.port === "number" ? c.port : 0;
  return {
    host: typeof c.host === "string" ? c.host : "",
    port,
    tlsMode: c.tlsMode === "implicit" || c.tlsMode === "starttls" ? c.tlsMode : tlsModeFor(port),
    username: typeof c.username === "string" ? c.username : "",
    fromName: typeof c.fromName === "string" ? c.fromName : "Dockify",
    fromAddress: typeof c.fromAddress === "string" ? c.fromAddress : "",
    replyTo: typeof c.replyTo === "string" ? c.replyTo : null,
  };
}

export interface OutgoingEmail {
  fromName: string;
  fromAddress: string;
  to: string;
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
  /** Stable across retries of one send: it becomes the Message-ID, and an accepted key is not sent again. */
  idempotencyKey?: string;
}

// ------------------------------------------------------------------ failures

/**
 *   auth        the server refused the login (530, 534, 535, 538): nothing can send until it changes
 *   blocked     the settings point somewhere the address rule refuses: same
 *   recipient   a refused recipient (550, 551, 553 and so on): that send's failure only
 *   sender      the server refused the from address: every send would fail, but the login is fine
 *   rejected    the server refused this message for another reason
 *   busy        a 4xx answer: try again later
 *   unreachable no connection, or the connection dropped or timed out
 *   dns         the host has no address
 *   tls         no secure connection: a refused STARTTLS, a bad certificate, a wrong mode for the port
 */
export type MailFailure = "auth" | "blocked" | "recipient" | "sender" | "rejected" | "busy" | "unreachable" | "dns" | "tls";
export type MailField = "host" | "port" | "tlsMode" | "username" | "password" | "fromAddress";

const NEVER_RETRY = new Set<MailFailure>(["auth", "blocked", "recipient", "sender", "rejected"]);
const NO_CONNECTION = new Set<MailFailure>(["blocked", "unreachable", "dns", "tls"]);

/** The card's words when the stored login stops working. */
export const LOGIN_REFUSED = "The mail server refused the stored username or password";
const HOST_REFUSED = "The stored mail server is not allowed: it points at a private address or at this server";

export class MailError extends Error {
  readonly kind: MailFailure;
  /** The form field to fix, when one is at fault. */
  readonly field: MailField | null;
  /** The server's reply code, when it answered. */
  readonly smtpCode: number | null;
  /** The server's own words with the password taken out. May name an address. */
  readonly detail: string | null;
  constructor(kind: MailFailure, message: string, o: { field?: MailField | null; smtpCode?: number | null; detail?: string | null } = {}) {
    super(message);
    this.name = "MailError";
    this.kind = kind;
    this.field = o.field ?? null;
    this.smtpCode = o.smtpCode ?? null;
    this.detail = o.detail ?? null;
  }

  /** Whether trying again later can help. */
  get retry(): boolean {
    return !NEVER_RETRY.has(this.kind);
  }

  /** Whether the stored settings are at fault for every send: what marks the card red and stops at once. */
  get settingsRefused(): boolean {
    return this.kind === "auth" || this.kind === "blocked";
  }

  /** Why the card is red, when settingsRefused. */
  get cardError(): string {
    return this.kind === "blocked" ? HOST_REFUSED : LOGIN_REFUSED;
  }

  /** Whether no connection was made, so the next recipient would only wait out the same failure. */
  get noConnection(): boolean {
    return NO_CONNECTION.has(this.kind);
  }
}

const unreachable = (host: string, port: number) =>
  `Could not reach ${host} on port ${port}. Many VPS providers block outbound mail ports. Try the provider's alternate port, such as 2465 or 2587 for Resend, or ask your VPS provider to open it.`;
const refusedHost = (host: string) => `${host} is not allowed. Use your mail provider's public host name, not a private address or this server.`;

interface NodemailerError extends Error {
  code?: string;
  responseCode?: number;
  response?: string;
  command?: string;
}

/** Node's and OpenSSL's words for a certificate or handshake that failed. */
const TLS_FAILURE = /^(?:CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH|EPROTO$)/;
const TLS_WORDS = /certificate|self[- ]signed|altname|\bssl\b|\btls\b|handshake|wrong version number/i;
const LOGIN_CODES = new Set([530, 534, 535, 538]);

/** Takes the password out of a server's words, plain or base64 as an AUTH exchange would carry it. */
function scrub(words: string | undefined, username: string, password: string): string | null {
  if (!words) return null;
  const encoded = (s: string) => Buffer.from(s, "utf8").toString("base64");
  let out = words.replace(/[\r\n]+/g, " ").trim();
  for (const secret of [encoded(`\0${username}\0${password}`), encoded(password), password]) {
    if (secret.length >= 4) out = out.split(secret).join(MARK);
  }
  return new Redactor().line(out).slice(0, 300) || null;
}

/** What a nodemailer failure means. Exported for the wire tests. */
export function classify(e: unknown, host: string, port: number, username: string, password: string): MailError {
  if (e instanceof MailError) return e;
  const err = (e ?? {}) as NodemailerError;
  const code = err.code ?? "";
  const reply = typeof err.responseCode === "number" ? err.responseCode : null;
  const detail = scrub(err.response, username, password);
  const tells = { smtpCode: reply, detail };
  const busy = () => new MailError("busy", `${host} is busy. Try again in a moment.`, tells);
  if (code === "ETLS" || code === "EREQUIRETLS" || TLS_FAILURE.test(code) || (code !== "EAUTH" && reply === null && TLS_WORDS.test(err.message ?? ""))) {
    return new MailError("tls", `Could not make a secure connection to ${host} on port ${port}, so nothing was sent. Check that the TLS mode fits this port and that the server has a valid certificate.`, { ...tells, field: "tlsMode" });
  }
  if (reply !== null && LOGIN_CODES.has(reply)) {
    return new MailError("auth", `${host} refused the login. Check the username and password fields.`, { ...tells, field: "password" });
  }
  if (reply !== null && reply >= 400 && reply < 500) return busy();
  if (code === "EAUTH" || code === "ENOAUTH") return new MailError("auth", `${host} refused the login. Check the username and password fields.`, { ...tells, field: "password" });
  if (reply !== null && reply >= 500) {
    if (err.command === "RCPT TO") return new MailError("recipient", "The mail server refused this recipient.", tells);
    if (err.command === "MAIL FROM") return new MailError("sender", "The mail server refused the from address. Check that your provider allows sending from it.", { ...tells, field: "fromAddress" });
    return new MailError("rejected", "The mail server refused this message.", tells);
  }
  if (code === "EDNS" || code === "ENOTFOUND" || code === "EAI_AGAIN") return new MailError("dns", `Could not find ${host}. Check the host name.`, { field: "host" });
  return new MailError("unreachable", unreachable(host, port), { field: "port" });
}

// ------------------------------------------------------------------ the address rule

export interface MailPolicy {
  /** Names of this control plane: the dashboard's host and the reserved system hosts. */
  ownHosts: ReadonlySet<string>;
  /** This server's own public addresses, so an alias for it is refused as well. */
  ownAddresses: ReadonlySet<string>;
  resolve?: AsyncResolver;
}

const normal = (host: string) => host.trim().toLowerCase().replace(/\.$/, "");

/** The policy from the environment both the api and the worker run with. */
export function mailPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): MailPolicy {
  const hosts = (env.DOCKIFY_RESERVED_HOSTS ?? "").split(",").map(normal).filter(Boolean);
  try {
    if (env.DOCKIFY_PUBLIC_URL) hosts.push(normal(new URL(env.DOCKIFY_PUBLIC_URL).hostname));
  } catch {
    // A bad public URL stops the services elsewhere; it adds no name here.
  }
  return { ownHosts: new Set(hosts), ownAddresses: new Set([env.DOCKIFY_SERVER_IPV4, env.DOCKIFY_SERVER_IPV6].map((a) => a?.trim().toLowerCase() ?? "").filter(Boolean)) };
}

/** The problem with a host and port before anything dials them, or null. For the form and the first-boot seed. */
export function serverProblem(host: string, port: number, policy: MailPolicy): MailError | null {
  if (!(SMTP_PORTS as readonly number[]).includes(port)) {
    return new MailError("blocked", `Use one of the mail ports: ${SMTP_PORTS.join(", ")}.`, { field: "port" });
  }
  const name = normal(host);
  if (!isPublicHostname(name) || policy.ownHosts.has(name)) return new MailError("blocked", refusedHost(name || "That host"), { field: "host" });
  return null;
}

/** Resolves once and answers the address to dial, or throws the MailError that says why not. */
export async function pinServer(host: string, port: number, policy: MailPolicy): Promise<string> {
  const problem = serverProblem(host, port, policy);
  if (problem) throw problem;
  const name = normal(host);
  let address: string;
  try {
    address = await pinPublicHost(name, policy.resolve);
  } catch (e) {
    if (e instanceof OutboundError && e.code === "UNRESOLVED") throw new MailError("dns", `Could not find ${name}. Check the host name.`, { field: "host" });
    throw new MailError("blocked", refusedHost(name), { field: "host" });
  }
  // Checked again on the address itself, with this server's own added to the rule.
  if (!isPublicAddress(address) || policy.ownAddresses.has(address.toLowerCase())) throw new MailError("blocked", refusedHost(name), { field: "host" });
  return address;
}

// ------------------------------------------------------------------ the exchange

/** One resolved server: the address to dial, the name to verify it against. */
export interface SmtpTarget extends SmtpServer {
  address: string;
  /** A test's private CA. Production uses the system roots only. */
  ca?: string;
}

const CONNECT_MS = 10_000;
const GREETING_MS = 10_000;
const QUIET_MS = 15_000;
/** The whole exchange. Below the web's 60 second wait, so the owner reads the reason, not a timeout. */
const DEADLINE_MS = 30_000;

export interface SmtpTimings {
  connectMs?: number;
  greetingMs?: number;
  quietMs?: number;
  deadlineMs?: number;
}

const ADDRESS = /^[^\s@<>"(),:;\\[\]\p{Cc}]+@[^\s@<>"(),:;\\[\]\p{Cc}]+$/u;
/** One header line: no line breaks or other control characters, and no running on for ever. */
const oneLine = (s: string, max: number) => s.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
const cleanName = (s: string) => oneLine(s.replace(/["<>\\]/g, ""), 120);

/** The domain part of an address, lowercased. */
export const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/** `"Name" <address>`, with anything that could break the header taken out of the name. */
export function formatFrom(name: string, address: string): string {
  const clean = cleanName(name);
  return clean ? `"${clean}" <${address}>` : address;
}

/** A Message-ID that stays the same for every attempt at one send. */
export const stableMessageId = (key: string, fromAddress: string) => `<${createHash("sha256").update(key).digest("hex").slice(0, 40)}@${domainOf(fromAddress)}>`;

function transportFor(t: SmtpTarget, ehlo: string, socket: Socket, o: SmtpTimings) {
  const servername = isIP(t.host) ? undefined : normal(t.host);
  return nodemailer.createTransport({
    host: t.address,
    port: t.port,
    socket,
    secure: t.tlsMode === "implicit",
    // STARTTLS or nothing: a server that does not offer it, or refuses it, ends the exchange before any login.
    requireTLS: t.tlsMode === "starttls",
    ...(servername ? { servername } : {}),
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2", ...(servername ? { servername } : {}), ...(t.ca ? { ca: t.ca } : {}) },
    auth: { user: t.username, pass: t.password },
    forceAuth: true,
    // Without this it would announce the container's id.
    name: ehlo,
    connectionTimeout: o.connectMs ?? CONNECT_MS,
    greetingTimeout: o.greetingMs ?? GREETING_MS,
    socketTimeout: o.quietMs ?? QUIET_MS,
    logger: false,
    debug: false,
    // Every part is a string this process rendered. Nothing is ever read from a path or a URL.
    disableFileAccess: true,
    disableUrlAccess: true,
  } as Parameters<typeof nodemailer.createTransport>[0]);
}

/** Runs one exchange under the deadline, and turns whatever goes wrong into a MailError. */
async function exchange<T>(t: SmtpTarget, ehlo: string, o: SmtpTimings, work: (tx: ReturnType<typeof nodemailer.createTransport>) => Promise<T>): Promise<T> {
  const socket = new Socket();
  // A socket error is reported by the exchange; this keeps a late one from being unhandled.
  socket.on("error", () => undefined);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error("The exchange took too long"), { code: "ETIMEDOUT" }));
    }, o.deadlineMs ?? DEADLINE_MS);
  });
  try {
    return await Promise.race([work(transportFor(t, ehlo, socket, o)), late]);
  } catch (e) {
    throw classify(e, t.host, t.port, t.username, t.password);
  } finally {
    clearTimeout(timer);
  }
}

/** Sends one message over a resolved target. Answers its Message-ID. */
export function deliver(t: SmtpTarget, email: OutgoingEmail, o: SmtpTimings = {}): Promise<{ id: string }> {
  if (!ADDRESS.test(email.to)) return Promise.reject(new MailError("recipient", "The recipient's address is not valid."));
  if (email.replyTo && !ADDRESS.test(email.replyTo)) return Promise.reject(new MailError("rejected", "The reply-to address is not valid."));
  if (!ADDRESS.test(email.fromAddress)) return Promise.reject(new MailError("sender", "The from address is not valid.", { field: "fromAddress" }));
  return exchange(t, domainOf(email.fromAddress), o, async (tx) => {
    const info = await tx.sendMail({
      from: { name: cleanName(email.fromName), address: email.fromAddress },
      to: email.to,
      ...(email.replyTo ? { replyTo: email.replyTo } : {}),
      subject: oneLine(email.subject, 500),
      text: email.text,
      html: email.html,
      envelope: { from: email.fromAddress, to: [email.to] },
      ...(email.idempotencyKey ? { messageId: stableMessageId(email.idempotencyKey, email.fromAddress) } : {}),
      xMailer: false,
    } as Parameters<typeof tx.sendMail>[0]);
    return { id: String((info as { messageId?: unknown }).messageId ?? "") };
  });
}

/** Connects, upgrades and logs in, and sends nothing. */
export function verify(t: SmtpTarget, o: SmtpTimings = {}): Promise<void> {
  return exchange(t, "localhost", o, async (tx) => {
    await tx.verify();
  });
}

// ------------------------------------------------------------------ the mailer

export interface Mailer {
  send(server: SmtpServer, email: OutgoingEmail): Promise<{ id: string }>;
  /** Checks that the settings work, without sending anything. */
  verify(server: SmtpServer): Promise<void>;
}

const ACCEPTED_TTL_MS = 24 * 60 * 60_000;
const ACCEPTED_MAX = 10_000;

/**
 * The address rule in front of the exchange. `wire` is the socket side, replaced only by tests that
 * check what it was told to dial.
 */
export function createMailer(policy: MailPolicy, wire: { deliver: typeof deliver; verify: typeof verify } = { deliver, verify }): Mailer {
  const accepted = new Map<string, number>();
  const remember = (key: string) => {
    const now = Date.now();
    for (const [k, at] of accepted) {
      if (accepted.size >= ACCEPTED_MAX || now - at > ACCEPTED_TTL_MS) accepted.delete(k);
      else break;
    }
    accepted.set(key, now);
  };
  return {
    async send(server, email) {
      const key = email.idempotencyKey;
      const at = key ? accepted.get(key) : undefined;
      if (key && at !== undefined && Date.now() - at <= ACCEPTED_TTL_MS) return { id: stableMessageId(key, email.fromAddress) };
      const address = await pinServer(server.host, server.port, policy);
      const out = await wire.deliver({ ...server, address }, email);
      if (key) remember(key);
      return out;
    },
    async verify(server) {
      const address = await pinServer(server.host, server.port, policy);
      await wire.verify({ ...server, address });
    },
  };
}
