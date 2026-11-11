"use client";

import { apiErrorMessage } from "@/lib/http-status";
import { useCallback, useEffect, useRef, useState } from "react";
import { elevate } from "@/components/step-up/step-up";
import { callJson, OFFLINE } from "@/lib/client-api";
import { apiFetch } from "@/lib/hooks";
import type { ExtrasMutation, ExtrasMutationResult, PageResult, ProjectExtras } from "@/lib/pages/project-detail";
import type { OverviewSource } from "@/lib/types";

const WHAT: Partial<Record<ExtrasMutation["type"], string>> = {
  "env.apply": "Changing variables",
  "env.rollback": "Rolling back variables",
  "environment.branch": "Changing an environment",
  "environment.remove": "Removing an environment",
  "previews.settings": "Changing preview settings",
  "previews.password": "Making a new preview password",
  "previews.delete": "Removing a preview",
};

async function post(m: ExtrasMutation): Promise<ExtrasMutationResult> {
  const r = await callJson<ExtrasMutationResult>("/api/project-extras", { body: m });
  if (r.ok) return r.data ?? { ok: true, source: "api" };
  const b = r.body;
  const keys = Array.isArray(b?.keys) ? b.keys.filter((k): k is string => typeof k === "string") : undefined;
  return { ok: false, source: typeof b?.source === "string" ? (b.source as OverviewSource) : "api", error: r.error, code: r.code, status: r.status, keys };
}

/** Never throws. An elevated write refused for a missing step-up asks "Confirm it is you" and is sent again. */
export function send(m: ExtrasMutation): Promise<ExtrasMutationResult> {
  return elevate(() => post(m), { what: WHAT[m.type] });
}

export type ExtrasLoad = { state: "loading" } | { state: "error"; error: string } | { state: "ready"; result: PageResult<ProjectExtras> };

/** A 404 still carries the page's answer; a body that is not JSON reads as the status. */
async function fetchExtras(slug: string): Promise<ExtrasLoad> {
  try {
    const res = await apiFetch(`/api/project-extras?slug=${encodeURIComponent(slug)}`, { cache: "no-store", headers: { accept: "application/json" } });
    const result = (await res.json().catch(() => null)) as PageResult<ProjectExtras> | null;
    if (result && (res.ok || res.status === 404)) return { state: "ready", result };
    return { state: "error", error: apiErrorMessage(res.status) };
  } catch {
    return { state: "error", error: OFFLINE };
  }
}

/** Only the newest request lands. `patch` edits the loaded data in place. */
export function useProjectExtras(slug: string) {
  const [load, setLoad] = useState<ExtrasLoad>({ state: "loading" });
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    const next = await fetchExtras(slug);
    if (mine === seq.current) setLoad(next);
  }, [slug]);

  useEffect(() => {
    // A late answer for a slug the page left must not land.
    let alive = true;
    const mine = ++seq.current;
    void fetchExtras(slug).then((next) => {
      if (alive && mine === seq.current) setLoad(next);
    });
    return () => {
      alive = false;
    };
  }, [slug]);

  const patch = useCallback((fn: (d: ProjectExtras) => ProjectExtras) => {
    setLoad((l) => (l.state === "ready" && l.result.data ? { state: "ready", result: { ...l.result, data: fn(l.result.data) } } : l));
  }, []);

  return { load, reload, patch };
}
