/* The docs sidebar, in reading order; prev and next follow it. Every slug has a file at content/docs/<slug>.mdx. */

export type DocLink = { slug: string; title: string; href?: string };
export type DocGroup = { title: string; items: DocLink[] };

export const DOCS_NAV: DocGroup[] = [
  {
    title: "Start",
    items: [
      { slug: "getting-started", title: "Getting started" },
      { slug: "install", title: "Install" },
      { slug: "github", title: "Connect GitHub" },
      { slug: "first-deploy", title: "First deploy" },
    ],
  },
  {
    title: "Run",
    items: [
      { slug: "projects-and-apps", title: "Projects and apps" },
      { slug: "sources", title: "Deploy sources" },
      { slug: "scheduled-jobs", title: "Scheduled jobs" },
      { slug: "env-vars", title: "Environment variables" },
      { slug: "domains", title: "Domains and TLS" },
      { slug: "templates", title: "Templates" },
      { slug: "databases", title: "Databases" },
      { slug: "previews", title: "Pull request previews" },
      { slug: "terminal", title: "Web terminal" },
    ],
  },
  {
    title: "Protect",
    items: [
      { slug: "backups", title: "Backups and restore" },
      { slug: "security", title: "Security model" },
      { slug: "recovery", title: "Recovery" },
      { slug: "teams-and-roles", title: "Teams and roles" },
    ],
  },
  {
    title: "Operate",
    items: [
      { slug: "rollback", title: "Deploys and rollback" },
      { slug: "logs-and-metrics", title: "Logs and metrics" },
      { slug: "alerts", title: "Alerts" },
      { slug: "email", title: "Email" },
      { slug: "updates", title: "Updates" },
    ],
  },
  {
    title: "Automate",
    items: [
      { slug: "api", title: "API and tokens" },
      { slug: "cli", title: "The dockify command" },
      { slug: "vercel", title: "Vercel import" },
    ],
  },
  {
    title: "Help",
    items: [
      { slug: "troubleshooting", title: "Troubleshooting" },
      { slug: "uninstall", title: "Uninstall" },
      { slug: "faq", title: "FAQ" },
      { slug: "changelog", title: "Changelog", href: "/changelog" },
    ],
  },
  {
    title: "Project",
    items: [
      { slug: "license", title: "License" },
      { slug: "contributing", title: "Contributing" },
    ],
  },
];

export const docHref = (d: DocLink) => d.href ?? `/docs/${d.slug}`;

/** Every page that lives under /docs, flat, in sidebar order. */
export const DOC_PAGES: DocLink[] = DOCS_NAV.flatMap((g) => g.items).filter((d) => !d.href);

/** Previous and next docs page around `slug` (the docs home leads into the first page). */
export function neighbours(slug: string | null) {
  if (slug === null) return { prev: undefined, next: DOC_PAGES[0] };
  const i = DOC_PAGES.findIndex((d) => d.slug === slug);
  return {
    prev: i > 0 ? DOC_PAGES[i - 1] : i === 0 ? { slug: "", title: "Introduction", href: "/docs" } : undefined,
    next: i >= 0 ? DOC_PAGES[i + 1] : undefined,
  };
}
