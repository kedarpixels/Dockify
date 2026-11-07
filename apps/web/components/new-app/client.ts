"use client";

import { useEffect, useState } from "react";
import { elevate } from "@/components/step-up/step-up";
import { callJson } from "@/lib/client-api";
import type { OverviewSource } from "@/lib/types";
import type { DeployTemplateInput, DeployTemplateResult, TemplateRow } from "./template-spec";
import { LINK_CONFLICT, readConflict, type CreateAppsInput, type CreateAppsResult, type DetectInput, type DetectResult, type LinkConflict, type NewAppAnswer, type NewAppContext } from "./spec";

/* Browser side of the new app flow: calls to the same-origin proxy under app/api/new-app. */

export type Call<T> =
  | { ok: true; source: OverviewSource; data: T }
  | { ok: false; source: OverviewSource; error: string; code?: string; conflict?: LinkConflict };

/** One call to app/api/new-app. Never throws; an aborted call resolves to a failed answer nobody reads. */
async function call<T>(path: string, init?: { body?: unknown; signal?: AbortSignal }): Promise<Call<T>> {
  const r = await callJson<NewAppAnswer<T>>(`/api/new-app${path}`, { body: init?.body, signal: init?.signal });
  if (r.ok && r.data && r.data.data !== null) return { ok: true, source: r.data.source, data: r.data.data };
  const source = r.ok ? (r.data?.source ?? "api") : typeof r.body?.source === "string" ? (r.body.source as OverviewSource) : "api";
  const conflict = !r.ok && r.code === LINK_CONFLICT ? readConflict(r.body?.conflict) : null;
  return { ok: false, source, error: r.ok ? (r.data?.error ?? "The API sent no answer") : r.error, code: r.ok ? undefined : r.code, ...(conflict ? { conflict } : {}) };
}

export const detect = (input: DetectInput, signal: AbortSignal) => call<DetectResult>("/detect", { body: input, signal });

/** Creating or importing apps is elevated: a missing step-up asks "Confirm it is you" and sends again. */
export const createApps = (input: CreateAppsInput) =>
  elevate(() => call<CreateAppsResult>("", { body: input }), { what: input.apps.length > 1 ? "Importing apps" : "Adding an app" });

/** The API refuses without a step-up the same way: a press asks "Confirm it is you" and sends again. */
export const deployTemplate = (input: DeployTemplateInput) =>
  elevate(() => call<DeployTemplateResult>("/templates", { body: input }), { what: "Deploying a template" });

/** The release's templates, fetched once a person opens that choice. */
export function useTemplates(wanted: boolean) {
  const [rows, setRows] = useState<TemplateRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!wanted) return;
    const ctl = new AbortController();
    void callJson<NewAppAnswer<TemplateRow[]>>("/api/new-app/templates", { signal: ctl.signal }).then((r) => {
      if (ctl.signal.aborted) return;
      if (r.ok && r.data?.data) {
        setRows(r.data.data);
        setError(null);
      } else setError(r.ok ? (r.data?.error ?? "The API sent no answer") : r.error);
    });
    return () => ctl.abort();
  }, [wanted, tick]);
  return { rows, error, reload: () => { setError(null); setTick((t) => t + 1); } };
}

export type ContextState = { state: "loading" } | { state: "ready"; data: NewAppContext } | { state: "error"; error: string };

/** Registries and the Vercel account, loaded once when the dialog opens. */
export function useNewAppContext() {
  const [ctx, setCtx] = useState<ContextState>({ state: "loading" });
  useEffect(() => {
    const ctl = new AbortController();
    void call<NewAppContext>("/context", { signal: ctl.signal }).then((r) => {
      if (!ctl.signal.aborted) setCtx(r.ok ? { state: "ready", data: r.data } : { state: "error", error: r.error });
    });
    return () => ctl.abort();
  }, []);
  return ctx;
}
