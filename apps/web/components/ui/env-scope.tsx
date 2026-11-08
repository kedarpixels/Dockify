"use client";

import { createContext, useCallback, useContext, useMemo } from "react";

/*
 * Which projects name their environments in rows that list apps from several projects (Resources,
 * Domains, Logs, Backups, the server's containers): the ones whose apps sit in more than one
 * environment (lib/environments.ts). The console frame provides it from the overview it loads; a
 * page that knows its own project decides from that project instead.
 */
const EnvScope = createContext<ReadonlySet<string> | null>(null);

export function EnvScopeProvider({ projects, children }: { projects: readonly string[]; children: React.ReactNode }) {
  // Keyed on the names, so a fresh array with the same projects keeps the same set.
  const key = projects.join(" ");
  const value = useMemo(() => new Set(key ? key.split(" ") : []), [key]);
  return <EnvScope.Provider value={value}>{children}</EnvScope.Provider>;
}

/** Whether a row of `project` names its environment. Without a provider every project does. */
export function useShowsEnv(): (project: string) => boolean {
  const scope = useContext(EnvScope);
  return useCallback((project: string) => scope === null || scope.has(project), [scope]);
}
