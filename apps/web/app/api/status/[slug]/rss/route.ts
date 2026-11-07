import { NO_STORE } from "@/lib/http";
import { getStatusPage, INCIDENT_LABEL, PUBLIC_CACHE } from "@/lib/pages/status-page";
import { requestOrigin } from "@/lib/request-origin";

/** XML text escaping; control characters other than tab and newline are dropped. */
const esc = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** GET /api/status/:slug/rss: the published incidents as RSS 2.0, newest first. */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await getStatusPage(slug);
  if (result.kind === "missing") return new Response("Not found", { status: 404, headers: { ...PUBLIC_CACHE, "content-type": "text/plain" } });
  if (result.kind === "error") return new Response("Status is unavailable right now", { status: 502, headers: { ...NO_STORE, "content-type": "text/plain" } });

  const { data } = result;
  const base = requestOrigin(request) ?? "";
  const page = `${base}/status/${data.slug}`;
  const items = data.incidents
    .map((i) => {
      const latest = i.updates[0];
      const body = i.updates.map((u) => `${INCIDENT_LABEL[u.status]}: ${u.body}`).join("\n\n");
      return [
        "<item>",
        `<title>${esc(`${i.title}, ${INCIDENT_LABEL[i.status].toLowerCase()}`)}</title>`,
        `<link>${esc(`${page}#incident-${i.key}`)}</link>`,
        `<guid isPermaLink="false">${esc(`${data.slug}-${i.key}-${latest?.at ?? i.startedAt}`)}</guid>`,
        `<pubDate>${new Date(latest?.at ?? i.startedAt).toUTCString()}</pubDate>`,
        `<description>${esc(body || i.title)}</description>`,
        "</item>",
      ].join("");
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>${esc(`${data.name} status`)}</title>
<link>${esc(page)}</link>
<description>${esc(`Incidents and maintenance for ${data.name}`)}</description>
<lastBuildDate>${new Date(data.updatedAt).toUTCString()}</lastBuildDate>
<ttl>5</ttl>
${items}
</channel>
</rss>
`;
  return new Response(xml, { headers: { ...PUBLIC_CACHE, "content-type": "application/rss+xml; charset=utf-8" } });
}
