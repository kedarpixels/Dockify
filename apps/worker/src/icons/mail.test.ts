import { describe, expect, it } from "vitest";
import { mailIconLinks, mailIconSigner } from "./mail.ts";

const PROJECT = "0f0e0d0c-0000-4000-8000-0000000000cc";
const SITE = "0f0e0d0c-0000-4000-8000-0000000000d2";
const favicon = { id: "fav", source: "favicon" as const, mime: "image/png", sha256: "a".repeat(64), width: 32, height: 32, origin: "https://brand.example/favicon.png", updatedAt: new Date(0) };
const project = (iconAppId: string | null, icon = favicon) => ({
  id: PROJECT, iconChoice: "auto" as const, iconAppId, icons: [],
  environments: [{ name: "production", apps: [{ id: SITE, name: "web", displayName: null, createdAt: new Date(0), primaryDomain: { hostname: "brand.example", testDomain: false }, domains: [], icons: [icon] }] }],
});

describe("mail icon links", () => {
  const key = mailIconSigner("internal-token-for-tests");

  it("gives a project on the folder no link, so the email shows the folder", () => {
    expect(mailIconLinks("https://dockify.example.com", key, null, project(null)).projectIcon).toBeNull();
  });

  it("links a project to the favicon of the app the owner chose", () => {
    expect(mailIconLinks("https://dockify.example.com", key, null, project(SITE)).projectIcon).toMatch(/^https:\/\/dockify\.example\.com\/api\/icons\/mail\/p/);
  });

  it("gives an SVG icon no link, so an email or a pull request comment shows its fallback, not a broken image", () => {
    const svg = { ...favicon, mime: "image/svg+xml" };
    const app = (icon: typeof favicon) => ({ id: SITE, iconChoice: "auto" as const, icons: [icon] });
    expect(mailIconLinks("https://dockify.example.com", key, app(svg), project(SITE, svg))).toEqual({ projectIcon: null, appIcon: null });
    // Only the SVG loses its link: a raster app icon under a project showing an SVG is still linked.
    expect(mailIconLinks("https://dockify.example.com", key, app(favicon), project(SITE, svg))).toMatchObject({ projectIcon: null, appIcon: expect.stringContaining("/api/icons/mail/a") });
  });
});
