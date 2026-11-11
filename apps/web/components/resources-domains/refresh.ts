"use client";

import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent } from "react";

/**
 * Reads the page's server data again every `ms` while `active` and the tab is visible, and once on
 * coming back to it. `onAsk` runs right before each read, for a page that must tell a stale answer.
 */
export function usePageRefresh(active: boolean, ms: number, onAsk?: () => void) {
  const router = useRouter();
  const ask = useEffectEvent(() => {
    if (document.hidden) return;
    onAsk?.();
    router.refresh();
  });
  useEffect(() => {
    if (!active) return;
    const t = setInterval(ask, ms);
    document.addEventListener("visibilitychange", ask);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", ask);
    };
  }, [active, ms]);
}
