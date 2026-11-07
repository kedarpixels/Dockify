import { Icon } from "@/components/icon";
import { cx } from "./cx";

/**
 * A link that leaves the dashboard: muted ink with a quiet underline, the external glyph after the
 * text, and "opens in a new tab" for screen readers. It takes the size of the text around it.
 * Integrations (provider docs and token pages), release notes, security advisories.
 *
 *   <ExternalLink href="https://dash.cloudflare.com/profile/api-tokens">Create a token</ExternalLink>
 */
export function ExternalLink({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) {
  return (
    <a className={cx("ext-link", className)} href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <Icon name="external" size={14} />
      <span className="sr">, opens in a new tab</span>
    </a>
  );
}
