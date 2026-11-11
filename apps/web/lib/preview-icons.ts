import type { FaviconApp, IconBody, IconMap, IconState, IconTarget } from "./icons";

// Fictional favicons for a few fixture frontends, drawn here as SVG; nothing is fetched.

interface PreviewFavicon {
  project: string;
  name: string;
  host: string;
  letter: string;
  color: string;
  version: string;
}

const FAVICONS: Record<string, PreviewFavicon> = {
  app_0: { project: "horseai", name: "Storefront", host: "horseai.example", letter: "H", color: "#2563eb", version: "5f1c0a9e27b4" },
  app_2: { project: "horseai", name: "admin", host: "admin.horseai.example", letter: "A", color: "#0f766e", version: "8d03e6b2c91f" },
  app_18: { project: "fieldnote", name: "web", host: "fieldnote.example", letter: "F", color: "#c2410c", version: "1b7e4d0a6c38" },
  app_21: { project: "fieldnote", name: "admin", host: "admin.fieldnote.example", letter: "N", color: "#7c3aed", version: "e94a2f5c0b17" },
};

/** The one project the preview shows on an app's favicon; every other project shows the folder. */
const CHOSEN: Record<string, string> = { horseai: "app_0" };

const facts = (f: PreviewFavicon) => ({ origin: `https://${f.host}/favicon.png`, fetchedAt: "2026-10-17T06:12:00.000Z", checkedAt: "2026-10-17T06:12:00.000Z", error: null });
const imageOf = (f: PreviewFavicon) => ({ version: f.version, source: "favicon" as const, width: 64, height: 64 });
const appsOf = (project: string): FaviconApp[] =>
  Object.entries(FAVICONS)
    .filter(([, f]) => f.project === project)
    .map(([id, f]) => ({ id, name: f.name, environment: "production", host: f.host }));

function projectState(project: string, pick: string | null): IconState {
  const f = pick ? FAVICONS[pick] : undefined;
  return {
    choice: "auto",
    image: f ? imageOf(f) : null,
    favicon: f ? { ...facts(f), checkedAt: null } : null,
    borrow: { mode: pick ? "app" : "folder", pick, from: f ? pick : null, apps: appsOf(project) },
  };
}

export function previewIconMap(): IconMap {
  const apps = Object.fromEntries(Object.entries(FAVICONS).map(([id, f]) => [id, { choice: "auto" as const, image: imageOf(f), favicon: facts(f) }]));
  const projects = Object.fromEntries([...new Set(Object.values(FAVICONS).map((f) => f.project))].map((p) => [p, projectState(p, CHOSEN[p] ?? null)]));
  return { apps, projects };
}

/** What an icon write answers in the preview. Nothing is kept: the next page load shows the fixture again. */
export function previewIconWrite(t: IconTarget, body: IconBody): IconState {
  if (body.choice === "upload") return { choice: "upload", image: null, favicon: null, ...(t.target === "project" ? { borrow: { mode: "upload" as const, pick: null, from: null, apps: appsOf(t.slug) } } : {}) };
  if (t.target === "project") return projectState(t.slug, body.choice === "app" && FAVICONS[body.appId]?.project === t.slug ? body.appId : null);
  return previewIconMap().apps[t.id] ?? { choice: "auto", image: null, favicon: null };
}

/** The SVG behind a preview icon URL, or null when that icon shows its default. */
export function previewIconSvg(t: IconTarget, version: string | null): string | null {
  // A project's URL carries the version of the favicon it shows, which names the app chosen.
  const f = t.target === "app" ? FAVICONS[t.id] : Object.values(FAVICONS).find((x) => x.project === t.slug && x.version === version);
  if (!f) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${f.color}"/><text x="32" y="43" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="32" font-weight="700" fill="#fff">${f.letter}</text></svg>`;
}
