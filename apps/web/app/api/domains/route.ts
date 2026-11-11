import { guardWrite, refuse } from "@/lib/http";
import { forward, readAddDomain } from "@/lib/pages/resources-domains";

export async function POST(request: Request) {
  const refused = guardWrite(request);
  if (refused) return refused;
  const input = await readAddDomain(request);
  if (typeof input === "string") return refuse(400, input);
  return forward("POST", "/api/v1/domains", input);
}
