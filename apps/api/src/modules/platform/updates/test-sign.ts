import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

/** Test-only minisign signer, byte-compatible with `minisign -S` (prehashed "ED" by default). */
export function testSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pk = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const keyId = randomBytes(8);
  const pub = `untrusted comment: minisign public key\n${Buffer.concat([Buffer.from("Ed"), keyId, pk]).toString("base64")}\n`;

  const signMessage = (message: Buffer, trusted: string, alg: "ED" | "Ed" = "ED", id = keyId) => {
    const data = alg === "ED" ? createHash("blake2b512").update(message).digest() : message;
    const sig = sign(null, data, privateKey);
    const global = sign(null, Buffer.concat([sig, Buffer.from(trusted, "utf8")]), privateKey);
    return [
      "untrusted comment: signature from minisign secret key",
      Buffer.concat([Buffer.from(alg), id, sig]).toString("base64"),
      `trusted comment: ${trusted}`,
      global.toString("base64"),
      "",
    ].join("\n");
  };
  return { pub, signMessage };
}
