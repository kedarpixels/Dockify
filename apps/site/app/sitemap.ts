import type { MetadataRoute } from "next";
import { SITE_URL } from "@/components/seo/config";
import { DOC_PAGES } from "@/lib/docs-nav";

/* Every public page: the marketing routes, the docs home and each docs page in sidebar order.
   No lastModified: there is no real per-page date to give yet, and a made-up one helps nobody. */
const ROUTES: { path: string; priority: number }[] = [
  { path: "/", priority: 1 },
  { path: "/install", priority: 0.9 },
  { path: "/docs", priority: 0.9 },
  { path: "/compare", priority: 0.7 },
  { path: "/security", priority: 0.6 },
  { path: "/open-source", priority: 0.5 },
  { path: "/changelog", priority: 0.5 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    ...ROUTES.map(({ path, priority }) => ({ url: `${SITE_URL}${path === "/" ? "" : path}`, priority })),
    ...DOC_PAGES.map((d) => ({ url: `${SITE_URL}/docs/${d.slug}`, priority: 0.6 })),
  ];
}
