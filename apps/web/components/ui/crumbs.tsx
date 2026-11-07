import Link from "next/link";
import { Icon } from "@/components/icon";

/*
 * Breadcrumb above a detail page's title: 13px muted links, "/" between, the current page in ink.
 * Render it as the first child of `main.page`, right before SectionHead; the pair keeps the title
 * at the same height as on list pages.
 *
 *   <Crumbs back items={[{ label: "Deployments", href: "/deployments" }, { label: "dpl_8f2c" }]} />
 *
 * `back` adds a leading arrow key to the nearest ancestor with a link. An item's `icon` (a 20px
 * AppIcon or ProjectIcon) sits before its label. `current={false}` means the items are ancestors
 * only: the page's own name is already its title (and the top bar), so it is not printed a third time.
 *
 *   <Crumbs back current={false} items={[{ label: "Projects", href: "/projects" }]} />
 */
export function Crumbs({
  items,
  back = false,
  current = true,
}: {
  items: Array<{ label: string; href?: string; icon?: React.ReactNode }>;
  back?: boolean;
  current?: boolean;
}) {
  const up = back ? (current ? items.slice(0, -1) : items).findLast((c) => c.href) : undefined;
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {up?.href ? (
        <Link href={up.href} className="crumbs-back" aria-label={`Back to ${up.label}`}>
          <Icon name="arrowLeft" size={14} />
        </Link>
      ) : null}
      <ol>
        {items.map((c, i) => {
          const last = current && i === items.length - 1;
          return (
            <li key={`${c.label}-${i}`}>
              {i ? (
                <span className="crumbs-sep" aria-hidden="true">
                  /
                </span>
              ) : null}
              {c.icon}
              {c.href && !last ? (
                <Link href={c.href} className="crumbs-link">
                  {c.label}
                </Link>
              ) : (
                <span className="crumbs-here" aria-current={last ? "page" : undefined} title={c.label}>
                  {c.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
