"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { ProjectIcon } from "@/components/icons/app-icon";
import { IconTile } from "@/components/ui/icon-tile";
import { Node } from "@/components/ui/rule";
import { AccountMenu } from "./account-menu";
import { chord, useModKey } from "./mod-key";
import { isNavActive, MAIN_NAV, SYSTEM_NAV, type NavItem } from "./nav";
import type { ShellData } from "./shell";
import { useCan } from "@/lib/viewer";

/*
 * Geometry: every leading glyph sits in a 24px slot 24px from the sidebar's left edge, so its
 * centre is x = 36 in both widths (264 open, 72 collapsed). Collapsing only clips and fades the
 * labels; nothing moves.
 */

function NavCell({ item, active, extra, flag }: { item: NavItem; active: boolean; extra?: React.ReactNode; flag?: boolean }) {
  return (
    <li>
      <Link
        className="snav"
        href={item.href}
        aria-current={active ? "page" : undefined}
        data-side-tip={item.label}
      >
        <span className="side-slot">
          <Icon name={item.icon} />
          {flag ? <span className="snav-flag dot pulse" data-tone="live" aria-hidden="true" /> : null}
        </span>
        <span className="snav-label">{item.label}</span>
        {extra ? <span className="snav-extra">{extra}</span> : null}
      </Link>
    </li>
  );
}

/**
 * The console's navigation column: brand, search, the Main and System navs, projects, account.
 * A plain block rather than a complementary landmark, so its three navs read as the site's own.
 */
export function Sidebar({
  data,
  collapsed,
  onSearch,
  onToggle,
}: {
  data: ShellData;
  collapsed: boolean;
  onSearch: () => void;
  onToggle: () => void;
}) {
  const path = usePathname();
  const mod = useModKey();
  const [tip, setTip] = useState<{ label: string; y: number; keys?: string[] } | null>(null);
  // A tip shown before a collapse or expand is stale, so it is dropped.
  const [tipWidth, setTipWidth] = useState(collapsed);
  if (tipWidth !== collapsed) {
    setTipWidth(collapsed);
    setTip(null);
  }

  /* The collapse key hides and the expand key unmounts when used, so focus moves to the other one
     instead of being left on a hidden key or dropped to the page. */
  const markKey = useRef<HTMLButtonElement>(null);
  const toggleKey = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);
  const toggleFromKey = (e: React.MouseEvent<HTMLButtonElement>) => {
    moveFocus.current = document.activeElement === e.currentTarget;
    onToggle();
  };
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    (collapsed ? markKey : toggleKey).current?.focus();
  }, [collapsed]);

  /* Collapsed, the labels are hidden, so each glyph names itself in a tooltip to the right. It is
     one fixed element, because the scrolling nav would clip a tooltip drawn inside it. A key with a
     shortcut lists it in data-side-keys ("Ctrl B"), shown as chips. */
  const showTip = (e: React.PointerEvent | React.FocusEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-side-tip]");
    if (!collapsed || !el || (e.type === "focus" && !el.matches(":focus-visible"))) return setTip(null);
    const r = el.getBoundingClientRect();
    setTip({ label: el.dataset.sideTip ?? "", y: Math.round(r.top + r.height / 2), keys: el.dataset.sideKeys?.split(" ") });
  };
  const hideTip = () => setTip(null);
  const isActive = (href: string) => isNavActive(path, href);
  const projectCount = data.projects.length;
  // A Viewer cannot create a project, so the key that opens the form is not theirs to see.
  const can = useCan();

  return (
    <div className="side" onPointerOver={showTip} onPointerLeave={hideTip} onFocus={showTip} onBlur={hideTip} onWheel={hideTip}>
      <div className="side-inner">
        <div className="side-brand">
          {collapsed ? (
            <button
              ref={markKey}
              type="button"
              className="side-mark"
              onClick={toggleFromKey}
              aria-label="Expand sidebar"
              aria-keyshortcuts={chord(mod, "B")}
              data-side-tip="Expand sidebar"
              data-side-keys={`${mod} B`}
            >
              <img className="logo" src="/dockify-logo.png" alt="" width={33} height={24} />
              <span className="side-mark-expand">
                <Icon name="sidebar" />
              </span>
            </button>
          ) : (
            <Link href="/" className="side-mark" aria-label="Dockify overview">
              <img className="logo" src="/dockify-logo.png" alt="" width={33} height={24} />
            </Link>
          )}
          <span className="side-name">Dockify</span>
          <button
            ref={toggleKey}
            type="button"
            className="btn btn-sm btn-icon side-toggle"
            onClick={toggleFromKey}
            aria-label="Collapse sidebar"
            aria-keyshortcuts={chord(mod, "B")}
            tabIndex={collapsed ? -1 : 0}
          >
            <Icon name="sidebar" />
            {/* Tooltip with its key chips, like the theme switch's "Toggle theme  D". */}
            <span className="side-key-tip" aria-hidden="true">
              Collapse sidebar
              <span className="side-key-tip-keys">
                <kbd className="tip-kbd">{mod}</kbd>
                <kbd className="tip-kbd">B</kbd>
              </span>
            </span>
          </button>
        </div>

        <div className="side-search-cell">
          <button
            type="button"
            className="side-search surface-key"
            onClick={onSearch}
            aria-label="Search"
            aria-keyshortcuts={chord(mod, "K")}
            data-side-tip="Search"
          >
            <Icon name="search" />
            <span className="side-search-label">Search</span>
            <span className="side-search-keys" aria-hidden="true">
              <kbd className="kbd">{mod}</kbd>
              <kbd className="kbd">K</kbd>
            </span>
          </button>
        </div>

        <div className="side-scroll">
          <nav aria-label="Main" className="side-sec">
            <ul className="side-cells">
              {MAIN_NAV.map((item) => (
                <NavCell
                  key={item.href}
                  item={item}
                  active={isActive(item.href)}
                  flag={item.href === "/deployments" && data.inFlight > 0}
                  extra={
                    item.href === "/deployments" && data.inFlight > 0 ? (
                      <>
                        <span className="dot pulse" data-tone="live" aria-hidden="true" />
                        <span className="sr">{data.inFlight} in flight</span>
                      </>
                    ) : null
                  }
                />
              ))}
            </ul>
          </nav>

          <nav aria-label="System" className="side-sec">
            <p className="side-label">
              <span>System</span>
            </p>
            <ul className="side-cells">
              {SYSTEM_NAV.map((item) => (
                <NavCell key={item.href} item={item} active={isActive(item.href)} />
              ))}
            </ul>
          </nav>

          {projectCount ? (
            <nav aria-label="Projects" className="side-sec side-sec-projects">
              <div className="side-label">
                <span>Projects</span>
                {can.manage ? (
                  <Link href="/projects/new" className="side-add tile-host" aria-label="New project" tabIndex={collapsed ? -1 : 0}>
                    <IconTile size="sm">
                      <Icon name="plus" size={14} />
                    </IconTile>
                  </Link>
                ) : null}
              </div>
              <ul className="soft-list side-projects">
                {data.projects.map((p) => {
                  const href = `/projects/${p.slug}`;
                  const current = isNavActive(path, href);
                  return (
                    <li key={p.slug}>
                      {/* Collapsed, the state dot is hidden with the label, so the tip names the state too. */}
                      <Link
                        className="soft-row side-project"
                        href={href}
                        data-side-tip={`${p.slug}, ${p.stateLabel}`}
                        aria-current={current ? "page" : undefined}
                      >
                        <span className="side-slot">
                          <ProjectIcon slug={p.slug} />
                        </span>
                        <span className="snav-label" title={p.slug}>{p.slug}</span>
                        <span className="snav-extra">
                          <span className="dot" data-tone={p.tone} data-tip={p.stateLabel} aria-hidden="true" />
                          <span className="sr">{p.stateLabel}</span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
          ) : null}
        </div>

        <div className="side-foot">
          <Node pos="tr" />
          {data.viewer ? <AccountMenu viewer={data.viewer} preview={data.preview} collapsed={collapsed} /> : null}
        </div>
      </div>
      {collapsed && tip ? (
        <span className="side-tip" role="tooltip" style={{ top: tip.y }} data-keys={tip.keys ? "" : undefined}>
          {tip.label}
          {tip.keys ? (
            <span className="side-key-tip-keys" aria-hidden="true">
              {tip.keys.map((k) => (
                <kbd key={k} className="tip-kbd">
                  {k}
                </kbd>
              ))}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
