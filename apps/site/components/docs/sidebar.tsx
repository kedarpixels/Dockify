"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/icon";
import { DOCS_NAV, docHref } from "@/lib/docs-nav";
import { cx } from "@/components/ui/cx";
import { Rule } from "@/components/ui/rule";
import { DocsSearch } from "./search";

/**
 * Docs sidebar: the search in its own ruled row, then the groups, which scroll under it. Every
 * entry is one line. On phones the search stays as a row and the groups fold into a disclosure
 * above the article, its chevron turning when open.
 */
export function DocsSidebar() {
  const path = usePathname();
  const list = (
    <nav aria-label="Docs" className="dside-nav">
      <Link href="/docs" className={cx("dside-link", path === "/docs" && "is-on")} aria-current={path === "/docs" ? "page" : undefined}>
        <span className="dside-label">Introduction</span>
      </Link>
      {DOCS_NAV.map((g) => (
        <div key={g.title} className="dside-group">
          <p className="dside-hd">{g.title}</p>
          <ul>
            {g.items.map((d) => {
              const href = docHref(d);
              const on = path === href;
              return (
                <li key={d.slug}>
                  <Link href={href} className={cx("dside-link", on && "is-on")} aria-current={on ? "page" : undefined}>
                    <span className="dside-label">{d.title}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
  return (
    <aside className="dside">
      <div className="dside-stick">
        <div className="dside-search">
          <DocsSearch />
        </div>
        <Rule className="dside-rule" />
        <div className="dside-inner">{list}</div>
      </div>
      {/* Keyed by path so the fold closes after each navigation. */}
      <details className="dside-fold" key={path}>
        <summary>
          <span>Docs menu</span>
          <Icon name="chevronDown" size={16} className="dside-fold-ic" />
        </summary>
        {list}
      </details>
    </aside>
  );
}
