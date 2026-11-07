/**
 * Tests for installer/uninstall.sh. Nothing here touches the real host: every run sets
 * DOCKIFY_UNINSTALL_ROOT to a temp sandbox (host paths are taken under it), and docker, systemctl,
 * iptables and curl are fakes on a PATH that holds only the sandbox bin and the shell's own tools.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Each case runs the real script through bash, which is slow on Windows.
vi.setConfig({ testTimeout: 60_000 });

const INSTALLER = path.resolve(import.meta.dirname, "../../../../../../installer");
const SCRIPT = path.join(INSTALLER, "uninstall.sh");
const BASH = process.env.DOCKIFY_TEST_BASH
  ?? (process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash");
const haveBash = spawnSync(BASH, ["-c", "true"]).status === 0;
const jqPath = haveBash ? spawnSync(BASH, ["-c", "command -v jq"], { encoding: "utf8" }).stdout.trim() : "";
const haveJq = jqPath !== "";
// The sandbox PATH is the fake bin plus the shell's own tools, and jq's folder when it lives elsewhere.
const extraPath = haveJq ? `:${path.posix.dirname(jqPath)}` : "";
const posixPath = (p: string) => p.replace(/^([A-Za-z]):\\/, (_m, d: string) => `/${d.toLowerCase()}/`).replace(/\\/g, "/");

const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

/**
 * A docker that keeps its objects in state files, one per kind: "name label=value ...". It
 * understands the queries and removals uninstall.sh makes, and logs every call.
 */
const FAKE_DOCKER = String.raw`#!/usr/bin/env bash
S="$DK_STATE"; echo "docker $*" >> "$S/log"
match() { # $1 kind, then filters; prints names
  local kind="$1"; shift
  awk -v F="$*" '{
    ok = 1; n = split(F, fs, " ")
    for (i = 1; i <= n; i++) {
      f = fs[i]; if (f == "") continue
      if (f ~ /^name=/) { if (index($1, substr(f, 6)) == 0) ok = 0; continue }
      l = substr(f, 7); hit = 0
      for (j = 2; j <= NF; j++) { if (index(l, "=") ? $j == l : index($j, l "=") == 1) hit = 1 }
      if (!hit) ok = 0
    }
    if (ok) print $1 }' "$S/$kind"
}
drop() { local kind="$1"; shift; for n in "$@"; do awk -v n="$n" '$1 != n' "$S/$kind" > "$S/$kind.t"; mv "$S/$kind.t" "$S/$kind"; done; }
filters() { local out=""; while [ $# -gt 0 ]; do [ "$1" = --filter ] && out="$out $2"; shift; done; echo "$out"; }
case "$1" in
  info) exit 0 ;;
  ps) match containers $(filters "$@") ;;
  volume) case "$2" in ls) match volumes $(filters "$@") ;; rm) shift 2; [ "$1" = -f ] && shift; drop volumes "$@" ;; esac ;;
  network) case "$2" in ls) match networks $(filters "$@") ;; rm) shift 2; drop networks "$@" ;; esac ;;
  image) case "$2" in
      ls) match images $(filters "$@") ;;
      rm) shift 2; f=0; if [ "$1" = -f ]; then f=1; shift; fi
        if [ "$f" = 0 ] && grep -q "^$1 .*in-use" "$S/images"; then echo "conflict: image is being used by container someone-else" >&2; exit 1; fi
        drop images "$@" ;;
      inspect) shift 2; fmt=""; if [ "$1" = --format ]; then fmt=1; shift 2; fi
        for n in "$@"; do grep -q "^$n\( \|$\)" "$S/images" || exit 1; [ -z "$fmt" ] || echo 1200000000; done ;;
    esac ;;
  rm) shift; case "$1" in -f|-fv) shift ;; esac; drop containers "$@" ;;
  compose) for a in "$@"; do [ "$a" = down ] && drop containers $(match containers label=com.docker.compose.project=dockify); done ;;
esac
exit 0
`;

/** Cloudflare, as far as the uninstaller talks to it: one account, one zone, our tunnel. */
const FAKE_CURL = String.raw`#!/usr/bin/env bash
S="$DK_STATE"; m=GET out="" url=""
while [ $# -gt 0 ]; do
  case "$1" in -X) m="$2"; shift 2 ;; -o) out="$2"; shift 2 ;; -H|-w|--proto|--max-time) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac
done
p="${"${"}url#https://cf.test}"; echo "curl $m $p" >> "$S/log"
# The network going away: curl leaves its -o file untouched and writes nothing.
if [ "$m $p" = "$DK_CURL_DOWN" ]; then exit 7; fi
code=200 body='{"success":true,"result":[]}'
case "$m $p" in
  "GET /user/tokens/verify") body='{"success":true,"result":{"status":"active"}}' ;;
  "GET /accounts/acc1/cfd_tunnel/tun1")
    if [ -f "$S/tunnel-gone" ]; then body='{"success":true,"result":{"name":"dockify-box-abc123","deleted_at":"2026-10-30T00:00:00Z"}}'
    else body='{"success":true,"result":{"name":"dockify-box-abc123","deleted_at":null}}'; fi ;;
  "DELETE /accounts/acc1/cfd_tunnel/tun1") : > "$S/tunnel-gone"; body='{"success":true,"result":{}}' ;;
  "GET /zones?"*) body='{"success":true,"result":[{"id":"zone1"}],"result_info":{"total_pages":1}}' ;;
  "GET /zones/zone1/dns_records?"*)
    if [ -f "$S/dns-gone" ]; then body='{"success":true,"result":[]}'
    else body='{"success":true,"result":[{"id":"rec1","type":"CNAME","content":"tun1.cfargotunnel.com"},{"id":"other","type":"CNAME","content":"tun9.cfargotunnel.com"}]}'; fi ;;
  "DELETE /zones/zone1/dns_records/rec1") : > "$S/dns-gone"; body='{"success":true,"result":{}}' ;;
  "DELETE /zones/zone1/dns_records/"*) echo "WRONG DELETE $p" >> "$S/log" ;;
esac
[ -z "$out" ] || printf '%s' "$body" > "$out"
printf '%s' "$code"
`;

const LOGGER = (name: string) => `#!/usr/bin/env bash\necho "${name} $*" >> "$DK_STATE/log"\n${name === "iptables" || name === "ip6tables" ? '[ "$1" = -C ] && exit 1\n' : ""}exit 0\n`;

interface Box { root: string; dir: string; state: string; bin: string; run: (args: string, env?: string) => { code: number; out: string; err: string }; log: () => string; state_: (k: string) => string }

/** A sandboxed tunnel-mode install with a stack, two apps, their volumes and networks. */
function sandbox(opts: { ingress?: "tunnel" | "direct"; token?: boolean } = {}): Box {
  const root = mkdtempSync(path.join(tmpdir(), "dk-uninst-"));
  tmps.push(root);
  const dir = path.join(root, "opt", "dockify");
  const state = path.join(root, "state");
  const bin = path.join(root, "bin");
  for (const d of [path.join(dir, "secrets"), path.join(dir, "release"), state, bin, path.join(root, "usr/local/bin"), path.join(root, "usr/local/sbin"), path.join(root, "etc/systemd/system"), path.join(root, "etc/apt/apt.conf.d"), path.join(root, "root")]) mkdirSync(d, { recursive: true });
  const tunnel = (opts.ingress ?? "tunnel") === "tunnel";
  writeFileSync(path.join(dir, ".env"), [
    "DOCKIFY_DIR=/opt/dockify", "DOCKIFY_PUBLIC_URL=https://dash.example.com",
    tunnel ? "DOCKIFY_INGRESS=cloudflare_tunnel" : "DOCKIFY_INGRESS=direct_tls",
    ...(tunnel ? ["TUNNEL_TOKEN=tt", "DOCKIFY_CF_ACCOUNT_ID=acc1", "DOCKIFY_CF_TUNNEL_ID=tun1", "DOCKIFY_CF_DASHBOARD_RECORD_ID=rec1"] : []), "",
  ].join("\n"));
  writeFileSync(path.join(dir, "docker-compose.yml"), "name: dockify\n");
  writeFileSync(path.join(dir, "release", "release.env"), "DOCKIFY_CONTROL_IMAGE=x\n");
  writeFileSync(path.join(dir, "secrets", "master_key"), "MASTERKEY");
  writeFileSync(path.join(dir, "secrets", "postgres_password"), "pw");
  if (opts.token) writeFileSync(path.join(dir, "secrets", "cf_api_token"), "cf-secret-token\n");
  for (const f of ["usr/local/bin/dockify", "usr/local/sbin/dockify-firewall", "etc/systemd/system/dockify-firewall.service", "etc/apt/apt.conf.d/52dockify-docker", "etc/apt/apt.conf.d/20auto-upgrades"]) writeFileSync(path.join(root, f), "x\n");
  const P = "com.docker.compose.project=dockify";
  writeFileSync(path.join(state, "containers"), [`dockify-api-1 ${P}`, `dockify-worker ${P}`, "dk-app1 dockify.managed=true dockify.app=app1", "dk-app2 dockify.managed=true dockify.app=app2", "someone-else foo=bar", ""].join("\n"));
  writeFileSync(path.join(state, "volumes"), [`dockify_dockify-db ${P}`, "dockify-data-app1 dockify.app=app1 dockify.environment=e1", "app2-files dockify.managed=true dockify.app=app2", "unrelated-vol", ""].join("\n"));
  writeFileSync(path.join(state, "networks"), [`dockify_control ${P}`, `dockify-deploy ${P}`, "dockify-env-e1 dockify.managed=true dockify.environment=e1", "dockify-helpers dockify.role=helpers", "bridge", "my-net", ""].join("\n"));
  writeFileSync(path.join(state, "images"), ["img1 dockify.managed=true", "other-img", ""].join("\n"));
  writeFileSync(path.join(state, "log"), "");
  writeFileSync(path.join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  writeFileSync(path.join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
  for (const t of ["systemctl", "iptables", "ip6tables"]) writeFileSync(path.join(bin, t), LOGGER(t), { mode: 0o755 });
  const run = (args: string, env = "") => {
    const cmd = `${env} DOCKIFY_UNINSTALL_ROOT='${posixPath(root)}' DOCKIFY_UNINSTALL_CF_API=https://cf.test DK_STATE='${posixPath(state)}' PATH='${posixPath(bin)}':/usr/bin:/bin${extraPath} bash '${posixPath(SCRIPT)}' --dir '${posixPath(dir)}' ${args} </dev/null`;
    const r = spawnSync(BASH, ["-c", cmd], { encoding: "utf8" });
    return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
  };
  return { root, dir, state, bin, run, log: () => readFileSync(path.join(state, "log"), "utf8"), state_: (k) => readFileSync(path.join(state, k), "utf8") };
}

const backups = (b: Box) => readdirSync(path.join(b.root, "root")).filter((n) => n.startsWith("dockify-backup-"));

describe.skipIf(!haveBash)("uninstall.sh dry run", () => {
  it("prints the full plan and changes nothing", () => {
    const b = sandbox();
    const r = b.run("--dry-run");
    expect(r.code, r.err).toBe(0);
    for (const s of [
      "Will remove", "2 container(s) of compose project dockify", "app containers Dockify deployed: 2", "dk-app1",
      "dockify-firewall.service", "/usr/local/bin/dockify", "52dockify-docker", "Cloudflare tunnel tun1",
      "Will keep (--keep-data)", "dockify-data-app1", "app2-files", "dockify-env-e1", "dockify-helpers",
      "dockify-backup-", "Never touched", "Docker, ufw", "Dry run: nothing was changed",
    ]) expect(r.out, s).toContain(s);
    expect(r.out).not.toContain("unrelated-vol");
    expect(r.out).not.toContain("my-net");
    expect(existsSync(path.join(b.dir, ".env"))).toBe(true);
    expect(existsSync(path.join(b.root, "usr/local/bin/dockify"))).toBe(true);
    expect(backups(b)).toEqual([]);
    expect(b.log()).not.toMatch(/docker (rm|volume rm|network rm|compose)|systemctl|curl/);
  });

  it("lists volumes, networks and images as deleted under --purge", () => {
    const r = sandbox().run("--dry-run --purge");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("volumes, with every database and file stored in them: 3");
    expect(r.out).toContain("images Dockify built: 1");
    expect(r.out).not.toContain("Will keep");
  });

  it("refuses to run without a terminal unless --yes is given", () => {
    const b = sandbox();
    const r = b.run("");
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/no terminal to confirm on; pass --yes/);
    expect(existsSync(path.join(b.dir, ".env"))).toBe(true);
  });

  it("refuses a folder that does not look like a Dockify install", () => {
    const b = sandbox();
    const odd = path.join(b.root, "home-stuff");
    mkdirSync(odd);
    writeFileSync(path.join(odd, "notes.txt"), "x");
    const r = spawnSync(BASH, ["-c", `DOCKIFY_UNINSTALL_ROOT='${posixPath(b.root)}' PATH='${posixPath(b.bin)}':/usr/bin:/bin bash '${posixPath(SCRIPT)}' --dir '${posixPath(odd)}' --yes`], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/does not look like a Dockify install/);
    expect(existsSync(path.join(odd, "notes.txt"))).toBe(true);
  });
});

describe.skipIf(!haveBash)("uninstall.sh confirmation", () => {
  const answers = (b: Box, ...lines: string[]) => {
    const f = path.join(b.root, "answers");
    writeFileSync(f, `${lines.join("\n")}\n`);
    return `DOCKIFY_UNINSTALL_TTY='${posixPath(f)}'`;
  };

  it("needs the dashboard domain typed exactly, and changes nothing otherwise", () => {
    const b = sandbox({ ingress: "direct" });
    const no = b.run("", answers(b, "uninstall"));
    expect(no.code).not.toBe(0);
    expect(no.err).toContain("Type dash.example.com to uninstall");
    expect(no.err).toMatch(/not confirmed\. Nothing was changed/);
    expect(existsSync(b.dir)).toBe(true);
    expect(b.state_("containers")).toContain("dk-app1");
    const yes = b.run("", answers(b, "dash.example.com"));
    expect(yes.code, yes.err).toBe(0);
    expect(existsSync(b.dir)).toBe(false);
  });

  it("asks for \"uninstall\" when there is no domain", () => {
    const b = sandbox({ ingress: "direct" });
    rmSync(path.join(b.dir, ".env"));
    const r = b.run("", answers(b, "uninstall"));
    expect(r.err).toContain("Type uninstall to uninstall");
    expect(r.code, r.err).toBe(0);
  });

  it("--purge asks a second time before deleting data", () => {
    const b = sandbox({ ingress: "direct" });
    const no = b.run("--purge", answers(b, "dash.example.com", "yes"));
    expect(no.code).not.toBe(0);
    expect(no.err).toContain("Type purge to confirm");
    expect(b.state_("volumes")).toContain("dockify-data-app1");
    expect(existsSync(b.dir)).toBe(true);
    const yes = b.run("--purge", answers(b, "dash.example.com", "purge", "n"));
    expect(yes.code, yes.err).toBe(0);
    expect(b.state_("volumes")).not.toContain("dockify-data-app1");
    expect(backups(b)).toEqual([]);
  });
});

describe.skipIf(!haveBash)("uninstall.sh --keep-data (the default)", () => {
  it("removes the stack, apps and host files, keeps the data, and backs up the secrets", () => {
    const b = sandbox();
    const r = b.run("--yes");
    expect(r.code, r.err + r.out).toBe(0);
    expect(b.state_("containers").trim()).toBe("someone-else foo=bar");
    for (const v of ["dockify_dockify-db", "dockify-data-app1", "app2-files", "unrelated-vol"]) expect(b.state_("volumes")).toContain(v);
    for (const n of ["dockify-env-e1", "dockify-helpers", "my-net"]) expect(b.state_("networks")).toContain(n);
    expect(b.state_("networks")).not.toContain("dockify_control");
    expect(b.state_("images")).toContain("img1");
    for (const f of ["usr/local/bin/dockify", "usr/local/sbin/dockify-firewall", "etc/systemd/system/dockify-firewall.service", "etc/apt/apt.conf.d/52dockify-docker"]) expect(existsSync(path.join(b.root, f)), f).toBe(false);
    expect(existsSync(path.join(b.root, "etc/apt/apt.conf.d/20auto-upgrades"))).toBe(true);
    expect(existsSync(b.dir)).toBe(false);
    expect(b.log()).toContain("systemctl disable --now dockify-firewall.service");
    const [bk] = backups(b);
    expect(bk).toMatch(/^dockify-backup-\d{8}T\d{6}Z/);
    const bdir = path.join(b.root, "root", bk!);
    expect(readFileSync(path.join(bdir, "secrets", "master_key"), "utf8")).toBe("MASTERKEY");
    expect(existsSync(path.join(bdir, ".env"))).toBe(true);
    if (process.platform !== "win32") expect(statSync(bdir).mode & 0o777).toBe(0o700);
    expect(r.out).toContain(posixPath(bdir).replace(posixPath(b.root), ""));
    // No token: the tunnel is left for the user, with the exact steps.
    expect(r.out).toContain("the tunnel with id tun1");
    expect(r.out).toContain("tun1.cfargotunnel.com");
    expect(existsSync(path.join(bdir, "cloudflare-pending"))).toBe(true);
    expect(r.out).toMatch(/reboot/);
  });

  it.skipIf(!haveJq)("is idempotent: a second run finds nothing to do", () => {
    const b = sandbox({ token: true });
    expect(b.run("--yes").code).toBe(0);
    const again = b.run("--yes");
    expect(again.code, again.err).toBe(0);
    expect(again.out).toContain("Dockify is not installed here");
    expect(again.out).toContain("Nothing to do");
    expect(backups(b)).toHaveLength(1);
  });

  it("finishes after a partial removal and reports what it could not remove", () => {
    const b = sandbox();
    rmSync(path.join(b.root, "usr/local/bin/dockify"));
    rmSync(path.join(b.root, "etc/systemd/system/dockify-firewall.service"));
    const r = b.run("--yes");
    expect(r.code, r.err).toBe(0);
    expect(existsSync(b.dir)).toBe(false);
    expect(r.out).toContain("not removed: Cloudflare tunnel tun1");
  });
});

describe.skipIf(!haveBash || !haveJq)("uninstall.sh Cloudflare cleanup", () => {
  it("deletes the tunnel and only the CNAMEs pointing at it, then clears the pending mark", () => {
    const b = sandbox({ token: true });
    const r = b.run("--yes");
    expect(r.code, r.err + r.out).toBe(0);
    const log = b.log();
    expect(log).toContain("curl DELETE /accounts/acc1/cfd_tunnel/tun1/connections");
    expect(log).toContain("curl DELETE /accounts/acc1/cfd_tunnel/tun1");
    expect(log).toContain("curl DELETE /zones/zone1/dns_records/rec1");
    expect(log).not.toContain("WRONG DELETE");
    expect(log).not.toContain("cf-secret-token");
    expect(r.out).toContain("deleted tunnel dockify-box-abc123 (tun1)");
    expect(r.out).toContain("Dockify is uninstalled");
    expect(existsSync(path.join(b.root, "root", backups(b)[0]!, "cloudflare-pending"))).toBe(false);
  });

  it("a re-run picks up a tunnel left pending from the backup", () => {
    const b = sandbox();
    expect(b.run("--yes").code).toBe(0);
    const bdir = path.join(b.root, "root", backups(b)[0]!);
    writeFileSync(path.join(bdir, "secrets", "cf_api_token"), "cf-secret-token");
    const r = b.run("--yes");
    expect(r.code, r.err).toBe(0);
    expect(b.log()).toContain("curl DELETE /accounts/acc1/cfd_tunnel/tun1");
    expect(existsSync(path.join(bdir, "cloudflare-pending"))).toBe(false);
  });
});

describe.skipIf(!haveBash)("uninstall.sh and a Cloudflare call that never connects", () => {
  it("cf answers nothing, not the call before it, when curl cannot connect", () => {
    const d = mkdtempSync(path.join(tmpdir(), "dk-cf-"));
    tmps.push(d);
    const script = String.raw`
      eval "$(sed -n '/^cf() {/,/^}/p' '${posixPath(SCRIPT)}')"
      TMP='${posixPath(d)}'; CF_API=https://cf.test
      printf 'Authorization: x' > "$TMP/cf.hdr"
      printf '{"success":true}' > "$TMP/cf.body"
      curl() { return 7; }
      out="$(cf DELETE /x)"; printf 'body=[%s] code=%s' "$out" "$(cat "$TMP/cf.code")"`;
    expect(spawnSync(BASH, ["-c", script], { encoding: "utf8" }).stdout).toBe("body=[] code=000");
  });

  it.skipIf(!haveJq)("does not read the last answer as this one's: the tunnel is not called deleted, and the pending mark stays", () => {
    const b = sandbox({ token: true });
    const r = b.run("--yes", "DK_CURL_DOWN='DELETE /accounts/acc1/cfd_tunnel/tun1'");
    expect(r.out + r.err).not.toContain("deleted tunnel");
    expect(r.err).toContain("cannot delete the tunnel");
    expect(existsSync(path.join(b.root, "root", backups(b)[0]!, "cloudflare-pending"))).toBe(true);
  });
});

describe.skipIf(!haveBash)("uninstall.sh and what counts as a Dockify install", () => {
  const myApp = (b: Box, env: string, compose: string) => {
    const d = path.join(b.root, "srv", "myapp");
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, ".env"), env);
    writeFileSync(path.join(d, "docker-compose.yml"), compose);
    return d;
  };

  it("refuses somebody else's project that merely has a .env and a compose file", () => {
    const b = sandbox();
    const d = myApp(b, "SECRET=x\n", "services: {}\n");
    const r = b.run(`--yes --dir '${posixPath(d)}'`);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("does not look like a Dockify install");
    expect(existsSync(path.join(d, ".env"))).toBe(true);
  });
  it("still takes what an interrupted uninstall left: the secrets alone, or the compose file alone", () => {
    const b = sandbox();
    rmSync(path.join(b.dir, ".env"));
    rmSync(path.join(b.dir, "docker-compose.yml"));
    expect(b.run("--dry-run").code).toBe(0);
    const c = sandbox();
    rmSync(path.join(c.dir, ".env"));
    rmSync(path.join(c.dir, "secrets"), { recursive: true });
    writeFileSync(path.join(c.dir, "docker-compose.yml"), "x: ${DOCKIFY_PUBLIC_URL:?}\n");
    expect(c.run("--dry-run").code).toBe(0);
  });
  it("refuses a path that climbs out of what it names", () => {
    const b = sandbox();
    const r = b.run("--dry-run --dir /srv/../home/me");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("plain path");
  });
});

describe.skipIf(!haveBash)("uninstall.sh and what it leaves", () => {
  const DIGEST = (c: string) => `sha256:${c.repeat(64)}`;
  const CONTROL = `127.0.0.1:5000/dockify-control@${DIGEST("a")}`;
  const OLD_CONTROL = `127.0.0.1:5000/dockify-control@${DIGEST("9")}`;
  const WEB = `ghcr.io/o/dockify-web@${DIGEST("b")}`;
  const POSTGRES = `postgres@${DIGEST("c")}`;
  const TRAEFIK = `traefik@${DIGEST("d")}`;
  const COMPOSE = [
    "name: dockify",
    "x-control: &control",
    "  image: ${DOCKIFY_CONTROL_IMAGE:?release.env must pin the control image}",
    "services:",
    `  postgres:\n    image: postgres:17.6-alpine@${DIGEST("c")}`,
    `  proxy-direct:\n    image: &traefik traefik:v3.5.3@${DIGEST("d")}`,
    "  proxy-tunnel:\n    image: *traefik",
    "  web:\n    image: ${DOCKIFY_WEB_IMAGE:?pin}",
    "",
  ].join("\n");
  /** The stack's images on the box, one of them also used by someone else's container. */
  function withImages(o: { daemon?: string; before?: boolean } = {}) {
    const b = sandbox({ ingress: "direct" });
    writeFileSync(path.join(b.dir, "docker-compose.yml"), COMPOSE);
    writeFileSync(path.join(b.dir, "release", "release.env"), `DOCKIFY_CONTROL_IMAGE=${CONTROL}\nDOCKIFY_WEB_IMAGE=${WEB}\n`);
    writeFileSync(path.join(b.state, "images"), [`${CONTROL} a`, `${WEB} a`, `${POSTGRES} a`, `${TRAEFIK} in-use`, "img1 dockify.managed=true", "other-img", "nginx:1", ""].join("\n"));
    if (o.daemon) {
      mkdirSync(path.join(b.root, "etc/docker"), { recursive: true });
      writeFileSync(path.join(b.root, "etc/docker/daemon.json"), o.daemon);
      if (o.before) writeFileSync(path.join(b.root, "etc/docker/daemon.json.before-dockify"), "{}");
    }
    return b;
  }
  const POOLS = JSON.stringify({ "log-driver": "journald", "default-address-pools": [{ base: "10.213.0.0/16", size: 24 }] });

  it("--purge removes Dockify's own images by digest, never forced, and names one another container holds", () => {
    const b = withImages();
    const r = b.run("--yes --purge");
    expect(r.code, r.err + r.out).toBe(0);
    const left = b.state_("images").trim().split("\n").map((l) => l.split(" ")[0]).sort();
    expect(left).toEqual([TRAEFIK, "nginx:1", "other-img"].sort());
    expect(b.log()).toContain(`docker image rm ${POSTGRES}`);
    expect(b.log()).toContain(`docker image rm ${CONTROL}`);
    expect(b.log()).not.toContain(`docker image rm -f ${TRAEFIK}`);
    expect(r.out).toContain("deleted 3 of Dockify's own image(s)");
    expect(r.out).toContain(`not removed, another container may use it: ${TRAEFIK}: conflict`);
  });

  it("the --purge plan lists those images with their size", () => {
    const r = withImages().run("--dry-run --purge");
    expect(r.out).toContain("Dockify's own images: 4, about 4.8 GB");
    expect(r.out).toContain(POSTGRES);
  });

  it("--keep-data leaves them and says so, with why and how much", () => {
    const b = withImages();
    const r = b.run("--yes");
    expect(r.code, r.err + r.out).toBe(0);
    expect(b.log()).not.toContain("docker image rm");
    expect(r.out).toContain("Still on this server");
    expect(r.out).toContain("Dockify's own images: 4, about 4.8 GB, so installing again need not download them. --purge removes them");
  });

  it("finds the images from the backup, for a --purge after a --keep-data", () => {
    const b = withImages();
    expect(b.run("--yes").code).toBe(0);
    expect(existsSync(b.dir)).toBe(false);
    const r = b.run("--yes --purge");
    expect(r.code, r.err + r.out).toBe(0);
    expect(b.log()).toContain(`docker image rm ${POSTGRES}`);
  });

  it("takes the versions an update left behind in the control repository too", () => {
    const b = withImages();
    writeFileSync(path.join(b.bin, "docker"), readFileSync(path.join(b.bin, "docker"), "utf8").replace('case "$1" in', `if [ "$1 $2" = "image ls" ] && [ "$3" = --digests ]; then echo '${OLD_CONTROL}'; exit 0; fi\ncase "$1" in`), { mode: 0o755 });
    writeFileSync(path.join(b.state, "images"), `${readFileSync(path.join(b.state, "images"), "utf8")}${OLD_CONTROL} a\n`);
    expect(b.run("--yes --purge").code).toBe(0);
    expect(b.log()).toContain(`docker image rm ${OLD_CONTROL}`);
  });

  it("says the address pools stay and why, and does not touch the file or restart Docker", () => {
    const b = withImages({ daemon: POOLS, before: true });
    const before = readFileSync(path.join(b.root, "etc/docker/daemon.json"), "utf8");
    const plan = b.run("--dry-run");
    expect(plan.out).toContain("default-address-pools stays");
    const r = b.run("--yes --purge");
    expect(r.code, r.err + r.out).toBe(0);
    expect(readFileSync(path.join(b.root, "etc/docker/daemon.json"), "utf8")).toBe(before);
    expect(r.out).toContain("default-address-pools stays");
    expect(r.out).toContain("The file may hold your other settings and a change takes a Docker restart, so it is not edited");
    expect(r.out).toContain("daemon.json.before-dockify");
    expect(readFileSync(path.join(b.state, "log"), "utf8")).not.toMatch(/restart/);
    const systemctl = existsSync(path.join(b.state, "systemctl.log")) ? readFileSync(path.join(b.state, "systemctl.log"), "utf8") : "";
    expect(systemctl).not.toMatch(/restart docker/);
  });

  it("says nothing of a daemon file with no pools, or none at all", () => {
    expect(withImages({ daemon: '{"log-driver":"journald"}' }).run("--dry-run").out).not.toContain("default-address-pools");
    expect(withImages().run("--dry-run").out).not.toContain("default-address-pools");
  });

  it("always says that images apps pulled stay", () => {
    expect(withImages().run("--yes --purge").out).toContain("images your apps pulled");
  });
});

describe.skipIf(!haveBash)("uninstall.sh --purge", () => {
  it("removes containers with their anonymous volumes; keeping data keeps them", () => {
    const purge = sandbox({ ingress: "direct" });
    expect(purge.run("--yes --purge").code).toBe(0);
    expect(purge.log()).toMatch(/docker rm -fv dk-app1/);
    const keep = sandbox({ ingress: "direct" });
    expect(keep.run("--yes").code).toBe(0);
    expect(keep.log()).toMatch(/docker rm -f dk-app1/);
    expect(keep.log()).not.toMatch(/docker rm -fv/);
  });

  it("the keep-data ending says that installing again picks the data up", () => {
    const b = sandbox({ ingress: "direct" });
    const r = b.run("--yes");
    expect(r.out).toContain("installing again on this server picks this data up");
  });

  it("also deletes every Dockify volume, network and image, and nothing else", () => {
    const b = sandbox({ ingress: "direct" });
    const r = b.run("--yes --purge");
    expect(r.code, r.err + r.out).toBe(0);
    expect(b.state_("volumes").trim()).toBe("unrelated-vol");
    expect(b.state_("networks").trim().split("\n").sort()).toEqual(["bridge", "my-net"]);
    expect(b.state_("images").trim()).toBe("other-img");
    expect(backups(b)).toHaveLength(1);
    expect(r.out).toContain("ufw delete allow 80/tcp");
  });

  it("--no-backup skips the backup only with --purge", () => {
    const b = sandbox({ ingress: "direct" });
    expect(b.run("--yes --purge --no-backup").code).toBe(0);
    expect(backups(b)).toEqual([]);
    const k = sandbox({ ingress: "direct" });
    expect(k.run("--yes --no-backup").code).toBe(0);
    expect(backups(k)).toHaveLength(1);
  });
});

describe.skipIf(!haveBash)("dockify uninstall in the wrapper", () => {
  it("runs the shipped uninstaller with the install folder, after the ownership checks", () => {
    const root = mkdtempSync(path.join(tmpdir(), "dk-wrapu-"));
    tmps.push(root);
    const dir = path.join(root, "opt");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "uninstall.sh"), "echo \"uninstaller $*\"\n", { mode: 0o700 });
    const uid = spawnSync(BASH, ["-c", "id -u"], { encoding: "utf8" }).stdout.trim();
    const w = path.join(root, "dockify");
    const r = spawnSync(BASH, ["-c", `DOCKIFY_INSTALL_LIB=1 . '${posixPath(path.join(INSTALLER, "install.sh"))}'; render_wrapper '${posixPath(dir)}' '${uid}' > '${posixPath(w)}'`]);
    expect(r.status).toBe(0);
    // No docker-compose.yml or .env: uninstall still works on a half removed install.
    const x = spawnSync(BASH, ["-c", `sh '${posixPath(w)}' uninstall --dry-run`], { encoding: "utf8" });
    expect(x.stderr).toBe("");
    expect(x.stdout.trim()).toBe(`uninstaller --dir ${posixPath(dir)} --dry-run`);
    const other = spawnSync(BASH, ["-c", `DOCKIFY_INSTALL_LIB=1 . '${posixPath(path.join(INSTALLER, "install.sh"))}'; render_wrapper '${posixPath(dir)}' 0 > '${posixPath(w)}'; sh '${posixPath(w)}' uninstall`], { encoding: "utf8" });
    if (uid !== "0") expect(other.stderr).toMatch(/must be owned by uid 0/);
  });

  it("the installer ships the uninstaller and the site publishes it with a checksum", () => {
    const install = readFileSync(path.join(INSTALLER, "install.sh"), "utf8");
    expect(install).toContain('install -m 0700 -o 0 -g 0 "$SRC/uninstall.sh" "$DIR/uninstall.sh"');
    const pub = readFileSync(path.resolve(INSTALLER, "../apps/site/scripts/publish-installer.mjs"), "utf8");
    expect(pub).toContain('publish("uninstall-bootstrap.sh", "uninstall.sh", "uninstall.sh", "uninstaller.sh")');
    const boot = readFileSync(path.join(INSTALLER, "uninstall-bootstrap.sh"), "utf8");
    expect(boot).toContain('"$BASE/uninstaller.sh.sha256"');
    expect(boot).toContain("checksum mismatch, refusing to run it");
    for (const f of ["uninstall.sh", "uninstall-bootstrap.sh"]) {
      const s = readFileSync(path.join(INSTALLER, f), "utf8");
      expect(s, f).not.toMatch(/\r/);
      expect(s, f).not.toMatch(/[\u2013\u2014]/);
    }
  });
});
