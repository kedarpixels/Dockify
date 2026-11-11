import { ProjectTile } from "@/components/project-tile";

/** Without a project it shows the Dockify mark. */
export function StatusTop({ name, logoUrl, actions }: { name?: string; logoUrl?: string | null; actions?: React.ReactNode }) {
  return (
    <header className="stp-top">
      <span className="stp-brand">
        {name ? (
          logoUrl ? (
            // A project logo from any https host: no referrer, so visitors are not reported to it.
            <img className="stp-logo" src={logoUrl} alt="" width={28} height={28} referrerPolicy="no-referrer" />
          ) : (
            <ProjectTile size="md" />
          )
        ) : (
          <img className="logo" src="/dockify-logo.png" alt="" width={33} height={24} />
        )}
        {name ? (
          <span className="stp-name" title={name}>
            {name}
          </span>
        ) : (
          <span className="stp-name" data-wordmark="">
            Dockify
          </span>
        )}
      </span>
      {actions ? <span className="stp-actions">{actions}</span> : null}
    </header>
  );
}

export function StatusFoot({ utc }: { utc?: boolean }) {
  return (
    <footer className="stp-foot">
      <span className="stp-credit">
        <img src="/dockify-logo.png" alt="" width={22} height={16} />
        Powered by Dockify
      </span>
      {utc ? <span>Times in UTC</span> : null}
    </footer>
  );
}
