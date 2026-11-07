/**
 * Terminal tickets. A ticket is what step-up buys: a random value good for one socket, for this
 * session, this app and this client, for 30 seconds. It lives only in this process: there is one api,
 * a restart ending every ticket is correct, and a database row would be one more place to read it from.
 * Only its hash is kept. Any attempt to use a ticket spends it, right or wrong, so a thief who gets it
 * and tries it first has also burnt it, and the owner just opens the terminal again.
 */
import { createHash } from "node:crypto";
import { terminal as T } from "@dockify/contracts";
import { hashToken, newToken, safeEqual } from "@dockify/crypto";

export interface TicketBinding {
  sessionId: string;
  appId: string;
  /** clientKey(): the address and user agent that asked for the ticket. */
  client: string;
}

interface Stored extends TicketBinding {
  expiresAt: number;
}

/** A ceiling on live tickets; each lives for seconds, so only an attack could reach it. */
const MAX_LIVE = 500;

/** Binds a ticket to a client without keeping the address or the agent string a second time. */
export const clientKey = (ip: string, userAgent: string | undefined): string =>
  createHash("sha256").update(`${ip}\0${userAgent ?? ""}`).digest("hex");

export class TerminalTickets {
  private readonly live = new Map<string, Stored>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = T.TERMINAL.ticketTtlMs) {
    this.ttlMs = ttlMs;
  }

  issue(binding: TicketBinding, now = Date.now()): { ticket: string; expiresAt: string } {
    for (const [hash, t] of this.live) if (t.expiresAt <= now) this.live.delete(hash);
    while (this.live.size >= MAX_LIVE) {
      const oldest = this.live.keys().next();
      if (oldest.done) break;
      this.live.delete(oldest.value);
    }
    const ticket = newToken();
    const expiresAt = now + this.ttlMs;
    this.live.set(hashToken(ticket), { ...binding, expiresAt });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** True only for a live ticket whose every binding matches. Any call spends the ticket it names. */
  consume(ticket: string, expect: TicketBinding, now = Date.now()): boolean {
    const hash = hashToken(ticket);
    const t = this.live.get(hash);
    if (!t) return false;
    this.live.delete(hash);
    return t.expiresAt > now && t.sessionId === expect.sessionId && t.appId === expect.appId && safeEqual(t.client, expect.client);
  }

  get size(): number {
    return this.live.size;
  }
}
