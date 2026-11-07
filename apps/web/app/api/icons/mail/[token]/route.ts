import { proxyMailIcon } from "@/lib/pages/icons";

/**
 * One signed mail icon link, same origin, no session: a mail client fetching an email's project or
 * app icon has no cookie, and the token in the path is the whole credential (the API checks it).
 */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  return proxyMailIcon((await params).token, req.headers.get("if-none-match"));
}
