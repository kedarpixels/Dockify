"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ConfirmDialog } from "./dialog";

// A link leaves when its path or query differs (detail pages keep the open tab in `?tab=`); only a
// hash change stays. `ignoreQuery` is for a page that keeps every section mounted (Settings).

type Guard = (href: string) => boolean;
const guards = new Set<Guard>();

/** For code that navigates with router.push: true when a page with unsaved changes took the navigation over and goes on itself on Leave. */
export function claimLeave(href: string): boolean {
  for (const g of guards) if (g(href)) return true;
  return false;
}

export function useLeaveGuard(dirty: boolean, { ignoreQuery = false }: { ignoreQuery?: boolean } = {}): React.ReactNode {
  const router = useRouter();
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  useEffect(() => {
    if (!dirty) return;
    /** Where `href` goes when it leaves this page, else null. */
    const away = (href: string) => {
      const to = new URL(href, window.location.href);
      const here = window.location;
      if (to.origin !== here.origin || (to.pathname === here.pathname && (ignoreQuery || to.search === here.search))) return null;
      return to.pathname + to.search + to.hash;
    };
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const leave = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(a instanceof HTMLAnchorElement) || a.target === "_blank" || a.hasAttribute("download")) return;
      const to = away(a.href);
      if (!to) return;
      e.preventDefault();
      e.stopPropagation();
      setLeaveTo(to);
    };
    const claim: Guard = (href) => {
      const to = away(href);
      if (!to) return false;
      setLeaveTo(to);
      return true;
    };
    guards.add(claim);
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", leave, true);
    return () => {
      guards.delete(claim);
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", leave, true);
    };
  }, [dirty, ignoreQuery]);
  return (
    <ConfirmDialog
      open={leaveTo !== null}
      onClose={() => setLeaveTo(null)}
      onConfirm={() => {
        const to = leaveTo;
        setLeaveTo(null);
        if (to) router.push(to);
      }}
      title="Leave without saving"
      sub="Your unsaved changes will be lost."
      confirmLabel="Leave without saving"
      cancelLabel="Stay"
      tone="danger"
    />
  );
}
