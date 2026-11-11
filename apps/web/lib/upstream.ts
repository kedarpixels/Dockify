import "server-only";
import { headers } from "next/headers";
import { forwardedHeaders, type ForwardOptions } from "./forwarded";

/** The visitor's cookie, client address and user agent (lib/forwarded.ts), plus `extra`. */
export async function upstreamHeaders(extra: Record<string, string> = {}, opts: ForwardOptions = {}): Promise<Record<string, string>> {
  return { ...forwardedHeaders(await headers(), opts), ...extra };
}
