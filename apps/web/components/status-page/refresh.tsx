"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-renders the page from the server every `ms` while the tab is visible, and on return. */
export function StatusRefresh({ ms = 60_000 }: { ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      clearInterval(id);
      id = setInterval(() => router.refresh(), ms);
    };
    const onVisible = () => {
      if (document.hidden) return clearInterval(id);
      router.refresh();
      start();
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router, ms]);
  return null;
}
