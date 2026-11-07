import { proxyWebhookIcon } from "@/lib/pages/webhook-icon";

/** One generic webhook's logo or site icon, same origin, so the console's img-src never reaches the API directly. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return proxyWebhookIcon((await params).id, new URL(req.url).searchParams.get("v"), req.headers.get("if-none-match"));
}
