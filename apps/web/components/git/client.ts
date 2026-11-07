"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import { callJson } from "@/lib/client-api";
import type { GitAnswer, GitInstallation } from "@/lib/pages/git";
import type { OverviewSource } from "@/lib/types";

/* Browser side of the Git connection: calls to the same-origin proxy (app/api/git), the
   installations hook and the install hand-off. Nothing here ever holds a GitHub token. */

export type GitCall<T> =
  | { ok: true; source: OverviewSource; data: T }
  | { ok: false; source: OverviewSource; error: string; status: number; code?: string };

/**
 * One call to app/api/git. Never throws; an aborted call resolves to a failed answer nobody reads.
 * A refusal keeps the route's `code`, so a disconnect wrapped in `elevate` (components/step-up)
 * can ask "Confirm it is you" when the API wants a step-up.
 */
export async function gitFetch<T>(path: string, init?: { method?: "DELETE"; signal?: AbortSignal }): Promise<GitCall<T>> {
  const r = await callJson<GitAnswer<T>>(`/api/git${path}`, { method: init?.method ?? "GET", signal: init?.signal });
  if (r.ok && r.data && r.data.data !== null) return { ok: true, source: r.data.source, data: r.data.data };
  if (r.ok) return { ok: false, source: r.data?.source ?? "api", status: r.status, error: r.data?.error ?? "The API sent no answer" };
  const source = typeof r.body?.source === "string" ? (r.body.source as OverviewSource) : "api";
  return { ok: false, source, status: r.status, error: r.error, code: r.code };
}

export type Installations =
  | { state: "loading" }
  | { state: "ready"; source: OverviewSource; list: GitInstallation[] }
  | { state: "error"; source: OverviewSource; error: string };

/**
 * The connected GitHub accounts, loaded on mount. `reload` keeps the last list while it runs; only
 * the newest read lands, and leaving the page drops the first read still in flight.
 */
export function useInstallations() {
  const [value, setValue] = useState<Installations>({ state: "loading" });
  const seq = useRef(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    const mine = ++seq.current;
    const r = await gitFetch<GitInstallation[]>("/installations", { signal });
    if (signal?.aborted || mine !== seq.current) return;
    setValue(r.ok ? { state: "ready", source: r.source, list: r.data } : { state: "error", source: r.source, error: r.error });
  }, []);
  const reload = useCallback(() => load(), [load]);
  useEffect(() => {
    const ctl = new AbortController();
    void load(ctl.signal);
    return () => ctl.abort();
  }, [load]);
  return [value, reload, setValue] as const;
}

/**
 * Sends the browser to the GitHub App install page. The API signs a one-time state into the URL,
 * and after GitHub the API brings the operator back to
 * /settings?section=integrations&github=installed (or github=failed), which the GitHub card reads.
 */
export async function startInstall() {
  const r = await gitFetch<{ url: string }>("/install-url");
  if (!r.ok) {
    toast.error("Could not start the GitHub connection", { description: r.error });
    return false;
  }
  window.location.assign(r.data.url);
  return true;
}
