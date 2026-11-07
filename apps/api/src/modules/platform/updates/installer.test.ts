/**
 * Regression tests for installer/install.sh. The script's helpers are sourced in library mode
 * (DOCKIFY_INSTALL_LIB=1 stops it before it touches anything) and exercised through bash.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "../../../../../../installer/install.sh");
// On Windows, plain "bash" may resolve to the WSL launcher; prefer Git's bash there.
const BASH = process.env.DOCKIFY_TEST_BASH
  ?? (process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash");
const haveBash = spawnSync(BASH, ["-c", "true"]).status === 0;
const posixPath = (p: string) => p.replace(/^([A-Za-z]):\\/, (_m, d: string) => `/${d.toLowerCase()}/`).replace(/\\/g, "/");

function lib(snippet: string, input?: string): { code: number; out: string; err: string } {
  const r = spawnSync(BASH, ["-c", `DOCKIFY_INSTALL_LIB=1 . '${posixPath(SCRIPT)}'; ${snippet}`], { encoding: "utf8", input });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

const DIGEST = (c: string) => `@sha256:${c.repeat(64)}`;
const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe.skipIf(!haveBash)("install.sh ownership of the install folder", () => {
  const plan = () => {
    const r = lib("layout_plan /opt/dockify");
    expect(r.code).toBe(0);
    return new Map(r.out.trim().split("\n").map((l) => {
      const [kind, mode, owner, p] = l.split(" ");
      return [p!, { kind: kind!, mode: mode!, owner: owner! }];
    }));
  };

  it("keeps the folder, docker-compose.yml and .env root-owned and not writable by uid 1000", () => {
    const m = plan();
    expect(m.get("/opt/dockify")).toEqual({ kind: "dir", mode: "0750", owner: "0:1000" });
    expect(m.get("/opt/dockify/docker-compose.yml")).toEqual({ kind: "file", mode: "0640", owner: "0:1000" });
    expect(m.get("/opt/dockify/.env")).toEqual({ kind: "file", mode: "0640", owner: "0:1000" });
  });

  it("lets uid 1000 write only proxy/, buildkit/ and release/release.env", () => {
    const writable = [...plan()].filter(([, v]) => v.owner.startsWith("1000:")).map(([p]) => p).sort();
    expect(writable).toEqual(["/opt/dockify/buildkit", "/opt/dockify/proxy", "/opt/dockify/release", "/opt/dockify/release/release.env"]);
    for (const [p, v] of plan()) {
      if (v.owner.startsWith("0:")) expect(Number.parseInt(v.mode, 8) & 0o022, p).toBe(0);
    }
  });

  it("writes release.env into release/, never next to the compose file", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toContain('> "$DIR/release/release.env"');
    expect(src).not.toMatch(/"\$DIR\/release\.env"/);
    expect(src).not.toMatch(/-o 1000 -g 1000 "\$TMP\/docker-compose\.yml"/);
    expect(src).toContain('echo "DOCKIFY_COMPOSE_SHA256=$COMPOSE_PIN"');
  });
});

describe.skipIf(!haveBash)("install.sh dockify wrapper refuses a tampered tree", () => {
  const uid = () => lib("id -u").out.trim();

  /** A fake install plus a fake docker that prints its arguments. */
  function setup(owner: string, release = `DOCKIFY_CONTROL_IMAGE=r/c${DIGEST("1")}\nDOCKIFY_WEB_IMAGE=r/w${DIGEST("2")}\n`) {
    const root = mkdtempSync(path.join(tmpdir(), "dk-wrap-"));
    tmps.push(root);
    const dir = path.join(root, "opt");
    mkdirSync(path.join(dir, "release"), { recursive: true });
    mkdirSync(path.join(root, "bin"));
    writeFileSync(path.join(dir, "docker-compose.yml"), "services: {}\n");
    writeFileSync(path.join(dir, ".env"), "DOCKIFY_DIR=x\n");
    writeFileSync(path.join(dir, "release", "release.env"), release);
    // The one read the wrapper itself makes, the impostor check: empty unless a test plants ids.
    writeFileSync(path.join(root, "bin", "docker"), "#!/bin/sh\nif [ \"$1\" = ps ]; then cat \"$(dirname \"$0\")/impostors\" 2>/dev/null; exit 0; fi\necho \"docker $*\"\n", { mode: 0o755 });
    const r = lib(`render_wrapper '${posixPath(dir)}' '${owner}' > '${posixPath(path.join(root, "dockify"))}'`);
    expect(r.code).toBe(0);
    const go = (pre = "", args = "ps") => {
      const x = spawnSync(BASH, ["-c", `${pre} PATH='${posixPath(path.join(root, "bin"))}':"$PATH" sh '${posixPath(path.join(root, "dockify"))}' ${args}`], { encoding: "utf8" });
      return { code: x.status ?? -1, out: x.stdout, err: x.stderr };
    };
    return { dir: posixPath(dir), bin: path.join(root, "bin"), go };
  }

  it("refuses exec and admin while a tenant container poses as a Compose service, and nothing else", () => {
    const { bin, go } = setup(uid());
    writeFileSync(path.join(bin, "impostors"), "abc123\n");
    for (const args of ["admin disable-mfa owner@example.com", "exec -T postgres pg_dump"]) {
      const r = go("", args);
      expect(r.code, args).not.toBe(0);
      expect(r.err).toMatch(/abc123/);
      expect(r.out).toBe("");
    }
    expect(go("", "ps").code).toBe(0);
  });

  it("runs compose when the tree is owned by the expected uid", () => {
    const { go } = setup(uid());
    const r = go();
    expect(r.err).toBe("");
    expect(r.out).toMatch(/^docker compose --project-directory .* --env-file .*\/release\/release\.env ps/);
  });

  it("routes `dockify update ...` to the updater CLI in a one-off container, after the same checks", () => {
    const r = setup(uid()).go("", "update apply 1.2.0");
    expect(r.err).toBe("");
    expect(r.out).toMatch(/ run --rm --no-deps -T updater update apply 1\.2\.0$/m);
    const bad = setup(uid(), "DOCKIFY_CONTROL_IMAGE=r/c:latest\n").go("", "update status");
    expect(bad.code).not.toBe(0);
  });

  it("routes `dockify admin ...` into the running api container through its entrypoint, after the same checks", () => {
    const r = setup(uid()).go("", "admin disable-mfa owner@example.com");
    expect(r.err).toBe("");
    expect(r.out).toMatch(/ --env-file .*\/release\/release\.env exec api dockify-entrypoint admin disable-mfa owner@example\.com$/m);
    // Never a one-off api container: it would ask for the fixed addresses the running api holds.
    expect(r.out).not.toContain(" run ");
    const bad = setup(uid(), "DOCKIFY_CONTROL_IMAGE=r/c:latest\n").go("", "admin reset-password owner@example.com");
    expect(bad.code).not.toBe(0);
  });

  it("`dockify admin reset-link` is root's, writes a new join token in place, then asks the api to forget the key", () => {
    const s = setup(uid());
    const secrets = path.join(s.bin, "..", "opt", "secrets");
    mkdirSync(secrets, { recursive: true });
    const token = path.join(secrets, "primary_join_token");
    writeFileSync(token, "the-old-token");
    const refused = s.go("", "admin reset-link");
    if (process.getuid?.() !== 0) {
      expect(refused.code).not.toBe(0);
      expect(refused.err).toMatch(/run it as root/);
      expect(readFileSync(token, "utf8")).toBe("the-old-token");
    }
    // As root on the box: the wrapper's own id check, answered by a fake `id` on the PATH.
    writeFileSync(path.join(s.bin, "id"), "#!/bin/sh\nif [ \"$1\" = -u ]; then echo 0; else /usr/bin/id \"$@\"; fi\n", { mode: 0o755 });
    const r = s.go("", "admin reset-link");
    expect(r.err).toBe("");
    expect(r.out).toMatch(/ exec api dockify-entrypoint admin reset-link$/m);
    const fresh = readFileSync(token, "utf8");
    expect(fresh).not.toBe("the-old-token");
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  });

  it.skipIf(process.getuid?.() === 0)("refuses files owned by someone other than root", () => {
    const r = setup("0").go();
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/must be owned by uid 0/);
  });

  it.skipIf(process.platform === "win32")("refuses a group-writable docker-compose.yml", () => {
    const { dir, go } = setup(uid());
    const r = go(`chmod 0664 '${dir}/docker-compose.yml';`);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/writable by group or others/);
  });

  it("refuses a release.env that sets any other variable or a tag", () => {
    for (const bad of [
      `DOCKIFY_CONTROL_IMAGE=r/c${DIGEST("1")}\nDOCKIFY_WEB_IMAGE=r/w${DIGEST("2")}\nDOCKIFY_DIR=/\n`,
      `DOCKIFY_CONTROL_IMAGE=r/c:latest\nDOCKIFY_WEB_IMAGE=r/w${DIGEST("2")}\n`,
      `DOCKIFY_CONTROL_IMAGE=r/c${DIGEST("1")}\nDOCKIFY_CONTROL_IMAGE=r/x${DIGEST("3")}\nDOCKIFY_WEB_IMAGE=r/w${DIGEST("2")}\n`,
    ]) {
      const r = setup(uid(), bad).go();
      expect(r.code, bad).not.toBe(0);
      expect(r.err).toMatch(/release\.env (may only pin|must pin)/);
    }
  });
});

describe.skipIf(!haveBash)("install.sh unattended upgrades cover Docker's origin", () => {
  it("allows download.docker.com in the drop-in", () => {
    const r = lib("render_docker_upgrades");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Unattended-Upgrade::Origins-Pattern \{\s*"origin=Docker,site=download\.docker\.com";\s*\};/);
  });

  it("the installer writes the drop-in and no longer claims a blanket statement", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toContain("render_docker_upgrades > /etc/apt/apt.conf.d/52dockify-docker");
    expect(src).not.toContain('note "unattended security upgrades are on"');
  });

  const policy = (src: string) => `containerd.io:\n  Installed: 1.7.27-1\n  Candidate: 1.7.27-1\n  Version table:\n *** 1.7.27-1 500\n${src}        100 /var/lib/dpkg/status\n     1.7.20-1 500\n        500 http://archive.ubuntu.com/ubuntu noble/universe amd64 Packages\n`;

  it("names the origin that patches each runtime", () => {
    expect(lib("classify_policy", policy("        500 https://download.docker.com/linux/ubuntu noble/stable amd64 Packages\n")).out.trim()).toBe("docker");
    expect(lib("classify_policy", policy("        500 http://security.ubuntu.com/ubuntu noble-security/universe amd64 Packages\n")).out.trim()).toBe("distro");
    // Installed from a local .deb: only the dpkg status line, an older repo version does not count.
    expect(lib("classify_policy", policy("")).out.trim()).toBe("local");
  });

  it("reports a binary that no package owns as manual", () => {
    expect(lib("runtime_update_source dockify-no-such-binary").out.trim()).toBe("manual -");
  });
});

describe.skipIf(!haveBash || spawnSync(BASH, ["-c", "command -v jq"]).status !== 0)("install.sh reads the signed v2 feed", () => {
  const feed = (over: Record<string, unknown> = {}) => JSON.stringify({
    schema: 2, channel: "stable", generatedAt: "2026-10-01T00:00:00Z",
    releases: [{
      version: "1.2.0",
      images: {
        control: { amd64: `ghcr.io/o/dockify-control${DIGEST("a")}`, arm64: `ghcr.io/o/dockify-control${DIGEST("b")}` },
        web: { amd64: `ghcr.io/o/dockify-web${DIGEST("c")}`, arm64: `ghcr.io/o/dockify-web${DIGEST("d")}` },
      },
      composeSha256: "e".repeat(64), socketProxySha256: "f".repeat(64),
    }],
    ...over,
  });
  const read = (json: string, trusted: string, arch = "arm64") => {
    const root = mkdtempSync(path.join(tmpdir(), "dk-feed-"));
    tmps.push(root);
    writeFileSync(path.join(root, "m.json"), json);
    return lib(`manifest_release '${posixPath(path.join(root, "m.json"))}' 'Signature and comment signature verified
Trusted comment: ${trusted}' '${arch}'`);
  };

  it("takes the newest release's digests for this architecture", () => {
    const r = read(feed(), "channel:stable version:1.2.0 generated:2026-10-01T00:00:00Z");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`REL_CONTROL=ghcr.io/o/dockify-control${DIGEST("b")}`);
    expect(r.out).toContain("REL_VERSION=1.2.0");
    expect(r.out).toContain(`REL_COMPOSE_SHA=${"e".repeat(64)}`);
  });

  it("passes minFrom on, for --upgrade to check, and refuses a malformed one rather than quoting it into a shell", () => {
    const withMin = (m: string) => feed().replace('"composeSha256"', `"minFrom": "${m}", "composeSha256"`);
    expect(read(withMin("1.1.0"), "channel:stable version:1.2.0").out).toContain("REL_MIN_FROM=1.1.0");
    expect(read(feed(), "channel:stable version:1.2.0").out).toMatch(/REL_MIN_FROM=\s*$/m);
    expect(read(withMin("1.1.0; rm -rf /"), "channel:stable version:1.2.0").code).not.toBe(0);
  });

  it("refuses a trusted comment for another version or channel, a beta feed, a tag, or an unknown arch", () => {
    expect(read(feed(), "channel:stable version:1.1.0").code).not.toBe(0);
    expect(read(feed(), "channel:beta version:1.2.0").code).not.toBe(0);
    expect(read(feed({ channel: "beta" }), "channel:stable version:1.2.0").code).not.toBe(0);
    const tag = feed().replace(`dockify-web${DIGEST("d")}`, "dockify-web:latest");
    expect(read(tag, "channel:stable version:1.2.0").code).not.toBe(0);
    expect(read(feed(), "channel:stable version:1.2.0", "armhf").code).not.toBe(0);
  });
});

describe.skipIf(!haveBash)("install.sh routes the api on the dashboard host", () => {
  const COMPOSE = readFileSync(path.resolve(import.meta.dirname, "../../../../../../deploy/docker-compose.yml"), "utf8");
  const edge = (name: string) => new RegExp(`^ {2}${name}:\\n[\\s\\S]*?edge: \\{ ipv4_address: ([\\d.]+) \\}`, "m").exec(COMPOSE)?.[1];
  const api = () => `http://${edge("api")}:3001`;
  const web = () => `http://${edge("web")}:3000`;

  it("tunnel mode: the api's path first, then the rest of the dashboard, then the proxy", () => {
    const r = lib("render_tunnel_ingress dash.example.com");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      config: {
        ingress: [
          { hostname: "dash.example.com", path: "^/api/v1/", service: api() },
          { hostname: "dash.example.com", service: web() },
          { service: "http://dockify-proxy:80" },
        ],
      },
    });
    expect(api()).toBe("http://172.30.1.10:3001");
  });

  it("direct mode: the installer writes no dashboard route; the worker's routers are the one owner", () => {
    const src = readFileSync(SCRIPT, "utf8");
    // The worker writes proxy/conf/__dashboard.yml (api router above web router) at every boot and
    // removes the 00-dashboard.yml earlier installers wrote; two owners would mean duplicate routers.
    expect(src).not.toContain("render_direct_dashboard");
    expect(src).not.toMatch(/> "\$DIR\/proxy\/00-dashboard\.yml"/);
    expect(src).toContain('install -d -m 0750 -o 1000 -g 1000 "$DIR/proxy/conf"');
  });

  it.skipIf(spawnSync(BASH, ["-c", "command -v jq"]).status !== 0)("an older tunnel gets the api rule right above the dashboard rule, once, and a hand-edited one is left alone", () => {
    const ingress = (rules: unknown[]) => JSON.stringify({ success: true, result: { config: { ingress: rules, "warp-routing": { enabled: false } } } });
    const old = [{ hostname: "dash.example.com", service: "http://web:3000" }, { hostname: "shop.example.com", service: "http://dockify-proxy:80" }, { service: "http://dockify-proxy:80" }];
    const r = lib("tunnel_add_api_rule dash.example.com", ingress(old));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      config: {
        ingress: [{ hostname: "dash.example.com", path: "^/api/v1/", service: api() }, ...old],
        "warp-routing": { enabled: false },
      },
    });
    // Already there, or no plain dashboard rule to put it above: nothing to write.
    const done = [{ hostname: "dash.example.com", path: "^/api/v1/", service: api() }, ...old];
    expect(lib("tunnel_add_api_rule dash.example.com", ingress(done)).out.trim()).toBe("");
    expect(lib("tunnel_add_api_rule dash.example.com", ingress([{ service: "http://dockify-proxy:80" }])).out.trim()).toBe("");
    expect(lib("tunnel_add_api_rule 'a\"b.example.com'", ingress(old)).code).not.toBe(0);
  });

  it("refuses anything but a plain lowercase hostname, so nothing can break out of the JSON or the rule", () => {
    expect(lib(`render_tunnel_ingress 'a"b.example.com'`).code).not.toBe(0);
    expect(lib("render_tunnel_ingress 'dash.example.com/x'").code).not.toBe(0);
    expect(lib("render_tunnel_ingress 'Dash.Example.com'").code).not.toBe(0);
    expect(lib("render_tunnel_ingress 'a`) || Host(`b.com'").code).not.toBe(0);
  });

  it("uses the helper for the tunnel and no longer names web or api by service name", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toContain('ING="$(render_tunnel_ingress "$DOMAIN")"');
    expect(src).not.toMatch(/http:\/\/(web|api):30/);
  });
});

describe("compose and installer agree on configuration", () => {
  const COMPOSE = path.resolve(import.meta.dirname, "../../../../../../deploy/docker-compose.yml");
  const compose = readFileSync(COMPOSE, "utf8");
  const service = (name: string) => new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}\\S|^\\S)`, "m").exec(compose)?.[1] ?? "";

  it("passes the mail server and GitHub App settings to the api, secrets as files only", () => {
    const api = service("api");
    for (const line of [
      "DOCKIFY_SMTP_HOST: ${DOCKIFY_SMTP_HOST:-}",
      "DOCKIFY_SMTP_PORT: ${DOCKIFY_SMTP_PORT:-}",
      "DOCKIFY_SMTP_USER: ${DOCKIFY_SMTP_USER:-}",
      "DOCKIFY_SMTP_PASSWORD_FILE: /run/secrets/smtp_password",
      "DOCKIFY_EMAIL_FROM: ${DOCKIFY_EMAIL_FROM:-}",
      "DOCKIFY_EMAIL_FROM_NAME: ${DOCKIFY_EMAIL_FROM_NAME:-}",
      "DOCKIFY_GITHUB_APP_ID: ${DOCKIFY_GITHUB_APP_ID:-}",
      "DOCKIFY_GITHUB_APP_SLUG: ${DOCKIFY_GITHUB_APP_SLUG:-}",
      "DOCKIFY_GITHUB_APP_PRIVATE_KEY_FILE: /run/secrets/github_app_private_key",
      "DOCKIFY_GITHUB_WEBHOOK_SECRET_FILE: /run/secrets/github_webhook_secret",
    ]) expect(api, line).toContain(line);
    expect(api).not.toMatch(/RESEND|DOCKIFY_SMTP_PASSWORD:|DOCKIFY_GITHUB_APP_PRIVATE_KEY:|DOCKIFY_GITHUB_WEBHOOK_SECRET:/);
    // The worker never sees them: email and GitHub credentials are opened by the api only.
    expect(service("worker")).not.toMatch(/SMTP|GITHUB_APP|GITHUB_WEBHOOK/);
  });

  it("gives api and worker the same reserved hosts and local backup switch", () => {
    for (const s of ["api", "worker"]) {
      expect(service(s), s).toContain("DOCKIFY_RESERVED_HOSTS: ${DOCKIFY_RESERVED_HOSTS:-}");
      expect(service(s), s).toContain("DOCKIFY_ALLOW_LOCAL_BACKUPS: ${DOCKIFY_ALLOW_LOCAL_BACKUPS:-}");
    }
  });

  it("lays out and writes every secret file the compose file mounts", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const files = [...compose.matchAll(/^ {2}(\w+): \{ file: \.\/secrets\/(\w+) \}$/gm)].map((m) => m[2]!);
    expect(files).toEqual(expect.arrayContaining(["smtp_password", "github_app_private_key", "github_webhook_secret"]));
    for (const f of files) {
      expect(src, f).toContain(`file 0440 0:1000 $1/secrets/${f}`);
      // The link's three are made together, and kept across an upgrade.
      if (f.startsWith("link_") || f === "primary_join_token") expect(src, f).toContain(`"$1/${f}"`);
      else expect(src, f).toContain(`> "$DIR/secrets/${f}"`);
    }
  });
});
