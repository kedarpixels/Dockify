import { proxyMailIcon } from "@/lib/pages/icons";

/** No session: a mail client has no cookie, and the token in the path is the whole credential (the API checks it). */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  return proxyMailIcon((await params).token, req.headers.get("if-none-match"));
}
