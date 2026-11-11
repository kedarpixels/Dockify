import type { IconName } from "@/components/icon";

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
}

export const MAIN_NAV: NavItem[] = [
  { href: "/", label: "Overview", icon: "overview" },
  { href: "/projects", label: "Projects", icon: "folder" },
  { href: "/deployments", label: "Deployments", icon: "deploy" },
  { href: "/logs", label: "Logs", icon: "logs" },
  { href: "/resources", label: "Resources", icon: "database" },
  { href: "/domains", label: "Domains", icon: "globe" },
  { href: "/activity", label: "Activity", icon: "activity" },
  { href: "/alerts", label: "Alerts", icon: "bell" },
];

export const SYSTEM_NAV: NavItem[] = [
  { href: "/server", label: "Server", icon: "server" },
  { href: "/backups", label: "Backups", icon: "archive" },
  { href: "/settings", label: "Settings", icon: "settings" },
];

/** A nav entry is current on its own page and on any page under it; Overview only on "/". */
export const isNavActive = (path: string, href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));

export const DOCS_URL = "https://dockify.sh/docs";
