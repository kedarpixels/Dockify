import { cx } from "./cx";

/**
 * Section or page heading: Geist Pixel title (32px, `level` 1 or 2) with a muted 15px lead 8px
 * below, 40px above and 32px below (portfolio spacing). `actions` sit at the right of the title row.
 */
export function SectionHead({
  id,
  title,
  lead,
  actions,
  level = 2,
  className,
}: {
  id?: string;
  title: React.ReactNode;
  lead?: React.ReactNode;
  actions?: React.ReactNode;
  level?: 1 | 2;
  className?: string;
}) {
  const H = level === 1 ? "h1" : "h2";
  return (
    <header className={cx("shead", className)}>
      <div className="shead-row">
        <H id={id} className="shead-title">
          {title}
        </H>
        {actions ? <div className="shead-actions">{actions}</div> : null}
      </div>
      {lead ? <p className="shead-lead">{lead}</p> : null}
    </header>
  );
}
