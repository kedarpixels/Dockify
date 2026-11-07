import type { Keyring } from "@dockify/crypto";
import { readSecretValue, type Db, type Tx } from "@dockify/db";
import { totpMatchedCounter } from "./totp.ts";

interface TotpUser {
  id: string;
  totpSecretId: string | null;
  totpConfirmedAt: Date | null;
}

/** Opens a user's TOTP secret, or null when none is stored or it cannot be opened. */
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
 * code cannot both win.
 */
export async function consumeTotp(db: Db, secret: string, userId: string, code: string, now = Date.now()): Promise<number | null> {
  const counter = totpMatchedCounter(secret, code, now);
  if (counter === null) return null;
  const claimed = await db.user.updateMany({
    where: { id: userId, OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: counter } }] },
    data: { totpLastUsedStep: counter },
  });
  return claimed.count === 1 ? counter : null;
}

/**
 * Second factor for a user with MFA on: a code from the authenticator app, nothing else. A lost
 * authenticator is turned off on the host (admin.ts disable-mfa).
 */
export async function verifySecondFactor(db: Db, ring: Keyring, user: TotpUser, code: string): Promise<boolean> {
  if (!user.totpConfirmedAt) return false;
  const secret = await totpSecretOf(db, ring, user);
  if (!secret) return false;
  return (await consumeTotp(db, secret, user.id, code)) !== null;
}
