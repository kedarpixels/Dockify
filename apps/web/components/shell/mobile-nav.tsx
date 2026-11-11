"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef } from "react";
import { Icon } from "@/components/icon";
import { ProjectIcon } from "@/components/icons/app-icon";
import { Burger } from "@/components/ui/burger";
import { Avatar } from "@/components/ui/avatar";
import { AccountRows } from "./account-menu";
import { isNavActive, MAIN_NAV, SYSTEM_NAV } from "./nav";
import type { ShellData } from "./shell";

/* Phone menu state, shared so the top bar can hold the burger while the shell owns the panel. */
export const MobileNavContext = createContext<{ open: boolean; toggle: () => void }>({ open: false, toggle: () => {} });

const useMobileNav = () => useContext(MobileNavContext);

const burger = () => document.querySelector<HTMLElement>('[aria-controls="mobile-nav"]');

export function MenuKey() {
  const { open, toggle } = useMobileNav();
  return (
    <button type="button" className="menu-key" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} aria-controls="mobile-nav" onClick={toggle}>
      <Burger open={open} />
    </button>
  );
}

// Open, it takes the page behind it out of the keyboard and the accessibility tree. Focus that was
// inside goes back to the burger on close.
export function MobileNav({
  data,
  open,
  onClose,
  onSearch,
}: {
  data: ShellData;
  open: boolean;
  onClose: () => void;
  onSearch: () => void;
}) {
  const path = usePathname();
  const panel = useRef<HTMLDivElement>(null);
  const isActive = (href: string) => isNavActive(path, href);

  // The panel turns inert as it closes, so focus inside it moves to the burger first.
  const close = useCallback(() => {
    if (panel.current?.contains(document.activeElement)) burger()?.focus({ preventScroll: true });
    onClose();
  }, [onClose]);

  // Route changes close the menu (back and forward included, which no row click covers).
  useEffect(() => onClose(), [path, onClose]);

  useEffect(() => {
    const el = panel.current;
    if (!open || !el) return;
    const behind = [...(el.parentElement?.children ?? [])].filter(
      (c): c is HTMLElement => c instanceof HTMLElement && c !== el && !c.matches(".top, .mnav-scrim") && !c.inert,
    );
    for (const c of behind) c.inert = true;
    el.querySelector<HTMLElement>(".mnav-search")?.focus({ preventScroll: true });

    const wide = window.matchMedia("(min-width: 761px)");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onWide = () => wide.matches && close();
    window.addEventListener("keydown", onKey);
    wide.addEventListener("change", onWide);
    // Lock page scroll, restoring whatever value was there before rather than clearing it.
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      for (const c of behind) c.inert = false;
      window.removeEventListener("keydown", onKey);
      wide.removeEventListener("change", onWide);
      root.style.overflow = before;
    };
  }, [open, close]);

  const row = (href: string, label: string, lead: React.ReactNode, extra?: React.ReactNode) => (
    <li key={href}>
      <Link href={href} className="mnav-row" aria-current={isActive(href) ? "page" : undefined} onClick={close}>
        <span className="mnav-lead">{lead}</span>
        <span className="mnav-label">{label}</span>
        {extra}
        <Icon name="chevronRight" size={16} />
      </Link>
    </li>
  );

  return (
    <>
      <div ref={panel} id="mobile-nav" className="mnav" data-open={open}>
        <div className="mnav-inner" inert={!open}>
          <button
            type="button"
            className="mnav-search"
            onClick={() => {
              close();
              onSearch();
            }}
          >
            <Icon name="search" size={16} />
            <span>Search projects, apps and pages</span>
          </button>

          <nav aria-label="Mobile">
            <ul className="mnav-list">
              {MAIN_NAV.map((n) =>
                row(
                  n.href,
                  n.label,
                  <Icon name={n.icon} size={16} />,
                  n.href === "/deployments" && data.inFlight ? (
                    <>
                      <span className="dot pulse" data-tone="live" aria-hidden="true" />
                      <span className="sr">{data.inFlight} in flight</span>
                    </>
                  ) : null,
                ),
              )}
            </ul>
            <p className="mnav-label-hd">System</p>
            <ul className="mnav-list">{SYSTEM_NAV.map((n) => row(n.href, n.label, <Icon name={n.icon} size={16} />))}</ul>
            {data.projects.length ? (
              <>
                <p className="mnav-label-hd">Projects</p>
                <ul className="mnav-list">
                  {data.projects.map((p) =>
                    row(
                      `/projects/${p.slug}`,
                      p.slug,
                      <ProjectIcon slug={p.slug} />,
                      <>
                        <span className="dot" data-tone={p.tone} data-tip={p.stateLabel} aria-hidden="true" />
                        <span className="sr">{p.stateLabel}</span>
                      </>,
                    ),
                  )}
                </ul>
              </>
            ) : null}
          </nav>

          {/* The account block: who is signed in, then the sidebar account menu's rows, less Settings
              and Activity, which the nav above already lists. */}
          {data.viewer ? (
            <div className="mnav-account">
              <div className="mnav-user">
                <Avatar url={data.viewer.avatarUrl} />
                <span className="side-user-text">
                  <span className="side-user-name">{data.viewer.name}</span>
                  <span className="side-user-role">{data.viewer.email ?? data.viewer.role}</span>
                </span>
              </div>
              <AccountRows preview={data.preview} pages={false} onPick={close} />
            </div>
          ) : null}
        </div>
      </div>
      <div className="mnav-scrim" data-open={open} aria-hidden="true" onClick={close} />
    </>
  );
}
