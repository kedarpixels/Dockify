import { verify as argonVerify } from "@node-rs/argon2";

/** Verified against for a missing account too, so an unknown address takes as long as a known one. */
const DUMMY_HASH = "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** A stored hash that cannot be read is a wrong password, never a crash. */
export async function passwordMatches(hash: string | undefined, password: string): Promise<boolean> {
  try {
    return await argonVerify(hash ?? DUMMY_HASH, password);
  } catch {
    return false;
  }
}
