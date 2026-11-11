/**
 * In-memory token buckets: Dockify is one control-plane process, so a shared store would only add a failure mode.
 * Keys are client addresses from client-ip.ts, never a raw header, so a bucket cannot be shared or spoofed away.
 */

export interface LimitRule {
  perMinute: number;
  burst: number;
}

/** IPv6 collapses to its /64: one host is handed the whole /64, so the full address would give an attacker unlimited fresh buckets. */
export function rateKey(ip: string): string {
  if (!ip.includes(":") || ip.includes(".")) return ip;
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = Array(Math.max(0, 8 - h.length - t.length)).fill("0");
  return [...h, ...fill, ...t].slice(0, 4).map((g) => (g || "0").toLowerCase()).join(":") + "::/64";
}

/** The client's network for account-keyed limits (IPv4 /24, IPv6 /64), so hopping addresses inside it does not dodge the limit. */
export function networkKey(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  return ip.includes(":") ? rateKey(ip) : ip;
}

interface Bucket {
  tokens: number;
  updated: number;
}

/** Bounded so IPv6 address churn cannot turn the limiter into the memory leak it prevents. */
const MAX_TRACKED = 20_000;

export class Limiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly rule: LimitRule;

  constructor(rule: LimitRule) {
    this.rule = rule;
  }

  /** Null when allowed, else the seconds to wait. */
  take(key: string, now = Date.now()): number | null {
    const refillPerMs = this.rule.perMinute / 60_000;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= MAX_TRACKED) {
        const oldest = this.buckets.keys().next();
        if (!oldest.done) this.buckets.delete(oldest.value);
      }
      bucket = { tokens: this.rule.burst, updated: now };
    } else {
      bucket.tokens = Math.min(this.rule.burst, bucket.tokens + (now - bucket.updated) * refillPerMs);
      bucket.updated = now;
      this.buckets.delete(key);
    }
    this.buckets.set(key, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return null;
    }
    return Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000));
  }

  /** Like `take`, but spends nothing. */
  peek(key: string, now = Date.now()): number | null {
    const b = this.buckets.get(key);
    if (!b) return null;
    const refillPerMs = this.rule.perMinute / 60_000;
    const tokens = Math.min(this.rule.burst, b.tokens + (now - b.updated) * refillPerMs);
    return tokens >= 1 ? null : Math.max(1, Math.ceil((1 - tokens) / refillPerMs / 1000));
  }

  /** Hands back one token a `take` spent, up to the burst. */
  give(key: string): void {
    const b = this.buckets.get(key);
    if (b) b.tokens = Math.min(this.rule.burst, b.tokens + 1);
  }

  sweep(now = Date.now()): void {
    const fullAfterMs = (this.rule.burst / this.rule.perMinute) * 60_000;
    for (const [key, b] of this.buckets) if (now - b.updated > fullAfterMs) this.buckets.delete(key);
  }
}

/** Failed sign ins one account takes from one client network: 10 at once, then one every 90 seconds. */
export const LOGIN_PER_NETWORK: LimitRule = { perMinute: 10 / 15, burst: 10 };
/** Failed sign ins one account takes from every network together: the backstop for a spread-out guesser. */
export const LOGIN_PER_ACCOUNT: LimitRule = { perMinute: 50 / 15, burst: 50 };
/** How long a network that just finished a password reset skips the per-account ceiling. */
export const LOGIN_RESET_TRUST_MS = 3_600_000;
/** How far back a sign-in makes its network one the account knows. */
export const LOGIN_KNOWN_NETWORK_MS = 30 * 86_400_000;

/**
 * Sign-in limits. Only failures count, keyed per account and client network, so a sprayer elsewhere cannot lock
 * the owner out; a per-account ceiling across all networks bounds a spread-out guesser. `attempt` takes tokens
 * up front and `succeeded` returns them, so parallel guesses cannot all pass before a failure is recorded.
 */
export class LoginGuard {
  private readonly network = new Limiter(LOGIN_PER_NETWORK);
  private readonly account = new Limiter(LOGIN_PER_ACCOUNT);
  /** Networks that finished a password reset for an account, in this process, until the time held. */
  private readonly reset = new Map<string, number>();
  /** When each account's ceiling was last reported, so a flood writes one audit row a quarter hour. */
  private readonly reported = new Map<string, number>();

  /** Null when allowed (its tokens are taken), else the seconds to wait. `ceiling` false skips the per-account bucket for a client the account knows. */
  attempt(account: string, ip: string, now = Date.now(), ceiling = true): number | null {
    const net = `${account}|${networkKey(ip)}`;
    const a = this.network.peek(net, now);
    const b = ceiling ? this.account.peek(account, now) : null;
    if (a !== null || b !== null) return Math.max(a ?? 0, b ?? 0);
    this.network.take(net, now);
    if (ceiling) this.account.take(account, now);
    return null;
  }

  /** True when only the per-account ceiling blocks. Five networks can hold it down for good, so this is when a client the account knows is let through. */
  onlyCeiling(account: string, ip: string, now = Date.now()): boolean {
    return this.network.peek(`${account}|${networkKey(ip)}`, now) === null && this.account.peek(account, now) !== null;
  }

  /** Returns the tokens `attempt` took: only failures count. */
  succeeded(account: string, ip: string, ceiling = true): void {
    this.network.give(`${account}|${networkKey(ip)}`);
    if (ceiling) this.account.give(account);
  }

  /** A reset finished from this network: the mailbox owner is here, and their new password must work. */
  trustAfterReset(account: string, ip: string, now = Date.now()): void {
    this.reset.set(`${account}|${networkKey(ip)}`, now + LOGIN_RESET_TRUST_MS);
  }

  trustedAfterReset(account: string, ip: string, now = Date.now()): boolean {
    return (this.reset.get(`${account}|${networkKey(ip)}`) ?? 0) > now;
  }

  /** True once per quarter hour per account: time to record that its ceiling is being held down. */
  reportCeiling(account: string, now = Date.now()): boolean {
    if (now - (this.reported.get(account) ?? -Infinity) < 15 * 60_000) return false;
    this.reported.set(account, now);
    return true;
  }

  sweep(now = Date.now()): void {
    this.network.sweep(now);
    this.account.sweep(now);
    for (const [k, until] of this.reset) if (until <= now) this.reset.delete(k);
    for (const [k, at] of this.reported) if (now - at > 15 * 60_000) this.reported.delete(k);
  }
}

interface Attempts {
  fails: number;
  lockedUntil: number;
  updated: number;
}

const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_MS = 15 * 60_000;

/**
 * A guard keyed on the thing under attack. `check` honours a hard lockout and suits secrets only the holder
 * can try (a session's step-up). `rate` ignores it and suits attacker-known keys (an email), where a lockout
 * would let a stranger lock the owner out.
 */
export class SubjectGuard {
  private readonly bucket: Limiter;
  private readonly attempts = new Map<string, Attempts>();

  constructor(rule: LimitRule = { perMinute: 10, burst: 10 }) {
    this.bucket = new Limiter(rule);
  }

  check(subject: string, now = Date.now()): number | null {
    const a = this.attempts.get(subject);
    if (a && a.lockedUntil > now) return Math.max(1, Math.ceil((a.lockedUntil - now) / 1000));
    return this.bucket.take(subject, now);
  }

  /** Takes nothing from the bucket. */
  locked(subject: string, now = Date.now()): boolean {
    const a = this.attempts.get(subject);
    return !!a && a.lockedUntil > now;
  }

  rate(subject: string, now = Date.now()): number | null {
    return this.bucket.take(subject, now);
  }

  succeeded(subject: string): void {
    this.attempts.delete(subject);
  }

  failed(subject: string, now = Date.now()): void {
    const prev = this.attempts.get(subject);
    // A lockout that has already elapsed starts a fresh count, so a single late failure cannot
    // relock forever (which would let a password holder keep the owner out of MFA permanently).
    const a = prev && !(prev.lockedUntil !== 0 && now >= prev.lockedUntil) ? prev : { fails: 0, lockedUntil: 0, updated: now };
    a.fails += 1;
    a.updated = now;
    if (a.fails >= LOCKOUT_THRESHOLD) a.lockedUntil = now + LOCKOUT_MS;
    this.attempts.delete(subject);
    if (this.attempts.size >= MAX_TRACKED) {
      const oldest = this.attempts.keys().next();
      if (!oldest.done) this.attempts.delete(oldest.value);
    }
    this.attempts.set(subject, a);
  }

  sweep(now = Date.now()): void {
    for (const [key, a] of this.attempts) if (a.lockedUntil <= now && now - a.updated > LOCKOUT_MS) this.attempts.delete(key);
    this.bucket.sweep(now);
  }
}

/** Wrong authenticator codes one user gets before a lockout, on every route that checks one together. */
export const TOTP_MAX_FAILS = 10;
export const TOTP_LOCK_MS = 15 * 60_000;
export const TOTP_LOCK_MAX_MS = 24 * 3_600_000;

/** 15 minutes, doubling per lockout in a row, a day at most. The count lives on the user row (mfa.ts), so a restart cannot clear it. */
export function totpLockMs(lockouts: number): number {
  return Math.min(TOTP_LOCK_MAX_MS, TOTP_LOCK_MS * 2 ** Math.min(Math.max(0, lockouts), 20));
}

/** Every limiter one api process holds. One instance per app, so tests never share state. */
export class RateLimits {
  /** Anything that runs argon2 or checks a code. */
  readonly auth = new Limiter({ perMinute: 10, burst: 10 });
  /** Every signed-in route; a first paint fans out to a dozen calls. */
  readonly general = new Limiter({ perMinute: 300, burst: 120 });
  /** Credential-free routes get their own bucket, so anonymous traffic never drains the signed-in one. */
  readonly anon = new Limiter({ perMinute: 120, burst: 60 });
  /**
   * Signed webhook receivers. GitHub sends a busy organization's events from a few addresses and does not retry
   * a 429, so this is large; the signature stops a forger, this only bounds signature work per address.
   */
  readonly webhook = new Limiter({ perMinute: 1200, burst: 300 });
  /** Single env value reveals (eye and copy), keyed on the session or token, not the address. */
  readonly reveal = new Limiter({ perMinute: 60, burst: 60 });
  /** Terminal tickets, keyed on the session: a person opens a few, a loop does not get thousands. */
  readonly terminalTicket = new Limiter({ perMinute: 10, burst: 10 });
  readonly login = new LoginGuard();
  /** Step-up by password, keyed on the session. A code goes through the per-user lockout in mfa.ts. */
  readonly stepUp = new SubjectGuard();
  readonly password = new SubjectGuard();
  /** Confirming a new authenticator during setup, keyed on the session. */
  readonly totp = new SubjectGuard();
  /** Forgot password, keyed on the (attacker-known) email: rate only, never a lockout. */
  readonly forgot = new SubjectGuard({ perMinute: 3, burst: 5 });
  /** Asking for an email code, keyed on the user. */
  readonly emailCode = new SubjectGuard({ perMinute: 2, burst: 5 });
  /** Entering an email code, keyed on the user, with the hard lockout. */
  readonly emailConfirm = new SubjectGuard();
  /** Mail to one address, keyed on its hash: a burst of 5, then one every 2 minutes. */
  readonly recipient = new Limiter({ perMinute: 0.5, burst: 5 });

  sweep(now = Date.now()): void {
    this.auth.sweep(now);
    this.webhook.sweep(now);
    this.general.sweep(now);
    this.anon.sweep(now);
    this.reveal.sweep(now);
    this.recipient.sweep(now);
    for (const g of [this.login, this.stepUp, this.password, this.totp, this.forgot, this.emailCode, this.emailConfirm]) g.sweep(now);
  }
}
