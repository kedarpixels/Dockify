import { buildSearchIndex } from "@/components/docs/search-index";

/* The docs search index as a static file, written once at build time. */
export const dynamic = "force-static";

export async function GET() {
  return Response.json(await buildSearchIndex());
}
