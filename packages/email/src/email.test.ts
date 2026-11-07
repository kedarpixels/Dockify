import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { esc, maskEmail, safeUrl, utcTime } from "./html.ts";
import { renderSample, SAMPLE_VARIANTS, TEMPLATE_NAMES } from "./samples.ts";
import { factIcon, whereText, type AppKind, type AppRef, type FactIcon } from "./layout.ts";
import { alert, deployFailed, invite, passwordReset, previewNotice, updateNotice, verifyEmail, type UpdateNoticeInput } from "./templates.ts";

/** Every rendered sample: the templates the dashboard lists and the variants the preview script adds. */
const SAMPLES = [...TEMPLATE_NAMES, ...SAMPLE_VARIANTS];

const DASHES = /[\u2013\u2014]/;
const count = (html: string, needle: string) => html.split(needle).length - 1;

const PLACE: AppRef = { projectName: "horseai", projectSlug: "horseai", env: "production", appName: "web", appKind: "frontend" };
const failed = (where: AppRef | string, origin: string | undefined = "https://d.example.com") =>
  deployFailed({ instanceName: "Dockify", origin, where: where as AppRef, error: "e", source: "main, 4f2a9c1", github: true, at: new Date(0), url: "https://d.example.com/deployments/1" });

describe("templates", () => {
  for (const name of SAMPLES) {
    it(`${name} renders a complete, dash free message in every theme`, () => {
      for (const theme of ["auto", "light", "dark"] as const) {
        const m = renderSample(name, theme, "horseai ops");
        expect(m.subject.length).toBeGreaterThan(5);
        expect(m.html.startsWith("<!doctype html>")).toBe(true);
        expect(m.html).toContain("Sent by horseai ops running Dockify.");
        expect(m.text).toContain("Sent by horseai ops running Dockify.");
        for (const part of [m.subject, m.html, m.text]) expect(DASHES.test(part), name).toBe(false);
        // No scripts, forms, stylesheet links or @import in any template.
        expect(m.html).not.toMatch(/<script|<form|<link|@import/i);
        // The ruled frame: a 594px column between two 1px rails (600 across), full-bleed rules with
        // a node at every crossing, and dither bands drawn as a background image over a solid
        // fallback colour, which is what a client without background images paints.
        expect(m.html).toContain('width="594"');
        expect(m.html).toContain('width="1" class="dk-line"');
        expect(m.html).toContain('class="dk-node"');
        expect(m.html).toMatch(/class="dk-dither" bgcolor="#f5f5f5" style="background-color:#f5f5f5;background-image:url\(https:\/\/dockify\.example\.com\/dk-dither-light\.png\)/);
        // Brand assets ride on the instance origin: the whale and the tone badge glyph as images, and
        // both self-hosted faces (Geist for the words, Geist Pixel Square for the wordmark and titles)
        // loaded with @font-face inside @media screen, which Outlook for Windows skips instead of
        // falling back to Times New Roman.
        expect(m.html).toMatch(/<img src="[^"]*\/dk-logo\.png" width="40" height="29" alt=""/);
        expect(m.html).toContain("/dk-badge-");
        expect(m.html).toMatch(/@media screen\{@font-face\{[^}]*geist-sans\.woff2[^}]*\}@font-face\{[^}]*geist-pixel\.woff2[^}]*\}\}/);
        expect(m.html).toMatch(/<h1 class="dk-ink dk-h1" style="margin:0;font-family:'Geist Pixel Square',[^"]*font-size:32px;line-height:40px;font-weight:400/);
        // The phone rule lets the 594px column give way so the rails sit at the screen edges.
        expect(m.html).toContain("@media (max-width:620px){.dk-gut{width:0!important}.dk-in{width:auto!important}");
      }
    });
  }

  it("follows the reader's scheme on auto, and forces one in previews", () => {
    expect(renderSample("invite", "auto").html).toContain("@media (prefers-color-scheme:dark){.dk-bg{background-color:#0a0a0a!important}");
    expect(renderSample("invite", "light").html).not.toContain(".dk-bg{background-color:#0a0a0a!important}");
    const dark = renderSample("invite", "dark").html;
    expect(dark).toContain(".dk-bg{background-color:#0a0a0a!important}");
    expect(dark).toContain(".dk-dither{background-color:#111111!important;background-image:url('https://dockify.example.com/dk-dither-dark.png')!important}");
    expect(dark).not.toContain("prefers-color-scheme");
  });

  it("puts the code in a monospace block and in the subject", () => {
    const m = verifyEmail({ instanceName: "Dockify", code: "482913" });
    expect(m.subject).toBe("482913 is your Dockify verification code");
    // One monospace block holding the whole code, so it selects and copies as the bare digits.
    expect(m.html).toMatch(/class="dk-code[^"]*"[^>]*>482913<\/td>/);
    expect(m.text).toContain("Verification code: 482913");
    expect(() => verifyEmail({ instanceName: "Dockify", code: "12345" })).toThrow(/6 digits/);
  });

  it("escapes everything an operator controls", () => {
    const m = invite({ instanceName: "<b>ops</b>", invitedBy: '"><script>x</script>', role: "admin", url: "https://d.example.com/invite/t", days: 7 });
    expect(m.html).not.toContain("<script>x");
    expect(m.html).not.toContain("<b>ops</b>");
    expect(m.html).toContain("&lt;b&gt;ops&lt;/b&gt;");
    const chip = failed({ ...PLACE, projectName: "<i>x</i>", appName: "a&b" }).html;
    expect(chip).not.toContain("<i>x</i>");
    expect(chip).toContain("&lt;i&gt;x&lt;/i&gt;");
    expect(chip).toContain("a&amp;b");
  });

  it("refuses a link that is not https", () => {
    for (const url of ["javascript:alert(1)", "http://evil.example/reset", "https://user:pw@d.example.com/x", "/relative"]) {
      expect(() => passwordReset({ instanceName: "Dockify", url }), url).toThrow();
    }
    expect(safeUrl("http://localhost:3000/reset/x")).toBe("http://localhost:3000/reset/x");
    // A chip icon is a link too: it loads from the instance, never from anywhere else.
    expect(() => failed({ ...PLACE, projectIcon: "http://evil.example/x.png" })).toThrow();
    expect(() => failed({ ...PLACE, appIcon: "javascript:alert(1)" })).toThrow();
  });

  it("sets the wordmark and every title as real text, in the pixel face with the Gmail fallback after it", () => {
    const stack = "'Geist Pixel Square','Geist','Helvetica Neue',Helvetica,Arial,sans-serif";
    for (const name of SAMPLES) for (const theme of ["auto", "light", "dark"] as const) {
      const m = renderSample(name, theme);
      expect(m.html, name).toContain(`font-family:${stack};font-size:18px;line-height:24px;font-weight:400;color:#0a0a0a">Dockify</td>`);
      expect(m.html, name).toMatch(/<h1 class="dk-ink dk-h1" style="margin:0;font-family:'Geist Pixel Square'[^"]*font-size:32px;line-height:40px;font-weight:400;letter-spacing:-0\.32px;[^"]*">[^<]+<\/h1>/);
      expect(m.html, name).not.toMatch(/dk-wordmark|dk-t-/);
    }
    const paired = previewNotice({ instanceName: "Dockify", origin: "https://d.example.com", state: "ready", repo: "a/b", prNumber: 1, title: "t", branch: "b", commit: null, author: null, isolatedDb: true, isolation: "base", baseEnvironment: "dev", fromFork: false, lines: [], previewUrl: "https://p.example.com", dashboardUrl: "https://d.example.com/x", recipient: "author", reason: null }, "light").html;
    expect(paired.match(/>Open in Dockify</g)).toHaveLength(1);
    expect(paired.slice(paired.indexOf(">Open preview"), paired.indexOf(">Open in Dockify"))).toContain('<td width="16"');
    const m = passwordReset({ instanceName: "Dockify", origin: "https://d.example.com", url: "https://d.example.com/reset/t" }, "light");
    expect(m.html).toContain(">Reset your password</h1>");
    expect(m.text).toContain("Reset your password");
    expect(invite({ instanceName: "Acme", origin: "https://d.example.com", invitedBy: "a", role: "admin", url: "https://d.example.com/i", days: 7 }).html).toContain(">Join Acme</h1>");
    // Only the whale, the icons and the arrow are images: no image carries words.
    for (const img of renderSample("preview-ready", "light").html.matchAll(/<img [^>]*alt="([^"]*)"/g)) expect(["", "Dockify website", "GitHub"]).toContain(img[1]);
  });

  it("links the footer icons to the project, with their images still served by the instance", () => {
    const m = passwordReset({ instanceName: "Dockify", origin: "https://d.example.com", url: "https://d.example.com/reset/t" }, "light");
    expect(m.html).toContain('<a href="https://github.com/kedarpixels/Dockify" target="_blank"');
    expect(m.html).toContain('<a href="https://dockify.sh/" target="_blank"');
    expect(m.html).not.toMatch(/<a href="https:\/\/d\.example\.com\/?" target="_blank"/);
    expect(m.html).toContain('src="https://d.example.com/dk-s-github.png"');
    expect(m.html).toContain('src="https://d.example.com/dk-s-web.png"');
    expect(m.text).toContain("GitHub: https://github.com/kedarpixels/Dockify");
    expect(m.text).toContain("Website: https://dockify.sh");
  });

  it("swaps every themed image in dark, and never lets a client without the swap show both", () => {
    const light = renderSample("password-reset", "light").html;
    expect(light).not.toContain(".dk-l{display:none");
    expect(renderSample("password-reset", "dark").html).toContain(".dk-l{display:none!important}");
    expect(renderSample("password-reset", "auto").html).toContain("[data-ogsc] .dk-l{display:none!important}");
    // Every dark image starts hidden, inline, and behind Outlook's conditional.
    for (const m of light.matchAll(/<img class="dk-(?:d|db)[ "][^>]*>/g)) expect(m[0]).toContain("display:none;mso-hide:all");
    expect(light).toContain("<!--[if !mso]><!-->");
  });

  it("draws the arrow's gap into the image, with no margin a client could drop", () => {
    const m = passwordReset({ instanceName: "Dockify", origin: "https://d.example.com", url: "https://d.example.com/reset/t" }).html;
    expect(m).toMatch(/Choose a new password<img src="https:\/\/d\.example\.com\/dk-arrow-gap\.png" width="24" height="16"/);
    expect(m).not.toMatch(/margin:-/);
  });

  it("never names a Windows or system UI face in the font stack", () => {
    for (const name of SAMPLES) expect(renderSample(name, "light").html, name).not.toMatch(/Segoe|BlinkMac|-apple-system|Roboto/);
  });

  it("says what a preview runs with, and never claims a database it does not have", () => {
    const input = { instanceName: "Dockify", origin: "https://d.example.com", state: "ready", repo: "a/b", prNumber: 1, title: "t", branch: "b", commit: null, author: null, fromFork: false, lines: [], previewUrl: null, dashboardUrl: "https://d.example.com/p", reason: null, recipient: "admin", baseEnvironment: "production" } as const;
    const own = previewNotice({ ...input, isolation: "own", isolatedDb: false }).text;
    expect(own).not.toContain("environment's services");
    expect(own).toMatch(/Database\W+None/);
    expect(own).toContain("No secrets or services, so an app that needs them fails here");
    const ownDb = previewNotice({ ...input, isolation: "own", isolatedDb: true }).text;
    expect(ownDb).toContain("Its own temporary database");
    expect(ownDb).toContain("No secrets or services");
    const allowed = previewNotice({ ...input, isolation: "base", isolatedDb: false }).text;
    expect(allowed).toContain("The production environment's services");
    expect(allowed).not.toContain("No secrets or services");
    const fork = previewNotice({ ...input, fromFork: true, isolation: "fork", isolatedDb: false }).text;
    expect(fork).not.toContain("environment's services");
  });

  it("keeps a stranger's text inert in a preview email", () => {
    const base = {
      instanceName: "Dockify", origin: "https://d.example.com", state: "failed", repo: "a/b", prNumber: 7, title: "<img src=x>", branch: "<b>x</b>", commit: "abcdef1234", author: "x",
      fromFork: true, isolatedDb: false, isolation: "fork", baseEnvironment: "production", previewUrl: null, dashboardUrl: "https://d.example.com/projects/p?tab=previews", reason: "<script>r</script>",
      lines: ["<script>l</script>", ...Array.from({ length: 30 }, (_, i) => `line ${i}`)], recipient: "admin",
    } as const;
    const m = previewNotice(base);
    for (const bad of ["<script>", "<img src=x>", "<b>x</b>"]) expect(m.html).not.toContain(bad);
    expect(m.html).toContain("&lt;script&gt;r&lt;/script&gt;");
    // Capped to the last lines, the commit short.
    expect(m.html).toContain("line 29");
    expect(m.html).not.toContain("line 10<");
    expect(m.html).toContain(">abcdef1<");
    // No preview address: Open in Dockify is the button; no Open preview to a page that is not there.
    expect(m.html).not.toContain("Open preview");
    expect(m.html).toMatch(/Open in Dockify<img/);
    expect(m.text).toContain("Fork: Built from a fork");
    expect(m.html).toContain("the pull request&#39;s author is not a member");
  });

  it("offers Open preview when ready, and says which database it uses", () => {
    const m = renderSample("preview-ready", "light");
    expect(m.subject).toBe("Preview ready: horseai/web #42 Fix the header on mobile");
    expect(m.html).toMatch(/href="https:\/\/pr-42-web\.preview\.example\.com\/"[^>]*>Open preview/);
    expect(m.html).toContain(">Open in Dockify</a>");
    expect(m.text).toContain("Database: Its own temporary database, separate from your real data");
    expect(renderSample("preview-failed", "light").text).toContain("Last build lines:");
  });

  it("keeps a single clear call to action", () => {
    const m = alert({ instanceName: "Dockify", kind: "deployFailed", state: "firing", title: "Deploy failed", detail: "build exited 1", where: "horseai / web", at: new Date(0), url: "https://d.example.com/deployments/1" });
    expect(count(m.html, 'class="dk-btn"')).toBe(1);
    expect(m.subject).toBe("Firing: Deploy failed, horseai / web");
  });

  it("falls back to drawn brand marks and no asset fetches when there is no origin", () => {
    for (const origin of [undefined, "", "not a url", "ftp://files.example.com"]) {
      const m = alert({ instanceName: "Dockify", origin, kind: "appDown", state: "firing", title: "App down", detail: "d", where: PLACE, at: new Date(0), url: "https://d.example.com/alerts" });
      expect(m.html, String(origin)).not.toContain("@font-face");
      expect(m.html, String(origin)).not.toMatch(/<img/);
      expect(m.html, String(origin)).not.toContain("background-image");
      expect(m.html, String(origin)).toMatch(/>D<\/td>/);
      // The dither bands keep their solid colour, and the chip keeps its names and dividers.
      expect(m.html, String(origin)).toContain('class="dk-dither" bgcolor="#f5f5f5"');
      expect(m.html, String(origin)).toContain(">horseai</span>");
      expect(count(m.html, 'class="dk-div"'), String(origin)).toBe(2);
    }
  });

  it("normalises the origin before building asset URLs", () => {
    const m = alert({ instanceName: "Dockify", origin: " https://d.example.com/some/path/ ", kind: "appDown", state: "firing", title: "App down", detail: "d", where: "w", at: new Date(0), url: "https://d.example.com/alerts" });
    expect(m.html).toContain('src="https://d.example.com/dk-logo.png"');
    expect(m.html).toContain("url('https://d.example.com/geist-sans.woff2')");
    expect(m.html).toContain("url('https://d.example.com/geist-pixel.woff2')");
    expect(m.html).not.toMatch(/example\.com\/\/|some\/path\/dk-/);
  });

  it("references only assets the dashboard actually serves", () => {
    const pub = fileURLToPath(new URL("../../../apps/web/public/", import.meta.url));
    const seen = new Set<string>();
    for (const name of SAMPLES) for (const theme of ["light", "dark"] as const) {
      for (const m of renderSample(name, theme).html.matchAll(/https:\/\/dockify\.example\.com\/([A-Za-z0-9._-]+\.(?:png|woff2))/g)) seen.add(m[1]!);
    }
    expect(seen.size).toBeGreaterThan(10);
    for (const file of ["dk-dither-light.png", "dk-dither-dark.png", "dk-kind-web.png", "dk-sample-avatar.png", "geist-pixel.woff2"]) expect(seen.has(file), file).toBe(true);
    for (const file of seen) expect(existsSync(pub + file), file).toBe(true);
  });

  it("maps every fact label to its icon, the order sensitive ones included", () => {
    const want: Record<string, FactIcon> = {
      Device: "device", "IP address": "ip", When: "time", Started: "time", Failed: "time", Resolved: "time", Expires: "time",
      App: "app", Where: "app", Source: "source", Role: "role", "Invited by": "user", "Sent by": "user",
      "New address": "mail", From: "mail", Why: "why", What: "why", Version: "version", Before: "version",
    };
    for (const [label, icon] of Object.entries(want)) expect(factIcon(label), label).toBe(icon);
  });

  it("shows the GitHub mark on a deploy's source only when the repository is on GitHub", () => {
    const base = { instanceName: "Dockify", origin: "https://d.example.com", where: PLACE, error: "e", source: "main, 4f2a9c1", at: new Date(0), url: "https://d.example.com/deployments/1" };
    expect(deployFailed({ ...base, github: true }).html).toContain("/dk-f-github.png");
    expect(deployFailed({ ...base, github: false }).html).toContain("/dk-f-source.png");
    expect(deployFailed({ ...base }).html).not.toContain("/dk-f-github.png");
  });

  it("draws the place as the dashboard's project chip: icon, name, EnvTag, app, parted by two dividers", () => {
    const m = failed({ ...PLACE, projectIcon: "https://d.example.com/api/icons/mail/p-token", appIcon: "https://d.example.com/api/icons/mail/a-token" });
    expect(m.subject).toBe("Deploy failed: horseai / production / web");
    expect(m.text).toContain("App: horseai / production / web");
    // The uploaded icons, rounded like the dashboard's; the project name and the app name in ink.
    expect(m.html).toMatch(/<img src="https:\/\/d\.example\.com\/api\/icons\/mail\/p-token" width="24" height="24" alt="" style="[^"]*border-radius:6px;">/);
    expect(m.html).toContain('src="https://d.example.com/api/icons/mail/a-token" width="24"');
    expect(m.html).toContain('<span class="dk-ink" style="font-family:\'Geist\',\'Helvetica Neue\',Helvetica,Arial,sans-serif;font-size:14px;line-height:20px;font-weight:500;color:#0a0a0a;vertical-align:middle">horseai</span>');
    // Production: the branch glyph, like every environment, and ink text.
    expect(m.html).toContain('src="https://d.example.com/dk-f-source.png" width="14"');
    expect(m.html).not.toContain('src="https://d.example.com/dk-f-ip.png" width="14"');
    expect(m.html).toMatch(/<span class="dk-ink" style="[^"]*font-size:13px;[^"]*">Production<\/span>/);
    // Two 1px by 16px hairlines in the frame's line colour (swapped for dark by class), 12px either side.
    expect(count(m.html, 'class="dk-div"')).toBe(2);
    expect(m.html).toContain('<td class="dk-div" style="vertical-align:middle;padding:0 12px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="1" height="16" class="dk-line" bgcolor="#e8e8e8" style="background-color:#e8e8e8;font-size:0;line-height:0;mso-line-height-rule:exactly;width:1px;height:16px;"></td></tr></table></td>');
    expect(m.html).toContain(".dk-line{background-color:#1e1e1e!important}");
    // No icons: the folder for the project, the kind tile for the app; another environment gets the branch glyph, muted.
    const plain = failed({ ...PLACE, env: "development", appKind: "backend" }).html;
    expect(plain).toContain("/dk-folder.png");
    expect(plain).toContain("/dk-kind-api.png");
    expect(plain).not.toContain("border-radius:6px");
    expect(plain).toContain("/dk-f-source.png");
    expect(plain).toMatch(/<span class="dk-muted" style="[^"]*font-size:13px;[^"]*">Development<\/span>/);
    expect(failed({ ...PLACE, env: "qa" }).html).toContain(">Qa</span>");
  });

  it("has a kind tile for every app kind", () => {
    const tiles: Record<AppKind, string> = { frontend: "web", backend: "api", bot: "bot", postgres: "postgres", redis: "redis", s3: "minio" };
    for (const [kind, tile] of Object.entries(tiles) as Array<[AppKind, string]>) expect(failed({ ...PLACE, appKind: kind }).html).toContain(`/dk-kind-${tile}.png`);
    expect(whereText({ ...PLACE, env: "development", appName: "api" })).toBe("horseai / development / api");
    expect(whereText("host")).toBe("host");
  });

  it("stacks facts and wraps the chip on phones, dividers hidden, so none can start a line", () => {
    const m = failed(PLACE).html;
    expect(m).toContain(".dk-lab{display:block!important;width:auto!important;padding:0 0 4px!important}.dk-val{display:block!important}");
    expect(m).toContain(".dk-div{display:none!important}.dk-seg{display:inline-block!important;padding:2px 14px 2px 0!important}");
    expect(count(m, 'class="dk-seg"')).toBe(3);
  });

  it("sends a security release as the update notice's red variant: summary, advisory link, facts, one button", () => {
    const base: UpdateNoticeInput = {
      instanceName: "Acme Cloud", origin: "https://d.example.com", event: "security", version: "1.4.1", from: "1.4.0", error: null, url: "https://d.example.com/server#updates",
      security: { level: "critical", summary: "A crafted request <b>could</b> read\nfiles.", advisory: "https://example.com/advisories/1", cves: ["CVE-2026-0000", "CVE-2026-0001"] },
    };
    const m = updateNotice(base, "light");
    expect(m.subject).toBe("Important security release: Dockify v1.4.1, Acme Cloud");
    expect(m.html).toContain(">Important security release</h1>");
    // The red key tile, the summary escaped and on one line, the severity, versions and CVE ids as facts.
    expect(m.html).toContain("/dk-badge-critical.png");
    expect(m.html).toContain("A crafted request &lt;b&gt;could&lt;/b&gt; read files.");
    expect(m.html).not.toContain("<b>could</b>");
    for (const fact of [">Critical<", ">v1.4.1<", ">v1.4.0<", ">CVE-2026-0000, CVE-2026-0001<"]) expect(m.html).toContain(fact);
    expect(m.html).toContain("/dk-f-why.png");
    expect(m.html).toContain("/dk-f-role.png");
    // The advisory is a secondary text link; the Server page stays the one button.
    expect(m.html).toMatch(/<a href="https:\/\/example\.com\/advisories\/1" target="_blank" rel="noopener" class="dk-link" style="[^"]*color:#0070f3;[^"]*">Read the advisory<\/a>/);
    expect(count(m.html, 'class="dk-btn"')).toBe(1);
    expect(m.html).toContain('href="https://d.example.com/server#updates"');
    expect(m.text).toContain("Read the advisory: https://example.com/advisories/1");
    expect(m.text).toContain("Dockify v1.4.1 fixes a security issue. It is rated critical: update this server as soon as you can.");
    expect(updateNotice(base, "dark").html).toContain(".dk-link{color:#52a8ff!important}");
    // Important reads calmer; no advisory and no CVE ids drop their lines.
    const imp = updateNotice({ ...base, security: { level: "important", summary: "Fix." } }, "light");
    expect(imp.text).toContain("It is rated important: update this server soon.");
    expect(imp.html).not.toContain("dk-link\"");
    expect(imp.html).not.toContain("/dk-f-role.png");
    for (const part of [m.subject, m.html, m.text, imp.html]) expect(DASHES.test(part)).toBe(false);
  });

  it("refuses a security notice without its block or with a link that is not https", () => {
    const base: UpdateNoticeInput = { instanceName: "Dockify", event: "security", version: "1.4.1", from: null, error: null, url: "https://d.example.com/server" };
    expect(() => updateNotice(base)).toThrow(/security block/);
    expect(() => updateNotice({ ...base, security: { level: "critical", summary: "x", advisory: "http://evil.example/a" } })).toThrow(/https/);
    expect(() => updateNotice({ ...base, security: { level: "critical", summary: "x", advisory: "javascript:alert(1)" } })).toThrow();
  });

  it("names a rollback target it does not know without a stray v", () => {
    const m = updateNotice({ instanceName: "Dockify", event: "rolled_back", version: "1.4.0", from: null, error: "health check failed", url: "https://d.example.com/server" });
    expect(m.subject).toContain("rolled back to the previous version");
    expect(m.subject).not.toContain("vthe");
  });
});

describe("helpers", () => {
  it("escapes, masks and formats", () => {
    expect(esc(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    expect(maskEmail("suvak@example.com")).toBe("s***@example.com");
    expect(maskEmail("nope")).toBe("***");
    expect(utcTime(new Date("2026-10-30T04:05:00Z"))).toBe("30 Oct 2026, 04:05 UTC");
  });
});
