/**
 * installer/install.sh: rootless BuildKit on a kernel that restricts user namespaces.
 *
 * Ubuntu 24.04 sets kernel.apparmor_restrict_unprivileged_userns=1, and BuildKit's container, plain
 * apparmor=unconfined, then restarts for ever with "fork/exec /proc/self/exe: permission denied".
 * Found on a real 24.04 install (kernel 6.8): earlier 24.04 runs were nested on a 5.15 kernel with
 * AppArmor hidden. The installer loads a profile that is unconfined plus userns and names it in .env;
 * the compose file reads it, so 22.04 keeps plain unconfined.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "../../../installer/install.sh");
const UNINSTALL = path.resolve(import.meta.dirname, "../../../installer/uninstall.sh");
const COMPOSE = path.resolve(import.meta.dirname, "../../../deploy/docker-compose.yml");
const BASH = process.env.DOCKIFY_TEST_BASH ?? (process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash");
const haveBash = spawnSync(BASH, ["-c", "true"]).status === 0;
const posixPath = (p: string) => p.replace(/^([A-Za-z]):\\/, (_m, d: string) => `/${d.toLowerCase()}/`).replace(/\\/g, "/");

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(path.join(tmpdir(), "dk-aa-"));
  tmps.push(d);
  return d;
};

/** A host: the sysctl's value (null: the file does not exist), the profile folder and a fake apparmor_parser. */
function host(sysctl: string | null, parserExit = 0) {
  const d = scratch();
  const bin = path.join(d, "bin");
  mkdirSync(bin);
  const log = path.join(d, "parser.log");
  writeFileSync(path.join(bin, "apparmor_parser"), `#!/bin/sh\necho "$@" >> '${posixPath(log)}'\nexit ${parserExit}\n`, { mode: 0o755 });
  const ctl = path.join(d, "restrict_userns");
  if (sysctl !== null) writeFileSync(ctl, `${sysctl}\n`);
  return { d, bin, log, ctl, aa: path.join(d, "apparmor.d") };
}

function run(h: ReturnType<typeof host>, dry = 0) {
  const snippet = `APPARMOR_USERNS_SYSCTL='${posixPath(h.ctl)}'; APPARMOR_DIR='${posixPath(h.aa)}'; DOCKIFY_INSTALL_LIB=1 . '${posixPath(SCRIPT)}'; DRY=${dry}; buildkit_apparmor`;
  const r = spawnSync(BASH, ["-c", `PATH='${posixPath(h.bin)}':"$PATH"; ${snippet}`], { encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout.trim(), err: r.stderr };
}

describe.skipIf(!haveBash)("BuildKit's AppArmor profile", () => {
  it("loads a profile that only adds userns to unconfined where the kernel restricts user namespaces", () => {
    const h = host("1");
    const r = run(h);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe("dockify-buildkit");
    const profile = readFileSync(path.join(h.aa, "dockify-buildkit"), "utf8");
    expect(profile).toMatch(/^abi <abi\/4\.0>,$/m);
    expect(profile).toMatch(/profile dockify-buildkit flags=\(unconfined\) \{\n\s*userns,\n\}/);
    // Nothing but userns is granted on top of unconfined.
    expect(profile.split("{")[1]?.replace(/[\s}]/g, "")).toBe("userns,");
    expect(readFileSync(h.log, "utf8")).toMatch(/^-r -W .*\/apparmor\.d\/dockify-buildkit$/m);
    expect(existsSync(path.join(h.aa, "dockify-buildkit.new"))).toBe(false);
  });

  it("stays plain unconfined, and writes nothing, where the kernel has no restriction or it is off (22.04)", () => {
    for (const v of [null, "0"]) {
      const h = host(v);
      const r = run(h);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toBe("unconfined");
      expect(existsSync(h.aa)).toBe(false);
      expect(existsSync(h.log)).toBe(false);
    }
  });

  it("stops the install, naming the profile, when AppArmor refuses it", () => {
    const h = host("1", 1);
    const r = run(h);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("AppArmor refused the profile");
    expect(r.out).not.toBe("dockify-buildkit");
  });

  it("changes nothing on a dry run", () => {
    const h = host("1");
    const r = run(h, 1);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe("dockify-buildkit");
    expect(r.err).toContain("[dry-run] would load the AppArmor profile dockify-buildkit");
    expect(existsSync(h.aa)).toBe(false);
    expect(existsSync(h.log)).toBe(false);
  });
});

describe("the profile reaches the BuildKit container", () => {
  const install = readFileSync(SCRIPT, "utf8");

  it("the compose file takes the profile from .env and falls back to unconfined", () => {
    const compose = readFileSync(COMPOSE, "utf8");
    expect(compose).toContain('"apparmor=${DOCKIFY_BUILDKIT_APPARMOR:-unconfined}"');
  });

  it("a fresh install writes it to .env, and a failure stops the install", () => {
    expect(install).toMatch(/^BUILDKIT_AA="\$\(buildkit_apparmor\)"$/m);
    expect(install).toContain('echo "DOCKIFY_BUILDKIT_APPARMOR=$BUILDKIT_AA"');
  });

  it("--upgrade sets it too, before BuildKit is recreated, so a 24.04 install made earlier recovers", () => {
    const up = install.slice(install.indexOf("upgrade() {"));
    const set = up.indexOf('env_set "$DIR/.env" DOCKIFY_BUILDKIT_APPARMOR "$BUILDKIT_AA"');
    expect(up).toContain('BUILDKIT_AA="$(buildkit_apparmor)" || exit 1');
    expect(set).toBeGreaterThan(0);
    expect(set).toBeLessThan(up.indexOf("for s in buildkit api agent worker web"));
  });

  it("the uninstaller unloads and removes it", () => {
    const un = readFileSync(UNINSTALL, "utf8");
    expect(un).toContain('W_AA="$ROOT/etc/apparmor.d/dockify-buildkit"');
    expect(un).toContain('apparmor_parser -R "$W_AA"');
    expect(un).toMatch(/for f in "\$W_WRAPPER" "\$W_APT" "\$W_AA"; do/);
  });
});
