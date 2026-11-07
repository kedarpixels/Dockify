/* SEO constants: the site title, description and origin. */

/** Public origin of the site. Set SITE_URL at build time; the domain is dockify.sh. */
export const SITE_URL = (process.env.SITE_URL ?? "https://dockify.sh").replace(/\/+$/, "");

/** Host shown on the social cards, derived from SITE_URL. */
export const SITE_HOST = new URL(SITE_URL).host;

export const SITE_NAME = "Dockify";
export const SITE_TITLE = "Dockify: open-source control plane for one server";
export const SITE_DESCRIPTION =
  "Deploy from GitHub, add domains, run databases and keep encrypted, tested backups on your own VPS. Health-checked deploys that roll back on their own.";
export const SITE_TAGLINE = "Open-source control plane for one server.";

/**
 * SITE_NOINDEX=1 at build time keeps a staging or pre-launch deploy out of search engines:
 * robots.txt disallows everything and every page carries noindex. The brief says the site must not
 * go live until each claim passes on a real server, so set it on every deploy until then.
 */
export const NOINDEX = process.env.SITE_NOINDEX === "1" || process.env.SITE_NOINDEX === "true";

