/** AWS Signature Version 4, enough for S3-compatible calls (R2, MinIO, AWS, B2, Wasabi). */
import { createHash, createHmac } from "node:crypto";

export interface SignInput {
  method: string;
  url: URL;
  region: string;
  service: string;
  accessKey: string;
  secretKey: string;
  /** Header names lowercase. `host` is added from the URL. */
  headers?: Record<string, string>;
  payloadHash?: string;
  now?: Date;
}

const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data, "utf8").digest();
export const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** RFC 3986 encoding as SigV4 wants it. */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Returns the headers to send, Authorization included. */
export function signV4(input: SignInput): Record<string, string> {
  const now = input.now ?? new Date();
  const date = amzDate(now);
  const day = date.slice(0, 8);
  const headers: Record<string, string> = { ...(input.headers ?? {}), host: input.url.host, "x-amz-date": date };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...input.url.searchParams.entries()]
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const path = input.url.pathname.split("/").map((seg) => enc(decodeURIComponent(seg))).join("/") || "/";
  const payloadHash = input.payloadHash ?? sha256Hex("");
  const canonical = [input.method.toUpperCase(), path, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonical)].join("\n");
  const kDate = hmac(`AWS4${input.secretKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, input.region), input.service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign, "utf8").digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
