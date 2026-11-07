import Link from "next/link";
import { Corners } from "@/components/ui/rule";
import { SITE_TAGLINE } from "@/components/seo/config";
import { FOOTER_NAV } from "@/lib/site";

/** Footer, from the brief (4.11): wordmark and one line, three link columns, the bottom line. */
export function SiteFooter() {
  return (
    <footer className="st-foot">
      <div className="st-foot-in">
        <div className="st-foot-brand">
          <Corners />
          <Link href="/" className="st-brand-sm" aria-label="Dockify home">
            <img className="logo" src="/dockify-logo.png" alt="" width={33} height={24} />
            <span className="st-word">Dockify</span>
          </Link>
          <p>{SITE_TAGLINE}</p>
        </div>
        {FOOTER_NAV.map((col) => (
          <div key={col.title} className="st-foot-col">
            <Corners />
            <p className="st-foot-hd">{col.title}</p>
            <ul>
              {col.links.map((l) => (
                <li key={l.label}>
                  {l.external ? (
                    <a href={l.href} target="_blank" rel="noreferrer noopener">
                      {l.label}
                    </a>
                  ) : (
                    <Link href={l.href}>{l.label}</Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="st-foot-base">
        <div className="st-foot-base-in">
          <span>Copyright 2026 The Dockify Authors. Apache License 2.0.</span>
        </div>
      </div>
    </footer>
  );
}
