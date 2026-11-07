/**
 * The installer's answer to "how do people even set up a domain": none needed. Helpers are sourced in
 * library mode (DOCKIFY_INSTALL_LIB=1 stops it before it touches anything); the flow reads from a file
 * standing in for the terminal.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "../../../installer/install.sh");
const BASH = process.env.DOCKIFY_TEST_BASH ?? (process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash");
const haveBash = spawnSync(BASH, ["-c", "true"]).status === 0;
const posixPath = (p: string) => p.replace(/^([A-Za-z]):\\/, (_m, d: string) => `/${d.toLowerCase()}/`).replace(/\\/g, "/");
const lib = (snippet: string, env: NodeJS.ProcessEnv = {}) => {
  const r = spawnSync(BASH, ["-c", `DOCKIFY_INSTALL_LIB=1 . '${posixPath(SCRIPT)}'; ${snippet}`], { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
};
const src = readFileSync(SCRIPT, "utf8");
const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe.skipIf(!haveBash)("no domain needed", () => {
  it("spells an address the way sslip.io reads it", () => {
    expect(lib("sslip_host 203.0.113.4").out).toBe("203-0-113-4.sslip.io");
    expect(lib("is_dashboard_host $(sslip_host 203.0.113.4)").code).toBe(0);
  });

  it("tells a public address from one that cannot be", () => {
    for (const ip of ["8.8.8.8", "203.0.113.10", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1"]) expect(lib(`is_public_ipv4 ${ip}`).code, ip).toBe(0);
    for (const ip of ["", "10.0.0.5", "127.0.0.1", "192.168.1.1", "172.16.0.1", "172.31.255.1", "100.64.0.1", "169.254.1.1", "224.0.0.1", "not.an.ip", "2001:db8::1"]) expect(lib(`is_public_ipv4 '${ip}'`).code, ip).not.toBe(0);
  });

  it("takes a domain however it is typed", () => {
    expect(lib("clean_host ' HTTPS://Dash.Example.com/setup '").out).toBe("dash.example.com");
    expect(lib("clean_host 'dash.example.com.'").out).toBe("dash.example.com");
  });

  it("asks on the terminal, and an unanswerable terminal is an empty answer, not a failure", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tty-"));
    tmps.push(dir);
    const tty = path.join(dir, "tty");
    writeFileSync(tty, "");
    const answered = lib(`ask_tty 'Q: '; echo "|$?"`, { DOCKIFY_TTY: posixPath(tty) });
    expect(answered.out).toBe("|0\n");
    const none = lib(`ask_tty 'Q: '; echo "|$?"`, { DOCKIFY_TTY: "/nonexistent/dir/tty" });
    expect(none.out).toBe("|0\n");
    expect(none.err).toBe("");
  });

  it("starts on sslip.io in direct mode when nothing was typed, with no email asked for", () => {
    // The order of the decisions is what matters: nothing can die for want of a domain or an email.
    expect(src).toMatch(/DOMAIN="\$\(clean_host "\$\(ask_tty "Dashboard domain \(\$HINT\): "\)"\)"/);
    expect(src).toContain('DOMAIN="$(sslip_host "$SERVER_IP")"');
    expect(src).toMatch(/DOMAIN="\$\(sslip_host "\$SERVER_IP"\)"\n\s+INGRESS=direct/);
    expect(src).toContain('[ -n "$ACME_EMAIL" ] || ACME_EMAIL="dockify@$DOMAIN"');
    expect(src).not.toContain("--domain is required when no terminal is attached");
    expect(src).not.toContain("direct mode needs --acme-email");
  });

  it("keeps a given --domain and tunnel mode working: a flag without --ingress is still a tunnel", () => {
    expect(src).toContain('[ -n "$INGRESS" ] || INGRESS=tunnel');
    expect(src).toContain('[ "$INGRESS" != tunnel ] || die "a Cloudflare tunnel needs a domain: pass --domain"');
  });

  it("an install that exists says so before it asks anything", () => {
    expect(src.indexOf('say "Dockify is already installed in $DIR"')).toBeLessThan(src.indexOf("ask_tty \"Dashboard domain"));
  });

  it("waits for the first certificate, so the printed link works, and only ever warns", () => {
    const at = src.indexOf('say "Waiting for the certificate"');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(src.indexOf("Dockify is running."));
    expect(src).toMatch(/until curl -sS --proto '=https' --max-time 8 -o \/dev\/null "https:\/\/\$DOMAIN\/setup"/);
  });

  it("--upgrade keeps whatever address .env names, the sslip one included", () => {
    expect(src).toMatch(/DOMAIN="\$\(envget DOCKIFY_PUBLIC_URL \|/);
    const upgrade = src.slice(src.indexOf("upgrade() {"), src.indexOf("if [ \"${DOCKIFY_INSTALL_LIB:-}\" = 1 ]"));
    expect(upgrade).not.toContain("DOCKIFY_PUBLIC_URL \"");
    expect(upgrade).not.toMatch(/env_set "\$DIR\/\.env" DOCKIFY_PUBLIC_URL/);
    expect(lib("is_dashboard_host 203-0-113-10.sslip.io").code).toBe(0);
  });
});

describe.skipIf(!haveBash)("dockify admin set-domain", () => {
  const wrapper = () => lib("render_wrapper /opt/dockify 0").out;

  it("is a valid script, ahead of the admin branch that runs inside the api", () => {
    const w = wrapper();
    const dir = mkdtempSync(path.join(tmpdir(), "wrap-"));
    tmps.push(dir);
    const file = path.join(dir, "w.sh");
    writeFileSync(file, w);
    expect(spawnSync(BASH, ["-n", posixPath(file)]).status).toBe(0);
    expect(w.indexOf('= set-domain ]')).toBeGreaterThan(0);
    expect(w.indexOf('= set-domain ]')).toBeLessThan(w.indexOf('exec docker compose --project-directory "$D" -f "$D/docker-compose.yml" --env-file "$D/.env" --env-file "$R" exec api dockify-entrypoint admin'));
  });

  it("writes .env beside itself with its owner and mode, and recreates only what reads the address", () => {
    const w = wrapper();
    expect(w).toContain('T="$D/.env.tmp.$$"');
    expect(w).toContain('chown --reference="$D/.env" "$T"');
    expect(w).toContain('chmod --reference="$D/.env" "$T"');
    expect(w).toContain('mv -f "$T" "$D/.env"');
    expect(w).toMatch(/for s in api worker web; do\n\s+c up -d --no-deps --wait "\$s"/);
  });

  it("refuses anything but a plain hostname before it touches a file, and asks the api about a name an app holds", () => {
    const w = wrapper();
    const check = w.indexOf("grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z]{2,63}$'");
    const asks = w.indexOf("admin check-domain");
    const writes = w.indexOf('T="$D/.env.tmp.$$"');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(asks);
    expect(asks).toBeLessThan(writes);
    // A dashboard that is down must not stop the way back in: only the api's "taken" answer does.
    expect(w).toContain('[ "$rc" != 2 ] || exit 2');
  });

  it("--sslip is the way back to a name that always works, except in a tunnel", () => {
    const w = wrapper();
    expect(w).toContain("--sslip");
    expect(w).toContain("a Cloudflare tunnel only serves names on Cloudflare");
  });

  it.skipIf(spawnSync(BASH, ["-c", "command -v jq"]).status !== 0)("--upgrade adds the rules of a host the tunnel has none for, and leaves one that has any", () => {
    const answer = (ingress: object[]) => JSON.stringify({ success: true, result: { config: { ingress } } });
    const run = (ingress: object[]) => {
      const r = spawnSync(BASH, ["-c", `DOCKIFY_INSTALL_LIB=1 . '${posixPath(SCRIPT)}'; tunnel_add_dashboard_rules new.example.com`], { encoding: "utf8", input: answer(ingress) });
      return r.stdout.trim();
    };
    const next = JSON.parse(run([{ service: "http://dockify-proxy:80" }])) as { config: { ingress: Array<{ hostname?: string; path?: string; service: string }> } };
    expect(next.config.ingress[0]).toEqual({ hostname: "new.example.com", path: "^/api/v1/", service: "http://172.30.1.10:3001" });
    expect(next.config.ingress[1]).toEqual({ hostname: "new.example.com", service: "http://172.30.1.20:3000" });
    expect(run([{ hostname: "new.example.com", service: "http://mine:1" }, { service: "x" }])).toBe("");
  });
});
