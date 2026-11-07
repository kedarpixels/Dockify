import { json } from "@/lib/http";
import { getSecurityAlert } from "@/lib/pages/security-release";

/** The pending security release and this member's reminder, polled by the console's banner. */
export async function GET() {
  return json(await getSecurityAlert());
}
