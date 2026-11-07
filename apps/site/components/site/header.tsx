"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/icon";
import { Node } from "@/components/ui/rule";
import { ThemeSwitch } from "@/components/ui/theme-switch";
import { Burger } from "@/components/ui/burger";
import { cx } from "@/components/ui/cx";
import { isActive, TOP_NAV } from "@/lib/site";

/**
 * Sticky solid top bar inside the rails: brand cell, nav, then a cell of keys (theme, Install).
 * Below 761px the nav moves into a ruled menu that drops under the bar, as in the dashboard.
 * The `top` class is what the shared tip guard measures the bar by.
 */
export function SiteHeader() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [shownFor, setShownFor] = useState(path);
  const close = useCallback(() => setOpen(false), []);

  // A route change closes the menu, back and forward included.
  if (shownFor !== path) {
    setShownFor(path);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const wide = window.matchMedia("(min-width: 761px)");
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const onWide = () => wide.matches && close();
    window.addEventListener("keydown", onKey);
    wide.addEventListener("change", onWide);
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      wide.removeEventListener("change", onWide);
      root.style.overflow = before;
    };
  }, [open, close]);

  return (
    <>
      <header className="st-top top">
        <div className="st-top-in">
          <Node pos="bl" />
          <Node pos="br" />
          <Link href="/" className="st-brand" aria-label="Dockify home">
            <img className="logo" src="/dockify-logo.png" alt="" width={33} height={24} />
            <span className="st-word">Dockify</span>
          </Link>

          <nav className="st-nav" aria-label="Main">
            {TOP_NAV.map((n) =>
              n.external ? (
                <a key={n.label} href={n.href} className="st-link" target="_blank" rel="noreferrer noopener">
                  {n.icon === "github" ? <Icon name="github" size={16} /> : null}
                  {n.label}
                </a>
              ) : (
                <Link key={n.label} href={n.href} className={cx("st-link", isActive(path, n.href) && "is-on")} aria-current={isActive(path, n.href) ? "page" : undefined}>
                  {n.label}
                </Link>
              ),
            )}
          </nav>

          <div className="st-keys">
            <ThemeSwitch />
            <Link href="/install" className="btn btn-sm btn-primary st-install">
              <Icon name="terminal" size={16} />
              Install
            </Link>
            <button type="button" className="menu-key" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} aria-controls="site-menu" onClick={() => setOpen((o) => !o)}>
              <Burger open={open} />
            </button>
          </div>
        </div>
      </header>

      <div id="site-menu" className="mnav" data-open={open}>
        <div className="mnav-inner" inert={!open}>
          <nav aria-label="Mobile">
            <ul className="mnav-list">
              {TOP_NAV.map((n) => (
                <li key={n.label}>
                  {n.external ? (
                    <a href={n.href} className="mnav-row" target="_blank" rel="noreferrer noopener" onClick={close}>
                      <span className="mnav-lead">{n.icon ? <Icon name={n.icon} size={16} /> : null}</span>
                      <span className="mnav-label">{n.label}</span>
                      <Icon name="arrowUpRight" size={16} />
                    </a>
                  ) : (
                    <Link href={n.href} className="mnav-row" aria-current={isActive(path, n.href) ? "page" : undefined} onClick={close}>
                      <span className="mnav-lead">{n.icon ? <Icon name={n.icon} size={16} /> : null}</span>
                      <span className="mnav-label">{n.label}</span>
                      <Icon name="chevronRight" size={16} />
                    </Link>
                  )}
                </li>
              ))}
            </ul>
            <div className="mnav-cta">
              <Link href="/install" className="btn btn-primary" onClick={close}>
                <Icon name="terminal" size={16} />
                Install on your server
              </Link>
            </div>
          </nav>
        </div>
      </div>
      <div className="mnav-scrim" data-open={open} aria-hidden="true" onClick={close} />
    </>
  );
}
