import { describe, expect, it } from "vitest";
import { isCustomHost, projectFavicon, projectFaviconApp, rankFaviconApps, shownProjectIcon, type FaviconApp, type IconImageRow } from "./icons.ts";

const img = (id: string, source: "favicon" | "upload" = "favicon"): IconImageRow => ({
  id, source, sha256: id.padEnd(64, "0"), width: 32, height: 32, origin: null, updatedAt: new Date(0),
});
const app = (id: string, born: number, primary: string | null, opts: { test?: boolean; domains?: string[]; fav?: boolean } = {}): FaviconApp => ({
  id, name: id, createdAt: new Date(born * 1000),
  primaryDomain: primary ? { hostname: primary, testDomain: !!opts.test } : null,
  domains: (opts.domains ?? []).map((hostname) => ({ hostname, testDomain: false })),
  icons: opts.fav === false ? [] : [img(`fav-${id}`)],
});
const project = (envs: Record<string, FaviconApp[]>, iconAppId: string | null = null) => ({
  iconChoice: "auto" as const, iconAppId, icons: [] as IconImageRow[],
  environments: Object.entries(envs).map(([name, apps]) => ({ name, apps })),
});

describe("project favicon pick", () => {
  it("prefers the production frontend on a custom primary domain over an older admin panel on a test domain", () => {
    const p = project({ production: [app("dashboard", 1, "dashboard-4f5e6d.203-0-113-10.sslip.io", { test: true }), app("frontend", 2, "brand.example")] });
    expect(projectFaviconApp(p)?.id).toBe("frontend");
    expect(projectFavicon(p)?.id).toBe("fav-frontend");
  });

  it("ranks: production on a custom primary, then any custom domain (production first), then by creation", () => {
    const p = project({
      development: [app("dev-custom", 1, "dev.shop.com"), app("dev-test", 0, "dev-1.1-2-3-4.sslip.io", { test: true })],
      production: [
        app("prod-old-test", 0, "web-1.1-2-3-4.sslip.io", { test: true }),
        app("prod-side", 3, "web-2.1-2-3-4.sslip.io", { test: true, domains: ["shop.com"] }),
        app("prod-main", 5, "www.shop.com"),
        app("prod-none", 2, null),
      ],
    });
    expect(rankFaviconApps(p).map((a) => a.id)).toEqual(["prod-main", "prod-side", "dev-custom", "dev-test", "prod-old-test", "prod-none"]);
  });

  it("gives the same answer whatever order the environments come in", () => {
    const a = app("a", 1, null);
    const b = app("b", 1, null);
    expect(projectFaviconApp(project({ production: [a], development: [b] }))?.id).toBe(projectFaviconApp(project({ development: [b], production: [a] }))?.id);
  });

  it("treats spelled-address names as test domains, flagged or not", () => {
    expect(isCustomHost({ hostname: "brand.example", testDomain: false })).toBe(true);
    expect(isCustomHost({ hostname: "x.203-0-113-10.sslip.io", testDomain: false })).toBe(false);
    expect(isCustomHost({ hostname: "x.1-2-3-4.nip.io", testDomain: false })).toBe(false);
    expect(isCustomHost({ hostname: "shop.example.com", testDomain: true })).toBe(false);
    expect(isCustomHost(null)).toBe(false);
  });

  it("skips frontends with no favicon and answers null when none has one", () => {
    expect(projectFaviconApp(project({ production: [app("a", 0, "shop.com", { fav: false }), app("b", 1, null)] }))?.id).toBe("b");
    expect(projectFavicon(project({ production: [app("a", 0, "shop.com", { fav: false })] }))).toBeNull();
  });

  it("uses the owner's pick while it has a favicon, else falls back to the automatic pick", () => {
    const envs = { production: [app("dashboard", 1, "d.1-2-3-4.sslip.io", { test: true }), app("frontend", 2, "brand.example")] };
    expect(projectFaviconApp(project(envs, "dashboard"))?.id).toBe("dashboard");
    expect(projectFaviconApp(project({ production: [app("dashboard", 1, null, { fav: false }), app("frontend", 2, "brand.example")] }, "dashboard"))?.id).toBe("frontend");
    expect(projectFaviconApp(project(envs, "gone"))?.id).toBe("frontend");
  });

  it("shows the upload when chosen, and never a favicon in its place", () => {
    const envs = { production: [app("frontend", 1, "shop.com")] };
    expect(shownProjectIcon({ ...project(envs), iconChoice: "upload", icons: [img("up", "upload")] })?.id).toBe("up");
    expect(shownProjectIcon({ ...project(envs), iconChoice: "upload" })).toBeNull();
    expect(shownProjectIcon(project(envs))?.id).toBe("fav-frontend");
  });
});
