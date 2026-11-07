import { packContext } from "@dockify/engine";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextTarError, unpackContext } from "./context-tar-guard.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dk-ctx-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const LIMIT = { maxBytes: 1024 * 1024 * 1024 };
const canLink = process.platform !== "win32";

/** One hand-written entry, for what the packer would never write. */
function rawEntry(name: string, type: string, body: Buffer = Buffer.alloc(0), link = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write("0000644\0", 100, "latin1");
  h.write("0000000\0", 108, "latin1");
  h.write("0000000\0", 116, "latin1");
  h.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  h.write("00000000000\0", 136, "latin1");
  h.write("        ", 148, "latin1");
  h.write(type, 156, "latin1");
  h.write(link, 157, 100);
  h.write("ustar\u000000", 257, "latin1");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return Buffer.concat([h, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
const archive = (...parts: Buffer[]) => (async function* () {
  yield Buffer.concat([...parts, Buffer.alloc(1024)]);
})();

describe("a context through the packer and the guard", () => {
  it("arrives whole: files, modes, folders, long names and .git", async () => {
    const src = join(dir, "src");
    const long = "a".repeat(120);
    await mkdir(join(src, "repo", ".git", "objects"), { recursive: true });
    await mkdir(join(src, "repo", long), { recursive: true });
    await mkdir(join(src, "repo", "empty"));
    await writeFile(join(src, "repo", ".git", "HEAD"), "ref\n");
    await writeFile(join(src, "repo", long, `${long}.txt`), "deep");
    await writeFile(join(src, "repo", "big.bin"), Buffer.alloc(3 * 1024 * 1024 + 7, 0x41));
    await writeFile(join(src, "repo", "run.sh"), "#!/bin/sh\n");
    await chmod(join(src, "repo", "run.sh"), 0o755);
    const out = join(dir, "out");
    const summary = await unpackContext(packContext(src), out, LIMIT);
    expect(summary.files).toBe(4);
    expect(await readFile(join(out, "repo", ".git", "HEAD"), "utf8")).toBe("ref\n");
    expect(await readFile(join(out, "repo", long, `${long}.txt`), "utf8")).toBe("deep");
    expect((await stat(join(out, "repo", "big.bin"))).size).toBe(3 * 1024 * 1024 + 7);
    expect((await readdir(join(out, "repo", "empty"))).length).toBe(0);
    if (canLink) expect((await stat(join(out, "repo", "run.sh"))).mode & 0o777).toBe(0o755);
  });

  it("a system tar reads what the packer writes", async () => {
    let tar = true;
    try {
      execFileSync("tar", ["--version"], { stdio: "ignore" });
    } catch {
      tar = false;
    }
    if (!tar) return;
    const src = join(dir, "s");
    await mkdir(join(src, "x"), { recursive: true });
    await writeFile(join(src, "x", "f.txt"), "hello");
    const chunks: Buffer[] = [];
    for await (const c of packContext(src)) chunks.push(c as Buffer);
    await writeFile(join(dir, "a.tar"), Buffer.concat(chunks));
    const listing = execFileSync("tar", ["-tf", "a.tar"], { cwd: dir, encoding: "utf8" });
    expect(listing).toContain("x/f.txt");
  });

  it.skipIf(!canLink)("keeps a symlink as a link, even one pointing out of the folder", async () => {
    const src = join(dir, "src");
    await mkdir(src);
    await writeFile(join(src, "real"), "x");
    await symlink("real", join(src, "near"));
    await symlink("/etc/passwd", join(src, "far"));
    const out = join(dir, "out");
    await unpackContext(packContext(src), out, LIMIT);
    expect((await lstat(join(out, "far"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(out, "far"))).toBe("/etc/passwd");
    expect(await readlink(join(out, "near"))).toBe("real");
  });
});

describe("a hostile context", () => {
  const out = () => join(dir, "out");
  it.each<[string, () => Buffer[]]>([
    ["an absolute path", () => [rawEntry("/etc/passwd", "0", Buffer.from("x"))]],
    ["a parent path", () => [rawEntry("../escape", "0", Buffer.from("x"))]],
    ["a parent path deep inside", () => [rawEntry("a/b/../../../escape", "0", Buffer.from("x"))]],
    ["a backslash", () => [rawEntry("a\\..\\b", "0", Buffer.from("x"))]],
    ["a hard link", () => [rawEntry("h", "1", Buffer.alloc(0), "/etc/shadow")]],
    ["a character device", () => [rawEntry("d", "3")]],
    ["a block device", () => [rawEntry("d", "4")]],
    ["a FIFO", () => [rawEntry("p", "6")]],
    ["a GNU long name", () => [rawEntry("././@LongLink", "L", Buffer.from("/etc/passwd"))]],
  ])("refuses %s", async (_label, make) => {
    await expect(unpackContext(archive(...make()), out(), LIMIT)).rejects.toBeInstanceOf(ContextTarError);
  });

  it("refuses a pax path that leaves the folder, whatever the header's own name says", async () => {
    const rec = "27 path=../../etc/cron.d/x\n";
    await expect(unpackContext(archive(rawEntry("pax", "x", Buffer.from(rec)), rawEntry("fine", "0", Buffer.from("x"))), out(), LIMIT)).rejects.toThrow(/leaves the folder|malformed/);
  });

  it.skipIf(!canLink)("refuses anything beneath a link, so nothing is written through one", async () => {
    const parts = [rawEntry("up", "2", Buffer.alloc(0), "/tmp"), rawEntry("up/owned", "0", Buffer.from("x"))];
    await expect(unpackContext(archive(...parts), out(), LIMIT)).rejects.toThrow(/beneath a link/);
  });

  it("refuses writing a file over one already there", async () => {
    const parts = [rawEntry("a", "0", Buffer.from("1")), rawEntry("a", "0", Buffer.from("2"))];
    await expect(unpackContext(archive(...parts), out(), LIMIT)).rejects.toThrow();
  });

  it("refuses a bad checksum, a truncated archive, and more than the limit", async () => {
    const bad = rawEntry("a", "0", Buffer.from("1"));
    bad[0] = 0x62;
    await expect(unpackContext(archive(bad), out(), LIMIT)).rejects.toThrow(/checksum/);
    const whole = rawEntry("b", "0", Buffer.alloc(1000));
    await expect(unpackContext((async function* () { yield whole.subarray(0, 600); })(), join(dir, "o2"), LIMIT)).rejects.toThrow(/truncated/);
    await expect(unpackContext((async function* () { yield rawEntry("c", "0", Buffer.from("x")); })(), join(dir, "o3"), LIMIT)).rejects.toThrow(/truncated/);
    await expect(unpackContext(archive(rawEntry("d", "0", Buffer.alloc(100))), join(dir, "o4"), { maxBytes: 10 })).rejects.toThrow(/larger than/);
  });

  it("strips setuid from a mode", async () => {
    const h = rawEntry("s", "0", Buffer.from("x"));
    h.write("0004755\0", 100, "latin1");
    h.write("        ", 148, "latin1");
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += h[i]!;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    await unpackContext(archive(h), out(), LIMIT);
    expect((await stat(join(out(), "s"))).mode & 0o7000).toBe(0);
  });
});
