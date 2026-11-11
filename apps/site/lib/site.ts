import type { IconName } from "@/components/icon";

/** The public GitHub repository. When unset or invalid, every GitHub link on the site is hidden or worded without a link. */
const REPO_URL: string | null = "https://github.com/kedarpixels/Dockify";

/** Set to true once GitHub Discussions is switched on for the repository. */
const DISCUSSIONS_ON = false;

function validRepo(url: string | null): string | null {
  const u = url?.trim().replace(/\/+$/, "") ?? "";
  return /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/.test(u) ? u : null;
}

/** The repository, only when REPO_URL names a real one (owner and name on github.com). */
export const REPO: string | null = validRepo(REPO_URL);

/** A link inside the repository, such as repoHref("blob/main/installer/install.sh"), or null. */
export function repoHref(sub?: string): string | null {
  if (!REPO) return null;
  return sub ? `${REPO}/${sub.replace(/^\//, "")}` : REPO;
}

/** dockify.sh serves the bootstrap (installer/bootstrap.sh), which verifies and runs the full installer as root. */
export const INSTALL_CMD = "curl -fsSL https://dockify.sh/install.sh | sh";

/** The install with a flag: flags pass through the pipe after `sh -s --`. */
export const INSTALL_DRY_RUN_CMD = "curl -fsSL https://dockify.sh/install.sh | sh -s -- --dry-run";

/** The bootstrap (installer/uninstall-bootstrap.sh) verifies and runs installer/uninstall.sh as root. */
export const UNINSTALL_CMD = "curl -fsSL https://dockify.sh/uninstall.sh | sh";

export type NavLink = { href: string; label: string; icon?: IconName; external?: boolean };

const github: NavLink[] = REPO ? [{ href: REPO, label: "GitHub", icon: "github", external: true }] : [];

export const TOP_NAV: NavLink[] = [
  { href: "/docs", label: "Docs", icon: "book" },
  { href: "/compare", label: "Compare", icon: "layers" },
  { href: "/changelog", label: "Changelog", icon: "history" },
  { href: "/security", label: "Security", icon: "shield" },
  ...github,
];

/** Repository links appear once REPO is set. */
export const FOOTER_NAV: { title: string; links: NavLink[] }[] = [
  {
    title: "Product",
    links: [
      { href: "/install", label: "Install" },
      { href: "/docs", label: "Docs" },
      { href: "/compare", label: "Compare" },
      { href: "/changelog", label: "Changelog" },
    ],
  },
  {
    title: "Trust",
    links: [
      { href: "/security", label: "Security" },
      { href: "/security#report", label: "Report a vulnerability" },
      { href: "/open-source", label: "Open source" },
      { href: "/open-source#license", label: "License" },
    ],
  },
  {
    title: "Community",
    links: [
      ...github,
      ...(REPO ? [{ href: `${REPO}/issues`, label: "Issues", external: true }] : []),
      ...(REPO && DISCUSSIONS_ON ? [{ href: `${REPO}/discussions`, label: "Discussions", external: true }] : []),
      { href: "/docs/contributing", label: "Contributing" },
    ],
  },
];

/** True when `href` is the current page or a section above it. */
export function isActive(path: string, href: string) {
  if (href.startsWith("http")) return false;
  return href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
}
