import { proxyIcon } from "@/lib/pages/icons";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  return proxyIcon({ target: "project", slug: (await params).slug }, new URL(req.url).searchParams.get("v"), req.headers.get("if-none-match"));
}
