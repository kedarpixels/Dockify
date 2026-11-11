import type { Keyring } from "@dockify/crypto";
import { readSecretValue, type Db, type Tx } from "@dockify/db";
import { TOTP_MAX_FAILS, totpLockMs } from "./ratelimit.ts";
import { totpMatchedCounter } from "./totp.ts";

export interface TotpUser {
  id: string;
  totpSecretId: string | null;
  totpConfirmedAt: Date | null;
}

/** Null when none is stored or it cannot be opened. */
export async function totpSecretOf(db: Tx, ring: Keyring, user: TotpUser): Promise<string | null> {
  if (!user.totpSecretId) return null;
  try {
    return await readSecretValue(db, ring, user.totpSecretId);
  } catch {
    return null;
  }
}

/**
 * Verifies a TOTP code and spends its time step, so the same code can never be accepted twice
 * (RFC 6238 5.2). The step claim is one conditional UPDATE, so two parallel requests with one
 * code cannot both win. The same UPDATE clears the user's wrong-code count and lockouts.
 */
export async function consumeTotp(db: Db, secret: string, userId: string, code: string, now = Date.now()): Promise<number | null> {
  const counter = totpMatchedCounter(secret, code, now);
  if (counter === null) return null;
  const claimed = await db.user.updateMany({
    where: { id: userId, OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: counter } }] },
    data: { totpLastUsedStep: counter, totpFailedCount: 0, totpLockouts: 0, totpLockedUntil: null },
  });
  return claimed.count === 1 ? counter : null;
}

export type TotpCheck =
  | { ok: true }
  /** `wait`: seconds the user is locked out for, null when not. `engaged`: this guess is what locked it. `first`: no lockout came before it. */
  | { ok: false; wait: number | null; engaged: boolean; first: boolean };

const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

/** Where a refused or wrong guess leaves the user, starting the lockout when the count is spent. */
async function lockState(db: Db, userId: string, now: number): Promise<{ wait: number | null; engaged: boolean; first: boolean }> {
  const row = await db.user.findUnique({ where: { id: userId }, select: { totpFailedCount: true, totpLockouts: true, totpLockedUntil: true } });
  const until = row?.totpLockedUntil?.getTime() ?? 0;
  if (until > now) return { wait: seconds(until - now), engaged: false, first: false };
  if (!row || row.totpFailedCount < TOTP_MAX_FAILS) return { wait: null, engaged: false, first: false };
  const ms = totpLockMs(row.totpLockouts);
  // Matching on the lockout count lets one of several parallel wrong guesses start it, once.
  const won = await db.user.updateMany({
    where: { id: userId, totpLockouts: row.totpLockouts, totpFailedCount: { gte: TOTP_MAX_FAILS } },
    data: { totpFailedCount: 0, totpLockouts: { increment: 1 }, totpLockedUntil: new Date(now + ms) },
  });
  return { wait: seconds(ms), engaged: won.count === 1, first: won.count === 1 && row.totpLockouts === 0 };
}

/**
 * The one authenticator check, shared by sign in, step-up and turning two-factor off, so they spend one budget.
 * The count is on the user row, so a restart keeps it, and only a right code clears it.
 */
export async function checkTotp(db: Db, ring: Keyring, user: TotpUser, code: string, now = Date.now()): Promise<TotpCheck> {
  // The guess is counted before it is checked, so parallel guesses cannot all pass an unspent count.
  const counted = await db.user.updateMany({
    where: { id: user.id, totpFailedCount: { lt: TOTP_MAX_FAILS }, OR: [{ totpLockedUntil: null }, { totpLockedUntil: { lte: new Date(now) } }] },
    data: { totpFailedCount: { increment: 1 } },
  });
  if (counted.count === 1) {
    const secret = user.totpConfirmedAt ? await totpSecretOf(db, ring, user) : null;
    if (secret && (await consumeTotp(db, secret, user.id, code, now)) !== null) return { ok: true };
  }
  const state = await lockState(db, user.id, now);
  // Not counted and not locked: parallel guesses hold the last of the count. Refuse this one briefly.
  return { ok: false, ...state, wait: state.wait ?? (counted.count === 1 ? null : 1) };
}
