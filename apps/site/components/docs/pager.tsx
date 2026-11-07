import Link from "next/link";
import { Icon } from "@/components/icon";
import { docHref, type DocLink } from "@/lib/docs-nav";

/** Previous and next links at the foot of a docs page. */
export function Pager({ prev, next }: { prev?: DocLink; next?: DocLink }) {
  if (!prev && !next) return null;
  return (
    <nav className="pager" aria-label="Docs pages">
      {prev ? (
        <Link href={docHref(prev)} className="pager-cell">
          <span className="pager-dir">
            <Icon name="arrowLeft" size={14} />
            Previous
          </span>
          <span className="pager-title">{prev.title}</span>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link href={docHref(next)} className="pager-cell is-next">
          <span className="pager-dir">
            Next
            <Icon name="arrowRight" size={14} />
          </span>
          <span className="pager-title">{next.title}</span>
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
