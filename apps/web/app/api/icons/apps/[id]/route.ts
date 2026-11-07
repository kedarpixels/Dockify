import { proxyIcon } from "@/lib/pages/icons";

/** One app's icon image, same origin, so the console's img-src never reaches the API directly. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return proxyIcon({ target: "app", id: (await params).id }, new URL(req.url).searchParams.get("v"), req.headers.get("if-none-match"));
}
