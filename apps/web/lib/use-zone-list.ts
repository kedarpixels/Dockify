"use client";

import { useEffect, useState } from "react";
import { TIME_ZONE_RE } from "./time-zones";

export type ZoneList = { at: "loading" } | { at: "ready"; zones: string[]; browser: string | null } | { at: "error"; browser: string | null };

/** Read after mount so the server and first client render agree. Without Intl.supportedValuesOf it lands on "error". */
export function useZoneList(): ZoneList {
  const [list, setList] = useState<ZoneList>({ at: "loading" });
  useEffect(() => {
    let browser: string | null = null;
    try {
      browser = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
      browser = null;
    }
    let next: ZoneList;
    try {
      next = { at: "ready", zones: Intl.supportedValuesOf("timeZone").filter((z) => TIME_ZONE_RE.test(z)), browser };
    } catch {
      next = { at: "error", browser };
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one read of a browser-only API after mount, never repeated.
    setList(next);
  }, []);
  return list;
}
