/**
 * `sudo dockify admin factory-reset`, the only way to erase a server. Runs the real rendered wrapper
 * in a sandbox with a fake docker that logs every call. Only four things change for the sandbox: the
 * root check, the terminal check, the /root path of the copy and its mode, all pinned by a test too.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { endpointIds } from "@dockify/contracts";

const SCRIPT = path.resolve(import.meta.dirname, "../../../installer/install.sh");
const BASH = process.env.DOCKIFY_TEST_BASH ?? (process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash");
const haveBash = spawnSync(BASH, ["-c", "true"]).status === 0;
const posix = (p: string) => p.replace(/^([A-Za-z]):\\/, (_m, d: string) => `/${d.toLowerCase()}/`).replace(/\\/g, "/");
const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const FAKE_DOCKER = `#!/bin/sh
echo "docker $*" >> "$DK_LOG"
case "$*" in
  "ps -aq --filter label=dockify.managed=true") echo c-tenant-1; echo c-tenant-2 ;;
  "volume ls -q --filter label=dockify.managed=true") echo v-tenant ;;
  "volume ls -q --filter label=dockify.app") echo v-app ;;
  "network ls -q --filter label=dockify.environment") echo n-env ;;
  "network inspect -f {{range .Containers}}{{.Name}} {{end}} n-env") echo "dockify-proxy " ;;
esac
case "$*" in *"exec -T postgres"*) [ -z "$DK_PG_FAIL" ] || exit 3 ;; esac
exit 0
`;

function box() {
  const root = mkdtempSync(path.join(tmpdir(), "dk-reset-"));
  tmps.push(root);
  const dir = path.join(root, "install");
  const bin = path.join(root, "bin");
  const backups = path.join(root, "root");
  const log = path.join(root, "log");
  for (const d of [dir, path.join(dir, "secrets"), path.join(dir, "release"), path.join(dir, "proxy/conf"), bin, backups]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(dir, "docker-compose.yml"), "services: {}\n");
  writeFileSync(path.join(dir, ".env"), "DOCKIFY_PUBLIC_URL=https://dash.example.com\n");
  writeFileSync(path.join(dir, "secrets/setup_token"), "old-token");
  writeFileSync(path.join(dir, "secrets/master_key"), "mk");
  writeFileSync(path.join(dir, "proxy/conf/app.yml"), "x");
  const digest = "a".repeat(64);
  writeFileSync(path.join(dir, "release/release.env"), `DOCKIFY_CONTROL_IMAGE=a/b@sha256:${digest}\nDOCKIFY_WEB_IMAGE=a/c@sha256:${digest}\n`);
  writeFileSync(path.join(bin, "docker"), FAKE_DOCKER);
  chmodSync(path.join(bin, "docker"), 0o755);
  writeFileSync(log, "");
  const uid = spawnSync(BASH, ["-c", "id -u"], { encoding: "utf8" }).stdout.trim();
  const rendered = spawnSync(BASH, ["-c", `DOCKIFY_INSTALL_LIB=1 . '${posix(SCRIPT)}'; render_wrapper '${posix(dir)}' ${uid}`], { encoding: "utf8" }).stdout;
  const wrapper = path.join(root, "dockify");
  // No root here, no terminal in a test, /root is not ours, and Git Bash on Windows cannot set a mode.
  const patched = rendered
    .replace(`[ "$(id -u)" = 0 ] || fail "run it as root: sudo dockify admin factory-reset"`, ":")
    .replace(`[ -t 0 ] || fail "this asks you to type a confirmation, so it needs a terminal"`, ":")
    .replace(`B="/root/dockify-backup-`, `B="${posix(backups)}/dockify-backup-`)
    .replace(`mkdir -m 0700 "$B"`, `mkdir "$B"`);
  writeFileSync(wrapper, patched);
  const run = (args: string, input: string, env: NodeJS.ProcessEnv = {}) => {
    const r = spawnSync(BASH, [posix(wrapper), ...args.split(" ")], {
      encoding: "utf8", input, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, DK_LOG: log, ...env },
    });
    return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
  };
  return { dir, backups, run, log: () => readFileSync(log, "utf8"), rendered };
}

// Each case spawns a real shell several times, which is slow on Windows.
describe.skipIf(!haveBash)("dockify admin factory-reset", { timeout: 60_000 }, () => {
  it("guards itself with root and a terminal in the real wrapper, ahead of the branch into the api", () => {
    const w = box().rendered;
    const branch = w.indexOf("= factory-reset ]");
    expect(branch).toBeGreaterThan(0);
    expect(branch).toBeLessThan(w.indexOf('exec api dockify-entrypoint admin "$@"'));
    expect(w).toContain(`[ "$(id -u)" = 0 ] || fail "run it as root`);
    expect(w).toContain(`[ -t 0 ] || fail "this asks you to type`);
    expect(w).toContain(`B="/root/dockify-backup-`);
    expect(w).toContain(`mkdir -m 0700 "$B"`);
  });

  it("no web route can reach it: the contract has no reset endpoint", () => {
    expect(endpointIds).not.toContain("settings.reset");
    expect(endpointIds.filter((id) => /factory|settings\.reset/i.test(id))).toEqual([]);
  });

  it("a wrong or empty answer changes nothing", () => {
    for (const answer of ["", "yes\n", "DASH.EXAMPLE.COM\n", "dash.example.com \n"]) {
      const b = box();
      const r = b.run("admin factory-reset", answer);
      expect(r.code, answer).toBe(1);
      expect(r.err).toContain("nothing was changed");
      expect(b.log()).not.toMatch(/ rm | volume rm| network rm|DROP/);
      expect(readdirSync(b.backups)).toEqual([]);
      expect(readFileSync(path.join(b.dir, "secrets/setup_token"), "utf8")).toBe("old-token");
    }
  });

  it("refuses stray arguments before asking anything", () => {
    const b = box();
    expect(b.run("admin factory-reset --yes", "dash.example.com\n").code).toBe(1);
    expect(b.run("admin factory-reset --delete-backups extra", "dash.example.com\n").code).toBe(1);
    expect(b.log()).not.toMatch(/ rm /);
  });

  it("copies the secrets first, stops the control plane before erasing, and rotates the setup token", () => {
    const b = box();
    const r = b.run("admin factory-reset", "dash.example.com\n");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const [copy] = readdirSync(b.backups);
    expect(copy).toMatch(/^dockify-backup-/);
    expect(readFileSync(path.join(b.backups, copy!, "secrets/master_key"), "utf8")).toBe("mk");
    expect(readFileSync(path.join(b.backups, copy!, "secrets/setup_token"), "utf8")).toBe("old-token");
    const log = b.log();
    const at = (s: string) => { const i = log.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    expect(at("rm -fs web api worker agent updater")).toBeLessThan(at("rm -fv c-tenant-1"));
    expect(at("rm -fv c-tenant-2")).toBeLessThan(at("volume rm -f v-tenant"));
    expect(at("volume rm -f v-app")).toBeLessThan(at("DROP DATABASE IF EXISTS dockify WITH (FORCE)"));
    expect(at("CREATE DATABASE dockify")).toBeLessThan(at("run --rm --no-deps migrate"));
    expect(at("run --rm --no-deps migrate")).toBeLessThan(at("up -d --no-deps --wait api"));
    // The backups volume and the control plane's own volumes are named nowhere.
    expect(log).not.toContain("dockify-backups");
    expect(log).not.toContain("dockify-db");
    expect(log).not.toContain("dockify-acme");
    const token = readFileSync(path.join(b.dir, "secrets/setup_token"), "utf8");
    expect(token).not.toBe("old-token");
    expect(token.trim()).toMatch(/^[\w-]{40,}$/);
    expect(r.out).toContain(token.trim());
    expect(existsSync(path.join(b.dir, "secrets/master_key"))).toBe(true);
    expect(existsSync(path.join(b.dir, "proxy/conf/app.yml"))).toBe(false);
  });

  it("takes the proxy off an environment's network before removing it, or Docker keeps the network", () => {
    const b = box();
    const r = b.run("admin factory-reset", "dash.example.com\n");
    expect(r.code).toBe(0);
    const log = b.log().split("\n");
    const off = log.indexOf("docker network disconnect -f n-env dockify-proxy");
    const rm = log.indexOf("docker network rm n-env");
    expect(off).toBeGreaterThan(-1);
    expect(rm).toBeGreaterThan(off);
  });

  it("removes the local backups only when asked by the flag", () => {
    const b = box();
    expect(b.run("admin factory-reset --delete-backups", "dash.example.com\n").code).toBe(0);
    expect(b.log()).toContain("volume rm -f dockify_dockify-backups");
  });

  it("stops and says so when the control database cannot be reset, keeping the copy", () => {
    const b = box();
    const r = b.run("admin factory-reset", "dash.example.com\n", { DK_PG_FAIL: "1" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("could not reset the control database");
    expect(readdirSync(b.backups)).toHaveLength(1);
    expect(b.log()).not.toContain("migrate");
  });
});
