import "server-only";
import { headers } from "next/headers";
import { forwardedHeaders, type ForwardOptions } from "./forwarded";

/**
 * The headers for one call to the Dockify API from a server loader, route handler or action: the
 * visitor's cookie, client address and user agent (lib/forwarded.ts), plus `extra`. Every call goes
 * through lib/api.ts, which builds its headers here, so none can forget the client address again.
 */
export async function upstreamHeaders(extra: Record<string, string> = {}, opts: ForwardOptions = {}): Promise<Record<string, string>> {
  return { ...forwardedHeaders(await headers(), opts), ...extra };
}
