"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { buildShell, type Tone } from "@/lib/derive";
import { useLatestOverview } from "@/lib/live-overview";
import { SIDEBAR_KEY } from "@/lib/theme";
import type { AppKind } from "@/lib/types";
import { EnvScopeProvider } from "@/components/ui/env-scope";
import { CommandMenu } from "./command-menu";
import { focusMain } from "./focus";
import { iconsStale, isNewer, type ShellFacts } from "./live-shell";
import { MobileNav, MobileNavContext } from "./mobile-nav";
import { isApple } from "./mod-key";
import { Sidebar } from "./sidebar";
import { useTabSignals } from "./tab-signals";
import { useFollowSystemTheme } from "./theme-mode";

export interface ShellData {
  host: { name: string; region: string; cores: number; disk: { usedBytes: number; totalBytes: number; reclaimableBytes: number } } | null;
  projects: Array<{ slug: string; tone: Tone; stateLabel: string }>;
  /** `environment` is null when the app's project shows none (lib/environments.ts). */
  /** `label` is what people read ("horseai / Storefront"); `name` is the app's own name, which a search also finds. */
  apps: Array<{ id: string; kind: AppKind; label: string; name?: string; environment: string | null }>;
  /** The projects whose rows name their environments (components/ui/env-scope.tsx). */
  envProjects?: string[];
  inFlight: number;
  viewer: { name: string; role: string; email?: string; avatarUrl?: string } | null;
  /** Design preview build: sign out skips the API call. */
  preview?: boolean;
}

/* The sidebar width lives on the html element (the pre-paint script restores it from storage), so
   the widths in CSS, the stored choice and this state always agree. */
const readCollapsed = () => document.documentElement.dataset.sidebar === "collapsed";
function subscribeSidebar(onChange: () => void) {
  const watch = new MutationObserver(onChange);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-sidebar"] });
  return () => watch.disconnect();
}

/* The skip link: the page's main region takes focus (and the page scrolls to its top). Without
   one, the browser follows #main itself. */
function skipToMain(e: React.MouseEvent<HTMLAnchorElement>) {
  if (focusMain({ scroll: true })) e.preventDefault();
}

/**
 * `data` is the layout's read, at `servedAt`. Once a page has polled a newer overview the shell
 * shows that instead, so the sidebar, the command menu and the tab title follow the server.
 */
export function Shell({ data: served, servedAt = "", children }: { data: ShellData; servedAt?: string; children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const live = useLatestOverview();
  const polled = useMemo(() => (live?.data ? { at: live.fetchedAt, shell: buildShell(live.data) } : null), [live]);
  const data = useMemo<ShellData>(() => (polled && isNewer(polled.at, servedAt) ? { ...polled.shell, preview: served.preview } : served), [polled, served, servedAt]);

  // The icon map is the layout's too. It is read again (router.refresh) only when a snapshot says
  // it may have changed, never on every tick.
  const facts = useRef<ShellFacts | null>(null);
  const readAgain = useRef(false);
  useEffect(() => {
    if (!polled) return;
    const prev = facts.current;
    facts.current = polled.shell;
    if (!prev) return;
    const stale = iconsStale(prev, polled.shell);
    if (stale.now || readAgain.current) router.refresh();
    readAgain.current = stale.again;
  }, [polled, router]);

  const collapsed = useSyncExternalStore(subscribeSidebar, readCollapsed, () => false);
  const [ready, setReady] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const column = useRef<HTMLDivElement>(null);
  // Set by a command menu pick that leaves this page: the next page's main region takes focus.
  const landOnMain = useRef(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const openCommand = useCallback(() => setCommandOpen(true), []);
  const closeCommand = useCallback(() => setCommandOpen(false), []);
  const onNavigate = useCallback((href: string) => {
    landOnMain.current = href !== path;
  }, [path]);
  const menu = useMemo(() => ({ open: menuOpen, toggle: () => setMenuOpen((o) => !o) }), [menuOpen]);

  useFollowSystemTheme();
  // Tab title count while builds run. The favicon's dot follows the bell (notifications.tsx).
  useTabSignals(data.inFlight);

  // Transitions switch on a frame after load, so restoring the stored width does not animate.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const toggleSidebar = useCallback(() => {
    const next = !readCollapsed();
    document.documentElement.dataset.sidebar = next ? "collapsed" : "open";
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? "collapsed" : "open");
    } catch {}
  }, []);

  useEffect(() => {
    // Cmd on Apple platforms, Ctrl elsewhere (see mod-key.ts).
    const apple = isApple();
    const onKey = (e: KeyboardEvent) => {
      if (!(apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) || e.altKey || e.shiftKey || e.repeat) return;
      // A terminal (marked data-raw-keys) and a textarea keep every chord for themselves.
      if (e.target instanceof Element && e.target.closest("textarea, [data-raw-keys]")) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        // A dialog owns the keyboard; the menu opens over the page, never over a dialog.
        if (!document.querySelector(".cmd") && document.querySelector("[aria-modal='true']")) return;
        e.preventDefault();
        setCommandOpen((o) => !o);
      } else if (k === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);

  // A command menu pick that left the page lands focus on the new page's main region, unless the
  // pick opened a dialog (New project), which takes focus itself.
  useEffect(() => {
    if (!landOnMain.current) return;
    landOnMain.current = false;
    if (!document.querySelector("[aria-modal='true']")) focusMain();
  }, [path]);

  // Focus held by something a navigation removed (a link in the old page, the old page's bell or
  // burger) lands on the new page's main region instead of falling to the top of the document.
  useEffect(() => {
    const host = column.current;
    if (!host) return;
    let last: Element | null = null;
    const onFocusIn = (e: FocusEvent) => {
      last = e.target instanceof Element ? e.target : null;
    };
    const watch = new MutationObserver(() => {
      const a = document.activeElement;
      if ((a && a !== document.body) || !last || last.isConnected) return;
      last = null;
      focusMain();
    });
    document.addEventListener("focusin", onFocusIn);
    watch.observe(host, { childList: true });
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      watch.disconnect();
    };
  }, []);

  return (
    <MobileNavContext.Provider value={menu}>
      <div className="shell" data-collapsed={collapsed} data-ready={ready}>
        {/* The first stop on every page: past the sidebar and the top bar, straight to the content. */}
        <a className="btn skip-link" href="#main" onClick={skipToMain}>
          Skip to content
        </a>
        <Sidebar data={data} collapsed={collapsed} onSearch={openCommand} onToggle={toggleSidebar} />
        <div ref={column} className="shell-main">
          <EnvScopeProvider projects={data.envProjects ?? []}>{children}</EnvScopeProvider>
          <MobileNav data={data} open={menuOpen} onClose={closeMenu} onSearch={openCommand} />
        </div>
        {commandOpen ? <CommandMenu data={data} onClose={closeCommand} onNavigate={onNavigate} /> : null}
      </div>
    </MobileNavContext.Provider>
  );
}
