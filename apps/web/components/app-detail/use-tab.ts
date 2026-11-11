"use client";

import { useCallback, useState } from "react";
import { elevate } from "@/components/step-up/step-up";
import { callJson } from "@/lib/client-api";
import type { AppTabKey, TabResult } from "@/lib/pages/project-detail";
import type { OverviewSource } from "@/lib/types";
import { useKeyedLoad } from "@/lib/use-keyed-load";

// A new range or table shows its loading state, never the last one's values. Table rows are tenant
// data, so that read asks for a step-up when it must.

const WHAT: Partial<Record<AppTabKey, string>> = { rows: "Reading table rows" };

export function useAppTab<T>(id: string, tab: AppTabKey, query?: Record<string, string>) {
  const qs = new URLSearchParams(query).toString();
  const url = `/api/project-detail/apps/${encodeURIComponent(id)}/${tab}${qs ? `?${qs}` : ""}`;
  const [source, setSource] = useState<OverviewSource | null>(null);
  const load = useCallback(
    async (_key: string, signal: AbortSignal) => {
      const r = await elevate(() => callJson<TabResult<T>>(url, { signal }), { what: WHAT[tab] });
      if (r.ok) {
        if (r.data) setSource(r.data.source);
        return r.data ? { data: r.data.data, error: r.data.error } : { data: null };
      }
      // A failed reload keeps what is on screen and says why.
      if (typeof r.body?.source === "string") setSource((s) => s ?? (r.body?.source as OverviewSource));
      return { error: r.error, aborted: r.aborted };
    },
    [url, tab],
  );
  const q = useKeyedLoad<T>(url, load);
  return { ...q, source };
}
