/**
 * installer/install.sh: the container firewall, the retried `up --wait` and the
 * migrate-first redeploy, the env rewrite and the --upgrade flow (one-time fixes for
 * installs made before this version). Helpers run in library mode
 * (DOCKIFY_INSTALL_LIB=1 stops the script before it touches anything); the flow is checked as text,
 * since it drives Docker and systemd.
 */
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "../../../installer/install.sh");
const UNINSTALL = path.resolve(import.meta.dirname, "../../../installer/uninstall.sh");
const BASH = process.env.DOCKIFY_TEST_BASH ?? (process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash");
const haveBash = spawnSync(BASH, ["-c", "true"]).status === 0;
const posixPath = (p: string) => p.replace(/^([A-Za-z]):\\/, (_m, d: string) => `/${d.toLowerCase()}/`).replace(/\\/g, "/");
const DIGEST = (c: string) => `@sha256:${c.repeat(64)}`;

function lib(snippet: string, opts: { input?: string; path?: string } = {}): { code: number; out: string; err: string } {
  const pre = opts.path ? `PATH='${posixPath(opts.path)}':"$PATH"; ` : "";
  const r = spawnSync(BASH, ["-c", `${pre}DOCKIFY_INSTALL_LIB=1 . '${posixPath(SCRIPT)}'; ${snippet}`], { encoding: "utf8", input: opts.input });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(path.join(tmpdir(), "dk-inst-"));
  tmps.push(d);
  return d;
};
const src = () => readFileSync(SCRIPT, "utf8");

describe.skipIf(!haveBash)("the server's public address", () => {
  const isPublic = (ip: string) => lib(`is_public_ipv4 ${ip}`).code === 0;
  it("takes 220.x to 223.x, ordinary unicast addresses common in Asia", () => {
    for (const ip of ["220.0.0.1", "221.1.2.3", "222.100.1.1", "223.255.255.254", "8.8.8.8", "199.1.1.1"]) expect(isPublic(ip), ip).toBe(true);
  });
  it("still refuses multicast, reserved, private and loopback", () => {
    for (const ip of ["224.0.0.1", "229.1.1.1", "239.255.0.1", "240.0.0.1", "255.255.255.255", "10.0.0.1", "127.0.0.1", "192.168.1.1", "172.16.0.1", "100.64.0.1", "169.254.1.1", "nope"]) expect(isPublic(ip), ip).toBe(false);
  });
});

describe.skipIf(!haveBash)("--upgrade holds the feed's release to the updater's rules", () => {
  const refusal = (from: string, to: string, min = "") => lib(`upgrade_refusal '${from}' '${to}' '${min}'`).out;

  it("refuses a downgrade, by version and not by text", () => {
    expect(refusal("1.10.0", "1.9.0")).toMatch(/Refusing a downgrade: this server runs 1\.10\.0 and the signed feed offers 1\.9\.0/);
    expect(refusal("1.2.0", "1.2.0-rc1")).toMatch(/Refusing a downgrade/);
    expect(refusal("1.2.0-rc2", "1.2.0-rc1")).toMatch(/Refusing a downgrade/);
  });
  it("refuses a release whose minFrom is above what runs, and names the step", () => {
    expect(refusal("1.0.0", "2.0.0", "1.8.0")).toContain("2.0.0 upgrades only from 1.8.0 or newer, and this server runs 1.0.0. Install 1.8.0 first");
  });
  it("lets the normal moves through, the same version too, since --upgrade also refreshes the files", () => {
    expect(refusal("1.0.0", "1.1.0")).toBe("");
    expect(refusal("1.1.0", "1.1.0")).toBe("");
    expect(refusal("1.2.0-rc1", "1.2.0")).toBe("");
    expect(refusal("1.8.0", "2.0.0", "1.8.0")).toBe("");
    expect(refusal("1.9.0", "1.10.0", "1.9.0")).toBe("");
  });
  it("cannot compare an unknown or development version, and does not guess", () => {
    expect(refusal("", "1.0.0", "0.9.0")).toBe("");
    expect(refusal("0.0.0-dev", "1.0.0", "0.9.0")).toBe("");
  });
  it("checks before it changes anything, reads what really runs, and leaves explicit images alone", () => {
    const s = src();
    const up = s.slice(s.indexOf("upgrade() {"), s.indexOf('if [ "${DOCKIFY_INSTALL_LIB:-}" = 1 ]'));
    expect(up.indexOf('WHY="$(upgrade_refusal "$RUNNING"')).toBeGreaterThan(up.indexOf("resolve_release"));
    expect(up.indexOf('WHY="$(upgrade_refusal "$RUNNING"')).toBeLessThan(up.indexOf("fetch_stack_files"));
    expect(up).toContain(`SELECT "releaseVersion" FROM instance`);
    expect(up.indexOf('if [ "$EXPLICIT_IMAGES" = 1 ]; then')).toBeLessThan(up.indexOf("upgrade_refusal"));
  });
  it("records the version once migrate passed, so the dashboard stops offering what already runs", () => {
    const s = src();
    expect(s.indexOf('record_release_version "$VERSION"')).toBeGreaterThan(s.indexOf('dockify run --rm --no-deps migrate || { restore_files; die "migrations failed'));
    expect(s).toContain(`UPDATE instance SET \\"releaseVersion\\" = '$1' WHERE id = 1`);
  });
});

describe.skipIf(!haveBash)("installing over data an earlier install kept", () => {
  const fakeDocker = (dir: string, code: number) => {
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "docker"), `#!/bin/sh\necho "$*" >> '${posixPath(dir)}/log'\nexit ${code}\n`, { mode: 0o755 });
    return bin;
  };
  const backup = (root: string, name: string, files: string[]) => {
    const d = path.join(root, name, "secrets");
    mkdirSync(d, { recursive: true });
    for (const f of files) writeFileSync(path.join(d, f), "x");
  };

  it("finds the kept database volume by its exact name", () => {
    const d = scratch();
    expect(lib("kept_database_volume", { path: fakeDocker(d, 0) }).code).toBe(0);
    expect(readFileSync(path.join(d, "log"), "utf8")).toContain("volume inspect dockify_dockify-db");
    const none = scratch();
    expect(lib("kept_database_volume", { path: fakeDocker(none, 1) }).code).not.toBe(0);
  });
  it("takes the newest backup that holds both the password and the master key", () => {
    const d = scratch();
    backup(d, "dockify-backup-20260101T000000Z", ["postgres_password", "master_key"]);
    backup(d, "dockify-backup-20260201T000000Z", ["postgres_password", "master_key"]);
    backup(d, "dockify-backup-20260301T000000Z", ["postgres_password"]);
    expect(lib(`kept_data_backup '${posixPath(d)}'`).out).toMatch(/dockify-backup-20260201T000000Z$/);
    expect(lib(`kept_data_backup '${posixPath(scratch())}'`).out).toBe("");
  });
  it("decides before it asks anything, and never removes the volume", () => {
    const s = src();
    expect(s.indexOf("if kept_database_volume; then")).toBeLessThan(s.indexOf('ask_tty "Dashboard domain'));
    expect(s).not.toMatch(/volume rm[^\n]*dockify_dockify-db/);
    const no = s.slice(s.indexOf('REUSE_FROM="$(kept_data_backup /root)"'), s.indexOf("# The dashboard's address. None given"));
    expect(no).toMatch(/die "the volume dockify_dockify-db holds an earlier install's database, and no .*Nothing was changed/);
    expect(no).toContain("--purge");
  });
  it("uses the kept secrets, never new ones, and sends the owner to sign in rather than to setup", () => {
    const s = src();
    const copy = s.indexOf('cp -pR "$REUSE_FROM/secrets/." "$DIR/secrets/"');
    expect(copy).toBeGreaterThan(0);
    for (const f of ["master_key", "postgres_password", "setup_token", "internal_token"]) {
      const line = s.search(new RegExp(`\\[ -s "\\$DIR/secrets/${f}" \\] \\|\\| `));
      expect(line, f).toBeGreaterThan(copy);
    }
    expect(s).not.toMatch(/^openssl rand -hex 24 \| tr -d '\\n' > "\$DIR\/secrets\/postgres_password"/m);
    expect(s).toContain("Your accounts and projects are as the earlier install left them");
    expect(s).toContain('record_release_version "${REUSE_FROM:+$VERSION}"');
  });
  it("an install on kept data says the apps are not running and what to do, in one block", () => {
    const direct = lib("kept_data_apps_step direct");
    expect(direct.code).toBe(0);
    expect(direct.out).toContain("YOUR APPS ARE NOT RUNNING YET");
    expect(direct.out).toContain("press Deploy, databases first");
    // The command that sounds right is not it, and the block says so.
    expect(direct.out).toContain("`dockify redeploy` does not do this");
    expect(direct.out).not.toContain("--all");
    expect(direct.out).not.toContain("tunnel");
    const tunnel = lib("kept_data_apps_step tunnel");
    expect(tunnel.out).toContain("connect Cloudflare again, then remove each such domain and add it again");
    // Only there: a fresh install's first step has no apps to speak of.
    const s = src();
    const step = s.slice(s.indexOf('if [ -n "$REUSE_FROM" ]; then\n  FIRST_STEP='), s.indexOf('cat <<EOF\n\n  Dockify is running.'));
    expect(step.indexOf('kept_data_apps_step "$INGRESS"')).toBeGreaterThan(0);
    expect(step.indexOf('kept_data_apps_step "$INGRESS"')).toBeLessThan(step.indexOf("/setup"));
  });
  it("no audit finding id is left in a comment", () => {
    for (const f of [src(), readFileSync(path.resolve(import.meta.dirname, "../../agent/src/docker-gate.ts"), "utf8")]) {
      expect(f).not.toMatch(/\b(?:VPS|RT|NB)-?\d+\b|\bC-17\b/);
    }
  });
  it("a run after a failed first start says so and gives the setup token, instead of reading as installed", () => {
    const s = src();
    expect(s.indexOf('[ -f "$DIR/.install-incomplete" ] && [ -f "$DIR/.env" ]')).toBeLessThan(s.indexOf('say "Dockify is already installed in $DIR"'));
    expect(s).toContain('say "An earlier install in $DIR did not finish starting"');
    expect(s.indexOf(': > "$DIR/.install-incomplete"')).toBeLessThan(s.indexOf('say "Starting"'));
    expect(s.indexOf('rm -f "$DIR/.install-incomplete"\nrecord_release_version')).toBeGreaterThan(s.indexOf('say "Waiting for readiness"'));
  });
});

describe.skipIf(!haveBash)("install.sh order and small repairs", () => {
  it("checks the release before it creates anything at Cloudflare", () => {
    const s = src();
    const release = s.indexOf('\nresolve_release\nfetch_stack_files\n');
    expect(release).toBeGreaterThan(0);
    expect(release).toBeLessThan(s.indexOf('say "Cloudflare tunnel"'));
    expect(s.indexOf('\nresolve_release\nfetch_stack_files\n', release + 1)).toBe(-1);
  });
  it("restores echo on the terminal, not on stdin, which is the pipe under curl | sh", () => {
    expect(src()).toContain("{ stty echo < /dev/tty; } 2>/dev/null || true");
    expect(src()).not.toContain("stty echo 2>/dev/null");
  });
  it("removes the bootstrap's temp folder, which its exec left with no trap, and no other folder", () => {
    expect(src()).toContain('case "$0" in */tmp.*/installer.sh) ! script_dir_is_private "$(dirname "$0")" || rm -rf "$(dirname "$0")" ;; esac');
  });
  it("factory reset takes an image's anonymous volumes too, as its prompt says", () => {
    expect(src()).toContain('docker rm -fv "\\$i"');
  });
  it("drops Azure's WireServer for containers and keeps the DNS it also answers", () => {
    expect(lib("render_firewall").out).toContain("ins iptables DOCKER-USER -d 168.63.129.16/32 -p tcp ! --dport 53 -j DROP");
    expect(readFileSync(UNINSTALL, "utf8")).toContain('del "$t" DOCKER-USER -d 168.63.129.16/32 -p tcp ! --dport 53 -j DROP');
  });
});

describe.skipIf(!haveBash)("the container firewall", () => {
  const rules = () => lib("render_firewall").out.split("\n").filter((l) => /^\s*ins /.test(l)).map((l) => l.trim());

  it("lets only the deploy bridge reach the host, on 80 and 443 only, ahead of the tenant drop", () => {
    const r = rules();
    const drop = r.indexOf("ins iptables INPUT -i dk-+ -j DROP");
    const web = r.indexOf("ins iptables INPUT -i dk-deploy -p tcp --dport 80 -j ACCEPT");
    const tls = r.indexOf("ins iptables INPUT -i dk-deploy -p tcp --dport 443 -j ACCEPT");
    expect(drop).toBeGreaterThanOrEqual(0);
    // Each rule is inserted at the top when missing, so one inserted later sits above the drop.
    expect(web).toBeGreaterThan(drop);
    expect(tls).toBeGreaterThan(drop);
    for (const t of ["ip6tables"]) {
      expect(r).toContain(`ins ${t} INPUT -i dk-deploy -p tcp --dport 80 -j ACCEPT`);
      expect(r).toContain(`ins ${t} INPUT -i dk-deploy -p tcp --dport 443 -j ACCEPT`);
    }
    // No other port and no other bridge is opened.
    const opened = r.filter((l) => / -j ACCEPT$/.test(l) && !/ESTABLISHED,RELATED/.test(l));
    expect(opened.every((l) => / -i dk-deploy -p tcp --dport (80|443) -j ACCEPT$/.test(l))).toBe(true);
    expect(r.some((l) => /-i dk-\+ .*--dport/.test(l))).toBe(false);
  });

  it("keeps the metadata and tenant rules it had", () => {
    const r = rules();
    for (const l of [
      "ins iptables DOCKER-USER -d 169.254.0.0/16 -j DROP",
      "ins iptables DOCKER-USER -d 100.100.100.200/32 -j DROP",
      "ins iptables INPUT -i dk-+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
      "ins ip6tables DOCKER-USER -d fd00:ec2::254/128 -j DROP",
    ]) expect(r).toContain(l);
  });

  it("is the script the installer writes, and the uninstaller removes the new rules too", () => {
    expect(src()).toContain("render_firewall > /usr/local/sbin/dockify-firewall");
    const un = readFileSync(UNINSTALL, "utf8");
    expect(un).toContain('del "$t" INPUT -i dk-deploy -p tcp --dport 80 -j ACCEPT');
    expect(un).toContain('del "$t" INPUT -i dk-deploy -p tcp --dport 443 -j ACCEPT');
  });
});

describe.skipIf(!haveBash)("starting the stack", () => {
  /** A fake `dockify` that fails its first `count` runs, logging each call. */
  function fakeDockify(failFirst: number) {
    const root = scratch();
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    const log = path.join(root, "calls");
    writeFileSync(path.join(bin, "dockify"), `#!/bin/sh\necho "dockify $*" >> '${posixPath(log)}'\nn=$(wc -l < '${posixPath(log)}')\n[ "$n" -gt ${failFirst} ]\n`, { mode: 0o755 });
    writeFileSync(path.join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return { bin, calls: () => readFileSync(log, "utf8").trim().split("\n") };
  }

  it("retries `up -d --wait` once before it fails", () => {
    const once = fakeDockify(1);
    const r = lib("up_wait --no-deps api", { path: once.bin });
    expect(r.code).toBe(0);
    expect(once.calls()).toEqual(["dockify up -d --wait --no-deps api", "dockify up -d --wait --no-deps api"]);
    const twice = fakeDockify(2);
    expect(lib("up_wait", { path: twice.bin }).code).not.toBe(0);
    expect(twice.calls()).toHaveLength(2);
  });

  it("the first install starts the stack through the retry", () => {
    expect(src()).toMatch(/^up_wait \|\| \{ dockify ps; dockify logs --tail 40; die "\$NOT_UP"; \}$/m);
    expect(src()).toContain('NOT_UP="the stack did not come up healthy"');
    expect(src()).not.toMatch(/^dockify up -d --wait/m);
  });

  /** A rendered wrapper over a fake install and a fake docker that logs each compose call. */
  function wrapper(dockerFails = "") {
    const root = scratch();
    const dir = path.join(root, "opt");
    mkdirSync(path.join(dir, "release"), { recursive: true });
    mkdirSync(path.join(root, "bin"));
    writeFileSync(path.join(dir, "docker-compose.yml"), "services: {}\n");
    writeFileSync(path.join(dir, ".env"), "DOCKIFY_DIR=x\n");
    writeFileSync(path.join(dir, "release", "release.env"), `DOCKIFY_CONTROL_IMAGE=r/c${DIGEST("1")}\nDOCKIFY_WEB_IMAGE=r/w${DIGEST("2")}\n`);
    const log = path.join(root, "calls");
    writeFileSync(path.join(root, "bin", "docker"), `#!/bin/sh\nshift 9\necho "$*" >> '${posixPath(log)}'\ncase "$*" in ${dockerFails || "__none__"}) exit 1 ;; esac\n`, { mode: 0o755 });
    const uid = lib("id -u").out.trim();
    expect(lib(`render_wrapper '${posixPath(dir)}' '${uid}' > '${posixPath(path.join(root, "dockify"))}'`).code).toBe(0);
    const go = (args: string) => {
      const x = spawnSync(BASH, ["-c", `PATH='${posixPath(path.join(root, "bin"))}':"$PATH" sh '${posixPath(path.join(root, "dockify"))}' ${args}`], { encoding: "utf8" });
      let calls: string[] = [];
      try {
        calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
      } catch {
        calls = [];
      }
      return { code: x.status ?? -1, err: x.stderr, calls };
    };
    return go;
  }

  it("`dockify redeploy` runs migrate first, then api, agent, worker and web one at a time, then the updater", () => {
    const r = wrapper()("redeploy");
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([
      "run --rm --no-deps migrate",
      "up -d --no-deps --wait api",
      "up -d --no-deps --wait agent",
      "up -d --no-deps --wait worker",
      "up -d --no-deps --wait web",
      "up -d --no-deps updater",
    ]);
  });

  it("recreates nothing when migrate fails", () => {
    const r = wrapper("run*migrate*")("redeploy");
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/migrations failed; nothing was recreated/);
    expect(r.calls).toEqual(["run --rm --no-deps migrate"]);
  });
});

describe("the compose file starts the updater after migrate", () => {
  const compose = readFileSync(path.resolve(import.meta.dirname, "../../../deploy/docker-compose.yml"), "utf8");
  const service = (name: string) => new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}\\S|^\\S)`, "m").exec(compose)?.[1] ?? "";
  it("so it never reads tables migrate has not made yet", () => {
    const deps = /depends_on:\n((?: {6}.*\n)+)/.exec(service("updater"))?.[1] ?? "";
    expect(deps).toContain("migrate: { condition: service_completed_successfully }");
    expect(deps).toContain("postgres: { condition: service_healthy }");
  });
  it("as the api does", () => {
    expect(service("api")).toContain("migrate: { condition: service_completed_successfully }");
  });
});

describe.skipIf(!haveBash)("the link's secrets", () => {
  it("makes a key, a certificate and a token once, and an upgrade keeps them, because every agent pinned that certificate", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dk-link-"));
    try {
      const made = lib(`export MSYS_NO_PATHCONV=1; make_link_secrets '${dir.replaceAll("\\", "/")}'`);
      expect(made.err).toBe("");
      expect(made.code).toBe(0);
      const cert = readFileSync(path.join(dir, "link_cert"), "utf8");
      const token = readFileSync(path.join(dir, "primary_join_token"), "utf8");
      expect(cert).toContain("BEGIN CERTIFICATE");
      expect(readFileSync(path.join(dir, "link_key"), "utf8")).toContain("PRIVATE KEY");
      expect(token.length).toBeGreaterThanOrEqual(40);
      expect(new X509Certificate(cert).publicKey.asymmetricKeyType).toBe("ed25519");
      expect(lib(`export MSYS_NO_PATHCONV=1; make_link_secrets '${dir.replaceAll("\\", "/")}'`).code).toBe(0);
      expect(readFileSync(path.join(dir, "link_cert"), "utf8")).toBe(cert);
      expect(readFileSync(path.join(dir, "primary_join_token"), "utf8")).toBe(token);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!haveBash)("rewriting one .env key", () => {
  it("replaces the key, keeps every other line, and refuses what could break the file", () => {
    const d = scratch();
    const f = path.join(d, ".env");
    writeFileSync(f, "# header\nDOCKIFY_DIR=/opt/dockify\nDOCKIFY_COMPOSE_SHA256=old\nLOG_LEVEL=info\n");
    expect(lib(`env_set '${posixPath(f)}' DOCKIFY_COMPOSE_SHA256 ${"a".repeat(64)}`).code).toBe(0);
    expect(lib(`env_set '${posixPath(f)}' DOCKIFY_SERVER_IPV6 2001:db8::7`).code).toBe(0);
    const lines = readFileSync(f, "utf8").trim().split("\n");
    expect(lines).toEqual(["# header", "DOCKIFY_DIR=/opt/dockify", "LOG_LEVEL=info", `DOCKIFY_COMPOSE_SHA256=${"a".repeat(64)}`, "DOCKIFY_SERVER_IPV6=2001:db8::7"]);
    for (const [k, v] of [["lower", "x"], ["A", "x y"], ["A", "$(id)"], ["A", "x\nB=y"]]) {
      expect(lib(`env_set '${posixPath(f)}' '${k}' '${v}'`).code, `${k}=${v}`).not.toBe(0);
    }
  });
});

describe.skipIf(!haveBash)("site audit items in the installer", () => {
  const INSTALLER_DIR = path.dirname(SCRIPT);
  const scripts = ["install.sh", "bootstrap.sh", "uninstall.sh", "uninstall-bootstrap.sh"].map((f) => readFileSync(path.join(INSTALLER_DIR, f), "utf8"));

  it("every piped one-liner fails on an HTTP error instead of running the error page", () => {
    for (const s of scripts) {
      expect(s).not.toMatch(/curl -sSL https:\/\/dockify\.sh/);
      for (const line of s.split("\n").filter((l) => /curl [^|]*https:\/\/dockify\.sh\/(un)?install\.sh \| sh/.test(l))) expect(line).toContain("curl -fsSL");
    }
  });

  it("the closing message names Settings, Updates", () => {
    expect(src()).toContain("Updates install themselves (Settings, Updates).");
    expect(src()).not.toMatch(/Settings, Instance, Updates/);
  });

  /** Fake `ss` and `systemctl` that print what a host would. */
  function host(ss: string, listen: string) {
    const bin = path.join(scratch(), "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "ss"), `#!/bin/sh\ncat <<'EOF'\n${ss}\nEOF\n`, { mode: 0o755 });
    writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh\n[ "$*" = "show -p Listen --value ssh.socket" ] && printf '%s\\n' '${listen}'\nexit 0\n`, { mode: 0o755 });
    return bin;
  }
  const ports = (bin: string) => lib("ssh_ports", { path: bin }).out.trim().split("\n").filter(Boolean);

  it("finds SSH on sshd's own listener and on a socket-activated ssh.socket", () => {
    const sshd = 'LISTEN 0 128 0.0.0.0:2222 0.0.0.0:* users:(("sshd",pid=812,fd=3))';
    const systemd = 'LISTEN 0 4096 *:2200 *:* users:(("systemd",pid=1,fd=99))';
    expect(ports(host(sshd, ""))).toEqual(["2222"]);
    // Ubuntu 22.10 and later: systemd owns the listener, ssh.socket's ListenStream names the port.
    expect(ports(host(systemd, "[::]:2200 (Stream)"))).toEqual(["2200"]);
    expect(ports(host(sshd, "0.0.0.0:22 (Stream) [::]:22 (Stream)"))).toEqual(["22", "2222"]);
    // Nothing found: empty, so the caller allows 22.
    expect(ports(host("", ""))).toEqual([]);
    expect(src()).toMatch(/SSH_PORTS="\$\(ssh_ports\)"\n\s+\[ -n "\$SSH_PORTS" \] \|\| SSH_PORTS=22/);
  });

  it("a dry run without openssl or jq skips reading the feed instead of failing", () => {
    // PATH holds the basics this needs but neither tool.
    const bin = path.join(scratch(), "bin");
    mkdirSync(bin);
    for (const tool of ["sed", "grep", "cat", "dirname"]) {
      const where = lib(`command -v ${tool}`).out.trim();
      if (where) writeFileSync(path.join(bin, tool), `#!/bin/sh\nexec '${where}' "$@"\n`, { mode: 0o755 });
    }
    const r = spawnSync(BASH, ["-c", `PATH='${posixPath(bin)}'; DOCKIFY_INSTALL_LIB=1 . '${posixPath(SCRIPT)}'; DRY=1 FEED=https://feed.example.com PUBKEY=RWQkey CONTROL_IMAGE= WEB_IMAGE=; resolve_release; echo "rc=$?"`], { encoding: "utf8" });
    expect(r.stdout).toContain("[dry-run] openssl or jq is not installed yet");
    expect(r.stdout).toContain("rc=0");
    // A real run with the same input still refuses: it installs both tools before this point.
    expect(src()).toMatch(/elif \[ -n "\$FEED" \] && \[ -n "\$PUBKEY" \]; then\n\s+curl -fsS --proto '=https' --max-filesize 524288/);
    expect(src()).toMatch(/if \[ "\$INGRESS" = tunnel \] && \[ "\$DRY" = 1 \] && ! command -v jq/);
  });
});

describe("the --upgrade flow", () => {
  const body = () => {
    const s = src();
    const start = s.indexOf("upgrade() {");
    return s.slice(start, s.indexOf("\n}\n", start));
  };

  it("is reached before a fresh install would refuse an existing one", () => {
    const s = src();
    expect(s).toMatch(/--upgrade\) UPGRADE=1; shift ;;/);
    expect(s.indexOf('if [ "$UPGRADE" = 1 ]; then')).toBeLessThan(s.indexOf('if [ -f "$DIR/.env" ]; then'));
  });

  it("runs migrate after the backup and the dump, and before any service is recreated", () => {
    const b = body();
    const at = (needle: string) => {
      const i = b.indexOf(needle);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(at('cp -p "$DIR/docker-compose.yml" "$DIR/.env"')).toBeLessThan(at('cp "$TMP/docker-compose.yml" "$DIR/docker-compose.yml"'));
    expect(at("pg_dump")).toBeLessThan(at("run --rm --no-deps migrate"));
    expect(at("run --rm --no-deps migrate")).toBeLessThan(at("up_wait --no-deps --force-recreate socket-proxy"));
    // A failed migrate puts the previous files back.
    expect(b).toMatch(/run --rm --no-deps migrate \|\| \{ restore_files; die/);
  });

  it("pins the new compose file, recreates the socket proxy for its mounted allowlist, and the proxy after the worker", () => {
    const b = body();
    expect(b).toContain('env_set "$DIR/.env" DOCKIFY_COMPOSE_SHA256');
    expect(b).toContain("--force-recreate socket-proxy");
    expect(b).toMatch(/for s in buildkit api agent worker web "\$PROXY"; do up_wait --no-deps "\$s"/);
    expect(b).toContain("make_route_folder");
    expect(b).toContain("install_firewall");
  });

  it("hands the work volume to uid 1000 as root with only CAP_CHOWN and no network", () => {
    const b = body();
    expect(b).toMatch(/docker run --rm --network none --user 0:0 --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges \\\n\s+-v dockify_dockify-work:\/w --entrypoint \/bin\/chown "\$CONTROL_IMAGE" 1000:1000 \/w/);
  });

  it("adds the tunnel's api rule only with a token, through the helper", () => {
    const b = body();
    expect(b).toContain('tunnel_add_api_rule "$DOMAIN"');
    expect(b).toContain('if [ -n "$CF_TOKEN_FILE" ]');
  });

  it("rewrites the dockify wrapper, so an old box gets `dockify admin`", () => {
    const b = body();
    expect(b).toMatch(/render_wrapper "\$DIR" 0 > \/usr\/local\/bin\/dockify\n\s+chmod 0755 \/usr\/local\/bin\/dockify/);
    // Before the images are pulled with it, so every later step runs the new wrapper.
    expect(b.indexOf("render_wrapper")).toBeLessThan(b.indexOf("dockify pull"));
  });

  it("records the Docker engine's version in .env, on every upgrade", () => {
    const s = src();
    const b = s.slice(s.indexOf("upgrade() {"));
    expect(b).toMatch(/DV="\$\(docker version --format '\{\{\.Server\.Version\}\}' 2>\/dev\/null \|\| true\)"\n\s+\[ -z "\$DV" \] \|\| env_set "\$DIR\/.env" DOCKIFY_DOCKER_VERSION "\$DV" \|\| true/);
  });

  it("records the server's own name in .env, on every upgrade", () => {
    const b = body();
    expect(b).toMatch(/HN="\$\(host_name\)"\n\s+\[ -z "\$HN" \] \|\| env_set "\$DIR\/.env" DOCKIFY_HOST_NAME "\$HN" \|\| true/);
    expect(src()).toMatch(/HN="\$\(host_name\)"\n\s+\[ -z "\$HN" \] \|\| echo "DOCKIFY_HOST_NAME=\$HN"/);
  });
});

describe.skipIf(!haveBash)("the dockify wrapper and the host name", () => {
  it("the wrapper has the account rescue commands, run inside the api container", () => {
    const w = lib("render_wrapper /opt/dockify 0").out;
    expect(w).toContain('if [ "${1:-}" = admin ]; then');
    expect(w).toContain("exec api dockify-entrypoint admin");
    expect(w).toContain("# dockify admin disable-mfa | reset-password | revoke-sessions <email>");
  });

  /** A fake `uname` that prints `name` for -n. */
  const named = (name: string) => {
    const bin = path.join(scratch(), "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "uname"), `#!/bin/sh\n[ "$1" = -n ] || exit 0\ncat <<'EOF'\n${name}\nEOF\n`, { mode: 0o755 });
    return bin;
  };

  it("is the kernel's node name, cut to hostname characters on one line", () => {
    expect(lib("host_name", { path: named("vps-fra-1") }).out.trim()).toBe("vps-fra-1");
    expect(lib("host_name", { path: named("box.example.com") }).out.trim()).toBe("box.example.com");
    // Nothing that could change .env: no spaces, quotes, $ or a second line.
    expect(lib("host_name", { path: named("a b$(id)'\"c") }).out.trim()).toBe("abidc");
    expect(lib("host_name", { path: named("x".repeat(300)) }).out.trim()).toHaveLength(253);
  });
});

describe("the compose file passes what the api and worker read", () => {
  const compose = readFileSync(path.resolve(import.meta.dirname, "../../../deploy/docker-compose.yml"), "utf8");
  const service = (name: string) => new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}\\S|^\\S)`, "m").exec(compose)?.[1] ?? "";

  it("gives both the server's own name and its IPv6 address", () => {
    for (const s of ["api", "worker"]) {
      expect(service(s), s).toContain("DOCKIFY_HOST_NAME: ${DOCKIFY_HOST_NAME:-}");
      expect(service(s), s).toContain("DOCKIFY_SERVER_IPV6: ${DOCKIFY_SERVER_IPV6:-}");
    }
  });

  it("points the service alert's probes at internal addresses only", () => {
    const worker = service("worker");
    const api = /DOCKIFY_PROBE_API_URL: (\S+)/.exec(worker)?.[1];
    // The api's fixed control address. Traefik's ping goes over the agent, by its reserved name on the deploy network.
    expect(api).toBe("http://172.30.2.10:3001/healthz");
    expect(worker).not.toMatch(/DOCKIFY_PROBE_PROXY_URL/);
    expect(service("agent")).toContain("deploy: {}");
    expect(service("api")).toMatch(/control: \{ ipv4_address: 172\.30\.2\.10 \}/);
    for (const p of ["proxy", "proxy-direct"]) {
      expect(service(p), p).toContain("deploy: { aliases: [dk-proxy] }");
      expect(service(p), p).toContain("- --ping=true");
    }
  });
});

describe("email moved to SMTP: an install from before it upgrades without a manual step", () => {
  const script = () => readFileSync(SCRIPT, "utf8").replace(/\r\n/g, "\n");
  const upgrade = () => script().slice(script().indexOf("\nupgrade() {"), script().indexOf('if [ "${DOCKIFY_INSTALL_LIB:-}" = 1 ]'));
  it("makes the new secret file before anything needs it: the layout's chown and the new compose file", () => {
    const u = upgrade();
    const made = u.indexOf('[ -f "$DIR/secrets/smtp_password" ] || : > "$DIR/secrets/smtp_password"');
    expect(made).toBeGreaterThan(-1);
    expect(made).toBeLessThan(u.indexOf('apply_layout file "$DIR"'));
    expect(made).toBeLessThan(u.indexOf('cp "$TMP/docker-compose.yml" "$DIR/docker-compose.yml"'));
    expect(made).toBeLessThan(u.indexOf("dockify pull"));
  });
  it("removes the old key file only after the services are up, since a failed migrate puts the old compose file back", () => {
    const u = upgrade();
    const gone = u.indexOf('rm -f "$DIR/secrets/resend_api_key"');
    expect(gone).toBeGreaterThan(u.indexOf("dockify run --rm --no-deps migrate"));
    expect(gone).toBeGreaterThan(u.indexOf('dockify up -d --no-deps updater'));
  });
  it("a fresh install writes the password to the secret file and never to .env", () => {
    const s = script();
    expect(s).toContain(`printf '%s' "$SMTP_PASSWORD" > "$DIR/secrets/smtp_password"`);
    expect(s).not.toMatch(/echo "DOCKIFY_SMTP_PASSWORD/);
    expect(s).toContain('echo "DOCKIFY_SMTP_HOST=$SMTP_HOST"');
  });
  it("the compose file still parses as the file secret the api mounts", () => {
    const compose = readFileSync(path.resolve(import.meta.dirname, "../../../deploy/docker-compose.yml"), "utf8");
    expect(compose).toContain("smtp_password: { file: ./secrets/smtp_password }");
    expect(compose).not.toMatch(/resend/i);
  });
});

describe.skipIf(!haveBash)("the folders compose binds", () => {
  it("makes buildkit/ for uid 1000 before anything starts: Docker would make it root's, and rootless BuildKit could not start", () => {
    const rows = lib("layout_plan /opt/dockify").out.split("\n");
    expect(rows).toContain("dir 0750 1000:1000 /opt/dockify/buildkit");
    const compose = readFileSync(path.resolve(import.meta.dirname, "../../../deploy/docker-compose.yml"), "utf8");
    // Every relative bind's folder is made by the installer, so none is left to Docker.
    const binds = [...compose.matchAll(/^\s+- \.\/([a-z-]+)(?:\/[^:]*)?:\//gm)].map((m) => m[1]!);
    expect(binds.length).toBeGreaterThan(0);
    for (const b of new Set(binds)) expect(rows.some((r) => r.endsWith(`/opt/dockify/${b}`)), b).toBe(true);
  });
});

describe.skipIf(!haveBash || spawnSync(BASH, ["-c", "command -v jq"]).status !== 0)("Docker's address pools", () => {
  /** Fakes that record what ran. `running` is what `docker ps -q` prints; dockerd --validate and the restart can be told to fail. */
  function bin(o: { running?: string; validate?: number; restart?: number } = {}) {
    const dir = scratch();
    const log = path.join(dir, "calls.log");
    const fake = (name: string, body: string) => writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> '${posixPath(log)}'\n${body}\n`, { mode: 0o755 });
    fake("docker", `[ "$1" = ps ] && printf '%s' '${o.running ?? ""}'\nexit 0`);
    fake("dockerd", `exit ${o.validate ?? 0}`);
    fake("systemctl", `exit ${o.restart ?? 0}`);
    return { dir, log, calls: () => { try { return readFileSync(log, "utf8"); } catch { return ""; } } };
  }
  const run = (f: string, b: ReturnType<typeof bin>, dry = 0) => lib(`DRY=${dry}; DOCKER_DAEMON_JSON='${posixPath(f)}'; widen_address_pools`, { path: b.dir });
  const pools = (f: string) => JSON.parse(readFileSync(f, "utf8"))["default-address-pools"] as Array<{ base: string; size: number }>;

  it("keeps Docker's own list in its own order, and adds room for 50 previews on top of the 31", () => {
    const f = path.join(scratch(), "daemon.json");
    const b = bin();
    expect(run(f, b).code).toBe(0);
    const p = pools(f);
    expect(p.slice(0, 7).map((x) => `${x.base}@${x.size}`)).toEqual(["172.17.0.0/16@16", "172.18.0.0/16@16", "172.19.0.0/16@16", "172.20.0.0/14@16", "172.24.0.0/14@16", "172.28.0.0/14@16", "192.168.0.0/16@20"]);
    const count = p.reduce((n, x) => n + 2 ** (x.size - Number(x.base.split("/")[1])), 0);
    expect(count).toBeGreaterThanOrEqual(31 + 50);
  });

  it("on a server with nothing running, writes the file and restarts Docker", () => {
    const f = path.join(scratch(), "daemon.json");
    const b = bin();
    expect(run(f, b).code).toBe(0);
    expect(b.calls()).toContain("systemctl restart docker");
    expect(pools(f).length).toBe(8);
  });

  it("with anything running, writes the file, never restarts, and says what to do", () => {
    const f = path.join(scratch(), "daemon.json");
    const b = bin({ running: "abc" });
    const r = run(f, b);
    expect(r.code).toBe(0);
    expect(b.calls()).not.toContain("systemctl");
    expect(pools(f).length).toBe(8);
    expect(r.out).toContain("sudo systemctl restart docker");
    expect(r.out).toContain("next time Docker restarts");
  });

  it("merges into a daemon.json the owner already has, keeping every other setting", () => {
    const f = path.join(scratch(), "daemon.json");
    writeFileSync(f, JSON.stringify({ "log-level": "warn", "live-restore": false }));
    expect(run(f, bin({ running: "abc" })).code).toBe(0);
    const j = JSON.parse(readFileSync(f, "utf8"));
    expect(j["log-level"]).toBe("warn");
    expect(j["live-restore"]).toBe(false);
    expect(j["default-address-pools"].length).toBe(8);
  });

  it("leaves pools the owner chose, and a file it cannot read, exactly as they are", () => {
    const f = path.join(scratch(), "daemon.json");
    const mine = JSON.stringify({ "default-address-pools": [{ base: "10.9.0.0/16", size: 24 }] });
    writeFileSync(f, mine);
    const b = bin();
    expect(run(f, b).code).toBe(0);
    expect(readFileSync(f, "utf8")).toBe(mine);
    expect(b.calls()).not.toContain("systemctl");
    writeFileSync(f, "{not json");
    const r = run(f, b);
    expect(r.code).toBe(0);
    expect(readFileSync(f, "utf8")).toBe("{not json");
    expect(r.err).toContain("not a JSON object");
  });

  it("does nothing on a second run: no restart, no rewrite", () => {
    const f = path.join(scratch(), "daemon.json");
    run(f, bin());
    const first = readFileSync(f, "utf8");
    const b = bin();
    const r = run(f, b);
    expect(r.code).toBe(0);
    expect(readFileSync(f, "utf8")).toBe(first);
    expect(b.calls()).not.toContain("systemctl");
    expect(r.out).toBe("");
  });

  it("leaves the file as it was when Docker refuses the new one", () => {
    const f = path.join(scratch(), "daemon.json");
    writeFileSync(f, "{}");
    const b = bin({ validate: 1 });
    const r = run(f, b);
    expect(r.code).toBe(0);
    expect(readFileSync(f, "utf8")).toBe("{}");
    expect(b.calls()).not.toContain("systemctl");
    expect(r.err).toContain("unchanged");
  });

  it("puts the old file back when Docker will not start on the new one", () => {
    const f = path.join(scratch(), "daemon.json");
    writeFileSync(f, JSON.stringify({ "log-level": "warn" }));
    const dir = scratch();
    const log = path.join(dir, "restarts");
    writeFileSync(path.join(dir, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(path.join(dir, "dockerd"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // The first restart fails, as a daemon that will not start on this file would.
    writeFileSync(path.join(dir, "systemctl"), `#!/bin/sh\n[ -e '${posixPath(log)}' ] && exit 0\n: > '${posixPath(log)}'\nexit 1\n`, { mode: 0o755 });
    const r = lib(`DRY=0; DOCKER_DAEMON_JSON='${posixPath(f)}'; widen_address_pools`, { path: dir });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ "log-level": "warn" });
    expect(r.err).toContain("previous settings are back");
  });

  it("a dry run writes nothing", () => {
    const f = path.join(scratch(), "daemon.json");
    const b = bin();
    expect(run(f, b, 1).out).toContain("[dry-run]");
    expect(() => readFileSync(f)).toThrow();
    expect(b.calls()).toBe("");
  });

  it("runs in both flows, before anything else needs a network", () => {
    const s = src();
    const fresh = s.slice(s.indexOf("-- 5. firewall rules for containers"), s.indexOf("-- 6. ingress"));
    expect(fresh).toContain("widen_address_pools");
    const up = s.slice(s.indexOf("upgrade() {"), s.indexOf('say "Images"'));
    expect(up).toContain("widen_address_pools");
  });
});
