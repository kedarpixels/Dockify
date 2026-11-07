/**
 * Vercel's Logs tab for a deployment, from its inspector address. Inspector pages live at
 * vercel.com/<team>/<project>/<id> and the tab at vercel.com/<team>/<project>/logs. Null when the
 * address is not of that form; the API only stores https addresses on vercel.com.
 */
export function vercelLogsHref(inspector: string | null): string | null {
  if (!inspector) return null;
  try {
    const u = new URL(inspector);
    const [team, project] = u.pathname.split("/").filter(Boolean);
    return u.protocol === "https:" && u.hostname === "vercel.com" && team && project ? `https://vercel.com/${team}/${project}/logs` : null;
  } catch {
    return null;
  }
}

/** "web-abc.vercel.app" for a link's text; the address itself when it does not parse. */
export function hostOfUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
