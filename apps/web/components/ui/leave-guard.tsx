"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ConfirmDialog } from "./dialog";

/*
 * The one unsaved-changes guard. While `dirty`, closing or reloading the tab gets the browser's
 * own question, and leaving the page asks "Leave without saving" or "Stay" first: a click on an
 * in-app link (caught in the capture phase, before Next routes it), and a navigation from code that
 * asks `claimLeave` before it pushes (the command menu, the security release popup). Render what
 * the hook returns once, inside the form's card.
 *
 *   const guard = useLeaveGuard(dirty);
 *   return <section>...{guard}</section>;
 *
 * A link leaves when its path or its query differs: the detail pages keep the open tab in `?tab=`,
 * so a link to the same page without it would still unmount the form; only a change of hash stays.
 * `ignoreQuery` is for a page that keeps every section mounted (Settings, `?section=`), where a
 * change of query never drops an edit.
 */

type Guard = (href: string) => boolean;
const guards = new Set<Guard>();

/**
 * For code that navigates with router.push: true when a page holding unsaved changes took the
 * navigation over (it is asking now, and goes on itself if the answer is Leave), false to go ahead.
 */
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
