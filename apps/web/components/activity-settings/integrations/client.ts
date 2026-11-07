import type { Dispatch, SetStateAction } from "react";
import { callJson } from "@/lib/client-api";
import type { IntegrationsAnswer } from "@/lib/pages/integrations";
import type { OverviewSource } from "@/lib/types";

/* Browser side of Integrations: calls to the same-origin proxy (app/api/integrations). Secrets go
   out in request bodies only; nothing that comes back ever holds one. */

type IntCall<T> = { ok: true; source: OverviewSource; data: T } | { ok: false; source: OverviewSource; error: string; status: number; code?: string };

/**
 * One call to app/api/integrations. Never throws. A refusal keeps the route's `code`, so a write
 * wrapped in `elevate` (components/step-up) can ask "Confirm it is you" when the API wants a step-up.
 */
export async function intFetch<T>(path: string, init?: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown }): Promise<IntCall<T>> {
  const r = await callJson<IntegrationsAnswer<T>>(`/api/integrations${path}`, { method: init?.method ?? "GET", body: init?.body });
  if (r.ok && r.data && r.data.data !== null) return { ok: true, source: r.data.source, data: r.data.data };
  if (r.ok) return { ok: false, source: r.data?.source ?? "api", status: r.status, error: r.data?.error ?? "The API sent no answer" };
  const source = typeof r.body?.source === "string" ? (r.body.source as OverviewSource) : "api";
  return { ok: false, source, status: r.status, error: r.error, code: r.code };
}

/** For toast.promise: resolves with the data, rejects with the error text. */
export async function intOrThrow<T>(call: Promise<IntCall<T>>): Promise<T> {
  const r = await call;
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

/** "a, b and c". */
export const listing = (parts: string[]) => (parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);

/** The list with this row in place of its old self, or added last. */
export const upsert = <T extends { id: string }>(list: T[], row: T): T[] => (list.some((x) => x.id === row.id) ? list.map((x) => (x.id === row.id ? row : x)) : [...list, row]);

/** What a card gets to change its slice of the summary. */
export type Setter<T> = Dispatch<SetStateAction<T>>;
