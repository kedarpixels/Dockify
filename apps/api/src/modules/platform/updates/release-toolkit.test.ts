import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SignatureError } from "./minisign.ts";
import { pendingSecurity, verifyFeed } from "./release.ts";
import { testSigner } from "./test-sign.ts";
import {
  buildFeed,
  checkNotes,
  compareVersions,
  latestMigration,
  makeRelease,
  parseNotesHeading,
  resolveImages,
  run,
  serializeFeed,
  trustedComment,
  validateFeed,
  validateRelease,
  type FeedRelease,
  type Images,
  type SecurityBlock,
} from "../../../../../../scripts/release/make-manifest.mjs";

/*
 * The release toolkit (scripts/release/make-manifest.mjs) must write exactly what verifyFeed
 * accepts, and refuse what an install would refuse, at release time.
 */

const ROOT = resolve(fileURLToPath(import.meta.url), "../../../../../../..");
const hex = (c: string) => c.repeat(64);
const images = (c = "a"): Images => ({
  control: { amd64: `ghcr.io/acme/dockify-control@sha256:${hex(c)}`, arm64: `ghcr.io/acme/dockify-control@sha256:${hex("b")}` },
  web: { amd64: `ghcr.io/acme/dockify-web@sha256:${hex("c")}`, arm64: `ghcr.io/acme/dockify-web@sha256:${hex("d")}` },
});
const notesFor = (v: string, date: string) => `## ${v} (${date})\n\nWhat this release is for.\n\n### Fixed\n- A thing.\n`;
const release = (version: string, over: Partial<Parameters<typeof makeRelease>[0]> = {}): FeedRelease =>
  makeRelease({
    version,
    date: "2026-11-03",
    publishedAt: "2026-11-03T10:00:00.000Z",
    minFrom: "0.0.0",
    migration: "0001_init",
    notesUrl: `https://github.com/acme/dockify/releases/tag/v${version}`,
    notes: notesFor(version, "2026-11-03"),
    images: images(),
    composeSha256: hex("e"),
    socketProxySha256: hex("f"),
    ...over,
  });
const sign = (feed: Parameters<typeof serializeFeed>[0]) => {
  const s = testSigner();
  const bytes = Buffer.from(serializeFeed(feed));
  return { s, bytes, sig: s.signMessage(bytes, trustedComment(feed)) };
};

const tmp = mkdtempSync(join(tmpdir(), "dockify-release-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("make-manifest builds a feed verifyFeed accepts", () => {
  it("signs a first stable release and verifies it", () => {
    const feed = buildFeed({ channel: "stable", release: release("1.0.0"), generatedAt: "2026-11-03T10:00:01.000Z" });
    const { s, bytes, sig } = sign(feed);
    expect(trustedComment(feed)).toBe("channel:stable version:1.0.0 generated:2026-11-03T10:00:01.000Z");
    const v = verifyFeed(bytes, sig, s.pub, "stable");
    expect(v.releases.map((r) => r.version)).toEqual(["1.0.0"]);
    expect(() => verifyFeed(bytes, sig, s.pub, "beta")).toThrow(SignatureError);
  });

  it("carries previous entries over, newest first, with a prerelease before its release", () => {
    const b1 = buildFeed({ channel: "beta", release: release("1.0.0"), generatedAt: "2026-11-03T10:00:00Z" });
    const b2 = buildFeed({ channel: "beta", release: release("1.1.0-beta.1", { minFrom: "1.0.0" }), previous: b1, generatedAt: "2026-11-04T10:00:00Z" });
    const b3 = buildFeed({ channel: "beta", release: release("1.1.0", { minFrom: "1.0.0" }), previous: b2, generatedAt: "2026-11-05T10:00:00Z" });
    expect(b3.releases.map((r) => r.version)).toEqual(["1.1.0", "1.1.0-beta.1", "1.0.0"]);
    expect(compareVersions("1.1.0-beta.1", "1.1.0")).toBeLessThan(0);
    const { s, bytes, sig } = sign(b3);
    expect(verifyFeed(bytes, sig, s.pub, "beta").releases).toHaveLength(3);
  });

  it("runs end to end from the command line arguments against this repository", () => {
    const notes = join(tmp, "1.2.0.md");
    writeFileSync(notes, notesFor("1.2.0", "2026-11-03"));
    const digests = join(tmp, "digests.json");
    writeFileSync(digests, JSON.stringify(images()));
    const out = join(tmp, "stable.json");
    const res = run(
      ["--channel", "stable", "--version", "v1.2.0", "--date", "2026-11-03", "--out", out, "--digests", digests, "--notes", notes, "--notes-url", "https://github.com/acme/dockify/releases/tag/v1.2.0", "--repo-root", ROOT, "--critical"],
      { now: new Date("2026-11-03T12:00:00Z"), env: {} },
    );
    expect(res.comment).toBe("channel:stable version:1.2.0 generated:2026-11-03T12:00:00.000Z");
    const bytes = readFileSync(out);
    expect(bytes.toString("utf8").endsWith("}\n")).toBe(true);
    const s = testSigner();
    const v = verifyFeed(bytes, s.signMessage(bytes, res.comment!), s.pub, "stable");
    const top = v.releases[0]!;
    expect(top).toMatchObject({ version: "1.2.0", critical: true, minFrom: "0.0.0", migration: latestMigration(ROOT) });
    expect(top.composeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(top.socketProxySha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("make-manifest marks a security release", () => {
  const block: SecurityBlock = { level: "critical", summary: "A crafted request could read files outside the log folder.", advisory: "https://github.com/acme/dockify/security/advisories/GHSA-abcd-efgh-ijkl", cves: ["CVE-2026-0000"] };

  it("writes the block into the signed bytes and makes the release critical, as installs read it", () => {
    const r = release("1.2.1", { security: block });
    expect(r.critical).toBe(true);
    expect(Object.keys(r).at(-1)).toBe("security");
    const feed = buildFeed({ channel: "stable", release: r, previous: buildFeed({ channel: "stable", release: release("1.2.0"), generatedAt: "2026-11-02T10:00:00Z" }), generatedAt: "2026-11-03T10:00:01Z" });
    const { s, bytes, sig } = sign(feed);
    const v = verifyFeed(bytes, sig, s.pub, "stable");
    expect(v.releases[0]!.security).toEqual(block);
    expect(pendingSecurity(v, "1.2.0")).toMatchObject({ version: "1.2.1", level: "critical", cves: ["CVE-2026-0000"] });
  });

  it("reads docs/releases/security/<version>.json beside the notes, or --security", () => {
    // A small repository root: the files run() reads, and the release's own security block.
    const repo = join(tmp, "repo");
    for (const d of ["packages/db/prisma/migrations/0001_init", "deploy/socket-proxy", "docs/releases/security"]) mkdirSync(join(repo, d), { recursive: true });
    writeFileSync(join(repo, "deploy/docker-compose.yml"), "services: {}\n");
    writeFileSync(join(repo, "deploy/socket-proxy/haproxy.cfg"), "global\n");
    writeFileSync(join(repo, "docs/releases/1.3.0.md"), notesFor("1.3.0", "2026-11-03"));
    writeFileSync(join(repo, "docs/releases/security/1.3.0.json"), JSON.stringify({ ...block, level: "important" }));
    writeFileSync(join(tmp, "digests-sec.json"), JSON.stringify(images()));
    const args = ["--channel", "stable", "--version", "1.3.0", "--date", "2026-11-03", "--digests", join(tmp, "digests-sec.json"), "--notes-url", "https://github.com/acme/dockify/releases/tag/v1.3.0", "--repo-root", repo];
    const res = run([...args, "--out", join(tmp, "sec-default.json")], { now: new Date("2026-11-03T12:00:00Z"), env: {} });
    expect(res.feed?.releases[0]).toMatchObject({ version: "1.3.0", critical: true, security: { level: "important", cves: ["CVE-2026-0000"] } });
    const other = join(tmp, "other-block.json");
    writeFileSync(other, JSON.stringify({ level: "critical", summary: "Another fix." }));
    expect(run([...args, "--out", join(tmp, "sec-flag.json"), "--security", other], { now: new Date("2026-11-03T12:00:00Z"), env: {} }).feed?.releases[0]?.security).toEqual({ level: "critical", summary: "Another fix." });
    expect(() => run([...args, "--out", join(tmp, "x.json"), "--security", join(tmp, "missing.json")], { env: {} })).toThrow(/no security block/);
    // No file and no flag: an ordinary release.
    rmSync(join(repo, "docs/releases/security/1.3.0.json"));
    expect(run([...args, "--out", join(tmp, "plain.json")], { now: new Date("2026-11-03T12:00:00Z"), env: {} }).feed?.releases[0]).toMatchObject({ critical: false });
  });

  it("refuses a block an install could not show as written", () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...block, level: "low" }, /level/],
      [{ ...block, summary: " " }, /summary/],
      [{ ...block, summary: "Line one\nline two" }, /one line/],
      [{ ...block, summary: " padded" }, /leading or trailing/],
      [{ ...block, summary: "x".repeat(601) }, /limit is 600/],
      [{ ...block, advisory: "http://example.com/a" }, /not https/],
      [{ ...block, cves: [] }, /cves/],
      [{ ...block, cves: ["CVE-2026-1"] }, /not a CVE id/],
      [{ ...block, cves: ["CVE-2026-0000", "CVE-2026-0000"] }, /twice/],
      [{ ...block, cvss: 9.8 }, /unknown key "cvss"/],
      [{ summary: "No level." }, /missing "level"/],
    ];
    for (const [security, why] of bad) expect(() => release("1.2.1", { security: security as unknown as SecurityBlock }), JSON.stringify(security)).toThrow(why);
    // A hand-made entry with a block must still be critical.
    expect(() => validateRelease({ ...release("1.2.1"), security: block })).toThrow(/critical must be true/);
  });
});

describe("make-manifest refuses a bad release", () => {
  it("refuses a tag instead of a digest", () => {
    const bad = images();
    bad.web.arm64 = "ghcr.io/acme/dockify-web:1.0.0";
    expect(() => release("1.0.0", { images: bad })).toThrow(/tag, not a digest/);
    bad.web.arm64 = `ghcr.io/acme/dockify-web:1.0.0@sha256:${hex("d")}`;
    expect(() => release("1.0.0", { images: bad })).toThrow(/digest/);
    expect(() => resolveImages({ "control-amd64": "x", "control-arm64": "y", "web-amd64": "z", "web-arm64": "w" }, () => ({}))).toThrow(/tag, not a digest/);
  });

  it("refuses a version already in the feed unless replace", () => {
    const f1 = buildFeed({ channel: "stable", release: release("1.0.0"), generatedAt: "2026-11-03T10:00:00Z" });
    expect(() => buildFeed({ channel: "stable", release: release("1.0.0"), previous: f1, generatedAt: "2026-11-04T10:00:00Z" })).toThrow(/already in the stable feed/);
    const replaced = buildFeed({ channel: "stable", release: release("1.0.0", { critical: true }), previous: f1, generatedAt: "2026-11-04T10:00:00Z", replace: true });
    expect(replaced.releases).toHaveLength(1);
    expect(replaced.releases[0]!.critical).toBe(true);
    expect(() => validateFeed({ ...f1, releases: [f1.releases[0], f1.releases[0]] })).toThrow(/listed twice/);
  });

  it("refuses unreleased notes and a heading that disagrees with the release", () => {
    expect(parseNotesHeading("## 1.0.0 (unreleased)\n")).toEqual({ version: "1.0.0", date: null, unreleased: true });
    expect(() => checkNotes("## 1.0.0 (unreleased)\n\nx\n", "1.0.0", "2026-11-03")).toThrow(/unreleased/);
    expect(() => checkNotes(notesFor("1.0.1", "2026-11-03"), "1.0.0", "2026-11-03")).toThrow(/names 1.0.1/);
    expect(() => checkNotes(notesFor("1.0.0", "2026-11-02"), "1.0.0", "2026-11-03")).toThrow(/dated 2026-11-02/);
    expect(() => checkNotes("# 1.0.0\n", "1.0.0", "2026-11-03")).toThrow(/must start with/);
    expect(checkNotes(notesFor("1.0.0", "2026-11-03"), "v1.0.0", "2026-11-03")).toContain("### Fixed");
  });

  it("keeps the committed 1.0.0 notes unpublishable until they are dated", () => {
    const text = readFileSync(join(ROOT, "docs", "releases", "1.0.0.md"), "utf8");
    expect(parseNotesHeading(text)).toMatchObject({ version: "1.0.0", unreleased: true });
  });

  it("keeps a prerelease out of stable", () => {
    expect(() => buildFeed({ channel: "stable", release: release("1.1.0-rc.1"), generatedAt: "2026-11-03T10:00:00Z" })).toThrow(/beta channel only/);
    const notes = join(tmp, "1.1.0-beta.1.md");
    writeFileSync(notes, notesFor("1.1.0-beta.1", "2026-11-03"));
    expect(() =>
      run(["--channel", "stable", "--version", "1.1.0-beta.1", "--date", "2026-11-03", "--out", join(tmp, "x.json"), "--notes", notes, "--notes-url", "https://example.com/r", "--repo-root", ROOT], { env: {} }),
    ).toThrow(/beta channel only/);
  });

  it("refuses a replayed timestamp, another channel's file and an http notes link", () => {
    const f1 = buildFeed({ channel: "beta", release: release("1.0.0"), generatedAt: "2026-11-03T10:00:00Z" });
    expect(() => buildFeed({ channel: "beta", release: release("1.0.1"), previous: f1, generatedAt: "2026-11-03T10:00:00Z" })).toThrow(/not later/);
    expect(() => buildFeed({ channel: "stable", release: release("1.0.1"), previous: f1, generatedAt: "2026-11-04T10:00:00Z" })).toThrow(/beta channel, not stable/);
    expect(() => release("1.0.0", { notesUrl: "http://example.com/r" })).toThrow(/not https/);
    expect(() => validateFeed({ ...f1, extra: 1 })).toThrow(/unknown key/);
  });
});
