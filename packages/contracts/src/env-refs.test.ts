import { describe, expect, it } from "vitest";
import { EnvValue } from "./common.ts";
import { decodeEnvRef, encodeEnvRef, refFieldAllowed, refValue, REF_FIELDS } from "./env-refs.ts";

const ID = "11111111-1111-4111-8111-111111111111";

describe("env references", () => {
  it("round-trips a reference and reads nothing else as one", () => {
    const stored = encodeEnvRef({ resourceId: ID, field: "url" });
    expect(decodeEnvRef(stored)).toEqual({ resourceId: ID, field: "url" });
    expect(decodeEnvRef("postgres://x")).toBeNull();
    expect(decodeEnvRef(`${stored.slice(0, -3)}nope`)).toBeNull();
  });

  it("refuses a plain value that starts with the reference mark", () => {
    expect(EnvValue.safeParse(encodeEnvRef({ resourceId: ID, field: "url" })).success).toBe(false);
    expect(EnvValue.safeParse("dockify-ref:v1:anything").success).toBe(true);
  });

  it("offers each kind only its own fields, with the S3 four linked by default", () => {
    expect(refFieldAllowed("redis", "bucket")).toBe(false);
    expect(REF_FIELDS.s3.filter((f) => f.linked).map((f) => f.key)).toEqual(["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"]);
  });

  it("builds values in the shapes services expect", () => {
    const t = { kind: "s3" as const, host: "files", port: 9000, user: "dkabc", password: "s/cret" };
    expect(refValue(t, "endpoint")).toBe("http://files:9000");
    expect(refValue(t, "bucket")).toBe("files");
    expect(refValue(t, "secretKey")).toBe("s/cret");
    expect(refValue({ kind: "redis", host: "cache", port: 6379, user: "default", password: "a b" }, "url")).toBe("redis://default:a%20b@cache:6379");
  });
});
