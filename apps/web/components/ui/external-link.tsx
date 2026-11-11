import { Icon } from "@/components/icon";
import { cx } from "./cx";

/** Opens in a new tab and says so to screen readers. It takes the size of the text around it. */
export function ExternalLink({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) {
  return (
    <a className={cx("ext-link", className)} href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <Icon name="external" size={14} />
      <span className="sr">, opens in a new tab</span>
    </a>
  );
}
