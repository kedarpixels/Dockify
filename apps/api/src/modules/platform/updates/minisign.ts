import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * Minisign (Ed25519) verification, compatible with the stock `minisign` tool.
 *
 *   public key   base64( "Ed" | keyId[8] | ed25519 pk[32] )
 *   .minisig     untrusted comment line
 *                base64( alg[2] | keyId[8] | sig[64] )   alg "ED" = BLAKE2b-512 prehashed, "Ed" = legacy
 *                trusted comment line
 *                base64( global sig[64] over sig | trusted comment )
 */
export class SignatureError extends Error {
  override name = "SignatureError";
}

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

export interface PublicKey {
  keyId: Buffer;
  key: KeyObject;
}

const b64 = (s: string, what: string): Buffer => {
  const t = s.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t)) throw new SignatureError(`${what} is not base64`);
  return Buffer.from(t, "base64");
};

/** Accepts the bare base64 line or the whole minisign.pub file. */
export function parsePublicKey(text: string): PublicKey {
  const line = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("untrusted comment:")).at(-1) ?? "";
  const raw = b64(line, "public key");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") throw new SignatureError("not a minisign Ed25519 public key");
  return { keyId: raw.subarray(2, 10), key: createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw.subarray(10)]), format: "der", type: "spki" }) };
}

export interface VerifiedSignature {
  trustedComment: string;
  prehashed: boolean;
}

export function verifyMinisign(message: Buffer, sigText: string, pub: PublicKey): VerifiedSignature {
  const lines = sigText.replace(/\r\n/g, "\n").split("\n");
  const [untrusted, sigLine, trustedLine, globalLine] = lines;
  if (!untrusted?.startsWith("untrusted comment:") || !sigLine || !trustedLine || !globalLine) {
    throw new SignatureError("malformed signature file");
  }
  const sig = b64(sigLine, "signature");
  if (sig.length !== 74) throw new SignatureError("signature has the wrong length");
  const alg = sig.subarray(0, 2).toString("latin1");
  if (alg !== "ED" && alg !== "Ed") throw new SignatureError("unsupported signature algorithm");
  if (!sig.subarray(2, 10).equals(pub.keyId)) throw new SignatureError("signed by a different key");
  const body = sig.subarray(10);

  const prehashed = alg === "ED";
  const signed = prehashed ? createHash("blake2b512").update(message).digest() : message;
  if (!verify(null, signed, pub.key, body)) throw new SignatureError("signature does not match");

  const TC = "trusted comment: ";
  if (!trustedLine.startsWith(TC)) throw new SignatureError("missing trusted comment");
  const trustedComment = trustedLine.slice(TC.length);
  const global = b64(globalLine, "global signature");
  if (global.length !== 64) throw new SignatureError("global signature has the wrong length");
  if (!verify(null, Buffer.concat([body, Buffer.from(trustedComment, "utf8")]), pub.key, global)) {
    throw new SignatureError("trusted comment was altered");
  }
  return { trustedComment, prehashed };
}
