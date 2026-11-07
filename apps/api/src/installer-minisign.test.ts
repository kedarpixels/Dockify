/**
 * installer/install.sh checks the signed release feed with openssl alone (there is no minisign
 * package on Ubuntu 22.04). The fixtures were made by the real `minisign` 0.11 on Ubuntu 24.04 with a
 * throwaway key that was not kept: a good signature, a legacy one, and a second key's public half.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parsePublicKey, verifyMinisign } from "./modules/platform/updates/minisign.ts";

const SCRIPT = path.resolve(import.meta.dirname, "../../../installer/install.sh");
const FIX = path.resolve(import.meta.dirname, "modules/platform/updates/fixtures/minisign");
const BASH = process.env.DOCKIFY_TEST_BASH ?? (process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash");
const haveBash = spawnSync(BASH, ["-c", "true"]).status === 0;
const haveOpenssl = haveBash && /^OpenSSL [3-9]/.test(spawnSync(BASH, ["-c", "openssl version"], { encoding: "utf8" }).stdout ?? "");
const posix = (p: string) => p.replace(/^([A-Za-z]):\\/, (_m, d: string) => `/${d.toLowerCase()}/`).replace(/\\/g, "/");

const COMMENT = "channel:stable version:1.2.3 generated:2026-11-07T00:00:00.000Z";
const keyLine = (f: string) => readFileSync(path.join(FIX, f), "utf8").trim().split("\n").at(-1)!.trim();
const KEY = keyLine("key.pub");
const OTHER = keyLine("other.pub");
const MANIFEST = readFileSync(path.join(FIX, "manifest.json"));
const SIG = readFileSync(path.join(FIX, "manifest.json.minisig"), "utf8");
const LEGACY = readFileSync(path.join(FIX, "manifest.json.legacy.minisig"), "utf8");

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "dk-minisign-"));
  tmps.push(d);
  return d;
}

/** Runs the installer's function in library mode, over a file and a signature given as bytes. */
function check(file: Buffer | string, sig: Buffer | string, key = KEY, prelude = ""): { code: number; out: string; err: string } {
  const d = dir();
  writeFileSync(path.join(d, "f"), file);
  writeFileSync(path.join(d, "f.minisig"), sig);
  const r = spawnSync(BASH, ["-c", `${prelude}DOCKIFY_INSTALL_LIB=1 . '${posix(SCRIPT)}'; minisign_verify '${posix(path.join(d, "f"))}' '${posix(path.join(d, "f.minisig"))}' "$1"`, "bash", key], { encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}
/** The signature file with line i replaced. */
const withLine = (i: number, text: string) => SIG.split("\n").map((l, n) => (n === i ? text : l)).join("\n");
const flipBase64 = (b64: string, at: number) => {
  const b = Buffer.from(b64, "base64");
  b[at] = b[at]! ^ 1;
  return b.toString("base64");
};

// Each case spawns real shells and openssl several times, which is slow on Windows.
describe.skipIf(!haveOpenssl)("minisign_verify, against real minisign output", { timeout: 60_000 }, () => {
  it("passes the real signature and prints the trusted comment", () => {
    const r = check(MANIFEST, SIG);
    expect(r).toEqual({ code: 0, out: `Trusted comment: ${COMMENT}\n`, err: "" });
  });

  it("agrees with the updater's own verifier on the same bytes", () => {
    expect(verifyMinisign(MANIFEST, SIG, parsePublicKey(KEY))).toEqual({ trustedComment: COMMENT, prehashed: true });
  });

  it("feeds manifest_release, which reads the version from the signed comment", () => {
    const d = dir();
    writeFileSync(path.join(d, "m.json"), MANIFEST);
    writeFileSync(path.join(d, "m.minisig"), SIG);
    const r = spawnSync(BASH, ["-c", `DOCKIFY_INSTALL_LIB=1 . '${posix(SCRIPT)}'; command -v jq >/dev/null || exit 7; OUT="$(minisign_verify m.json m.minisig '${KEY}')"; manifest_release m.json "$OUT" amd64`], { cwd: d, encoding: "utf8" });
    if (r.status === 7) return; // No jq here; it runs on the images, where the installer has installed it.
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("REL_VERSION=1.2.3");
    expect(r.stdout).toContain("REL_CONTROL=ghcr.io/example/control@sha256:");
  });

  it("takes a signature file with CRLF line endings, as minisign does", () => {
    expect(check(MANIFEST, SIG.replace(/\n/g, "\r\n")).code).toBe(0);
  });

  it("takes a whole key line with stray whitespace", () => {
    expect(check(MANIFEST, SIG, `${KEY}\n`).code).toBe(0);
  });

  it("refuses a tampered file, one bit or one byte added", () => {
    const flipped = Buffer.from(MANIFEST);
    flipped[flipped.length - 3] = flipped[flipped.length - 3]! ^ 1;
    for (const f of [flipped, Buffer.concat([MANIFEST, Buffer.from(" ")]), Buffer.alloc(0)]) {
      const r = check(f, SIG);
      expect(r.code).toBe(1);
      expect(r.out).toBe("");
      expect(r.err).toContain("does not match this file");
    }
  });

  it("refuses another key, by its id", () => {
    const r = check(MANIFEST, SIG, OTHER);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("different key");
  });

  it("refuses another key that claims this key's id: the signature itself is checked, not only the id", () => {
    const other = Buffer.from(OTHER, "base64");
    Buffer.from(KEY, "base64").copy(other, 2, 2, 10);
    const r = check(MANIFEST, SIG, other.toString("base64"));
    expect(r.code).toBe(1);
    expect(r.err).toContain("does not match this file");
  });

  it("refuses a tampered trusted comment: a new version, a new channel, or one added word", () => {
    for (const c of [COMMENT.replace("1.2.3", "9.9.9"), COMMENT.replace("stable", "beta"), `${COMMENT} x`, ""]) {
      const r = check(MANIFEST, withLine(2, `trusted comment: ${c}`));
      expect(r.code).toBe(1);
      expect(r.out).toBe("");
      expect(r.err).toContain("trusted comment was altered");
    }
  });

  it("refuses a global signature with one bit changed, and one from the legacy file", () => {
    const line3 = SIG.split("\n")[3]!;
    expect(check(MANIFEST, withLine(3, flipBase64(line3, 5))).err).toContain("trusted comment was altered");
    expect(check(MANIFEST, withLine(3, LEGACY.split("\n")[3]!)).err).toContain("trusted comment was altered");
  });

  it("refuses a file signature with one bit changed", () => {
    expect(check(MANIFEST, withLine(1, flipBase64(SIG.split("\n")[1]!, 40))).err).toContain("does not match this file");
  });

  it("refuses the legacy format, though `minisign -V` would pass this very file", () => {
    const r = check(MANIFEST, LEGACY);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("legacy format");
  });

  it("refuses an unknown algorithm, whatever else is right", () => {
    const b = Buffer.from(SIG.split("\n")[1]!, "base64");
    b.write("XX", 0, "latin1");
    expect(check(MANIFEST, withLine(1, b.toString("base64"))).err).toContain("unsupported signature algorithm");
  });

  it.each([
    ["an empty file", ""],
    ["no comment line", SIG.split("\n").slice(1).join("\n")],
    ["a missing global signature", SIG.split("\n").slice(0, 3).join("\n")],
    ["no trusted comment prefix", withLine(2, COMMENT)],
    ["a short signature", withLine(1, Buffer.alloc(40).toString("base64"))],
    ["a long signature", withLine(1, Buffer.alloc(100).toString("base64"))],
    ["not base64", withLine(1, "!!!!")],
    ["a short global signature", withLine(3, Buffer.alloc(32).toString("base64"))],
  ])("refuses a malformed signature file: %s", (_what, sig) => {
    const r = check(MANIFEST, sig);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).not.toBe("");
  });

  it.each([
    ["empty", ""],
    ["not base64", "not a key!"],
    ["the wrong length", Buffer.alloc(20).toString("base64")],
    ["not an Ed key", Buffer.concat([Buffer.from("XX"), Buffer.alloc(40)]).toString("base64")],
  ])("refuses a public key that is %s", (_what, key) => {
    const r = check(MANIFEST, SIG, key);
    expect(r.code).toBe(1);
    expect(r.err).toContain("public key");
  });

  it("leaves no temporary folder behind, pass or fail", () => {
    const d = dir();
    const run = (key: string) => spawnSync(BASH, ["-c", `export TMPDIR='${posix(d)}'; DOCKIFY_INSTALL_LIB=1 . '${posix(SCRIPT)}'; minisign_verify '${posix(path.join(FIX, "manifest.json"))}' '${posix(path.join(FIX, "manifest.json.minisig"))}' '${key}'`], { encoding: "utf8" });
    expect(run(KEY).status).toBe(0);
    expect(run(OTHER).status).toBe(1);
    mkdirSync(path.join(d, "x"));
    expect(spawnSync(BASH, ["-c", `ls -A '${posix(d)}'`], { encoding: "utf8" }).stdout.trim()).toBe("x");
  });

  it("says openssl is too old instead of calling a good signature bad", () => {
    const old = dir();
    writeFileSync(path.join(old, "openssl"), "#!/bin/sh\necho 'OpenSSL 1.1.1w  11 Sep 2023'\n", { mode: 0o755 });
    const r = check(MANIFEST, SIG, KEY, `PATH='${posix(old)}':"$PATH"; `);
    expect(r.code).toBe(1);
    expect(r.err).toContain("OpenSSL 3 or newer");
  });
});

describe.skipIf(!haveBash)("the installer takes no minisign package", { timeout: 60_000 }, () => {
  const src = () => readFileSync(SCRIPT, "utf8");
  it("never installs or runs minisign, and no longer talks of universe", () => {
    const code = src().split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/apt-get install[^\n]*minisign/);
    expect(code).not.toMatch(/(^|[^_a-z])minisign -/m);
    expect(code).not.toMatch(/universe/);
    expect(code).not.toMatch(/command -v minisign/);
  });
  it("checks the feed with the function, and names why in its error", () => {
    expect(src()).toMatch(/OUT="\$\(minisign_verify "\$TMP\/manifest\.json" "\$TMP\/manifest\.json\.minisig" "\$PUBKEY" 2> "\$TMP\/verify\.err"\)"/);
    expect(src()).toContain(`did not verify against the pinned key: $(cat "$TMP/verify.err")`);
  });
  it("installs openssl before step 7 on a fresh install, and has it on --upgrade", () => {
    expect(src()).toMatch(/apt-get install -y -qq ca-certificates curl jq openssl /);
    expect(src()).toMatch(/\{ command -v openssl && command -v jq; \} >\/dev\/null 2>&1 \|\| run apt-get install -y -qq openssl jq/);
  });
});
