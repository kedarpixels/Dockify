import Link from "next/link";
import { Node } from "@/components/ui/rule";
import { ThemeSwitch } from "@/components/ui/theme-switch";
import type { Notice } from "@/lib/derive";
import { MenuKey } from "./mobile-nav";
import { Notifications } from "./notifications";
import { SecurityBanner } from "./security-release";

/**
 * 56px ruled bar: the page title in its own cell, then a cell of keys (theme, notifications). Its bottom
 * rule continues the sidebar's brand rule. The two cells ride on the page's 1200px rail, so they line
 * up with the content below on wide screens, and the rule carries a node wherever a vertical line
 * meets it: the two rails (the title cell's left edge, the keys cell's right edge) and the two cell
 * borders. The title gives way first on a narrow phone, so the keys always fit. While a security
 * release is pending, its slim banner runs right under the bar on every console page.
 */
export function Topbar({ trail, notices = null, now = 0 }: { trail: string[]; notices?: Notice[] | null; now?: number }) {
  return (
    <>
      <header className="top">
        <Link href="/" className="top-cell top-brand" aria-label="Dockify overview">
          <img className="logo" src="/dockify-logo.png" alt="" width={33} height={24} />
        </Link>
        <div className="top-rail">
          <div className="top-cell top-title-cell">
            <Node pos="bl" />
            <span className="top-title" title={trail.at(-1)}>{trail.at(-1)}</span>
            <Node pos="br" />
          </div>
          <div className="top-cell top-actions">
            <Node pos="bl" />
            <ThemeSwitch />
            <Notifications notices={notices} now={now} />
            <MenuKey />
            <Node pos="br" />
          </div>
        </div>
      </header>
      <SecurityBanner />
    </>
  );
}
