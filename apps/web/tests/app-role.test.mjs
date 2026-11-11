// What an app reads as: its kind, or for a published image what that image is. Run: npm test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { appRole, imageRepo } from "../lib/app-role.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("built code and managed services read as their kind", () => {
  assert.deepEqual(appRole("backend", null), { preset: "api", label: "Backend" });
  assert.deepEqual(appRole("backend"), { preset: "api", label: "Backend" });
  assert.deepEqual(appRole("frontend", null), { preset: "web", label: "Frontend" });
  // A managed service carries an image too, and stays what its kind says.
  assert.deepEqual(appRole("postgres", "postgres:17"), { preset: "postgres", label: "Postgres" });
  assert.deepEqual(appRole("redis", "redis:7.4-alpine"), { preset: "redis", label: "Redis" });
});

test("every catalog template's image says what it is, never Backend", () => {
  const want = {
    "chrislusf/seaweedfs:4.52": { preset: "storage", label: "Storage" },
    "louislam/uptime-kuma:2.5.9-rootless": { preset: "uptimekuma", label: "Monitoring" },
    "binwiederhier/ntfy:v2.37.2": { preset: "ntfy", label: "Notifications" },
    "gotify/server:3.1.1": { preset: "notify", label: "Notifications" },
    "neosmemo/memos:26.11.0": { preset: "notes", label: "Notes" },
    "miniflux/miniflux:2.3.5": { preset: "reader", label: "Feed reader" },
  };
  for (const [image, role] of Object.entries(want)) assert.deepEqual(appRole("backend", image), role, image);
  // The catalog itself: an image added there without a family still must not read as Backend.
  for (const file of ["gotify", "memos", "miniflux", "ntfy", "seaweedfs", "uptime-kuma"]) {
    const src = read(`../../api/src/modules/templates/catalog/${file}.ts`);
    const images = [...src.matchAll(/^\s+image: (\S+)$/gm)].map((m) => m[1]);
    assert.ok(images.length > 0, file);
    for (const image of images) assert.notEqual(appRole("backend", image).label, "Backend", image);
  }
});

test("any other published image is a Service, unless a narrower kind was chosen for it", () => {
  assert.deepEqual(appRole("backend", "ghcr.io/acme/api:1.4.2"), { preset: "service", label: "Service" });
  assert.deepEqual(appRole("bot", "ghcr.io/acme/discord-bot:latest"), { preset: "bot", label: "Bot" });
  assert.deepEqual(appRole("frontend", "nginx:1.29"), { preset: "web", label: "Frontend" });
  assert.deepEqual(appRole("frontend", "minio/minio:latest"), { preset: "minio", label: "Storage" });
});

test("reads the repository through a registry host, a port, a tag and a digest", () => {
  assert.equal(imageRepo("chrislusf/seaweedfs:4.52"), "chrislusf/seaweedfs");
  assert.equal(imageRepo("Registry.Example.com:5000/Team/SeaweedFS:4.52@sha256:abc"), "team/seaweedfs");
  assert.equal(imageRepo("localhost/redis"), "redis");
  assert.equal(imageRepo("redis@sha256:abc"), "redis");
  assert.equal(appRole("backend", "docker.io/library/postgres:17").label, "Postgres");
  assert.equal(appRole("backend", "quay.io/minio/minio").label, "Storage");
  // A family is the image's own name, not a word inside another name.
  assert.equal(appRole("backend", "acme/redis-exporter:1").label, "Service");
  assert.equal(appRole("backend", "acme/gotify:1").label, "Service");
});

test("every preset a role can name has a glyph and a hue in both themes", () => {
  const tile = read("../components/icons/preset-tile.tsx");
  const css = read("../app/styles/icons.css");
  const tokens = read("../app/styles/foundation.css");
  const presets = [...read("../lib/icons.ts").match(/export type IconPreset =([^;]+);/)[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(presets.includes("storage") && presets.includes("service"));
  for (const p of presets) {
    assert.ok(tile.includes(`  ${p}: (`), `glyph ${p}`);
    // The api hue is the tile's own default.
    if (p !== "api") assert.ok(css.includes(`[data-hue="${p}"]`), `hue ${p}`);
  }
  for (const hue of ["storage", "monitor", "notify", "service"]) {
    assert.equal(tokens.split(`--tile-${hue}-top:`).length - 1, 2, `${hue} in light and dark`);
  }
});

test("the icon and the label come from the same role", () => {
  const icon = read("../components/icons/app-icon.tsx");
  assert.match(icon, /role\.preset/);
  for (const f of ["projects/project-card.tsx", "projects/project-list.tsx", "project-detail/project-view.tsx", "project-detail/app-view.tsx", "resources-domains/resources-view.tsx", "icons/icon-card.tsx"]) {
    assert.match(read(`../components/${f}`), /useAppRole\(\)/, f);
  }
});
