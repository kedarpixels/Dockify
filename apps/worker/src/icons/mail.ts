/**
 * Signed icon links for the worker's emails, reachable by a mail client that has no session. Both
 * sides derive the key from the internal channel token; without one there is no link. An SVG icon
 * gets no link either: most mail clients and GitHub's image proxy do not draw SVG.
 */
import { SVG_MIME } from "@dockify/contracts";
import { mailIconKey, signMailIcon, type MailIconTarget } from "@dockify/crypto";
import { iconVersion, shownAppIcon, shownProjectIcon, type ShownAppIconRow, type ShownProjectIconRow } from "@dockify/db";

export { SHOWN_APP_ICON, SHOWN_PROJECT_ICON } from "@dockify/db";

export interface MailIconLinks {
  projectIcon: string | null;
  appIcon: string | null;
}

export const mailIconSigner = (internalToken: string | undefined): Buffer | null => (internalToken ? mailIconKey(internalToken) : null);

function link(origin: string, key: Buffer, target: MailIconTarget, id: string, shown: { sha256: string; mime: string } | null): string | null {
  return shown && shown.mime !== SVG_MIME ? `${origin}/api/icons/mail/${signMailIcon(key, { target, id, version: iconVersion(shown.sha256) })}` : null;
}

export function mailIconLinks(origin: string | undefined, key: Buffer | null, app: ShownAppIconRow | null, project: ShownProjectIconRow | null): MailIconLinks {
  if (!origin || !key) return { projectIcon: null, appIcon: null };
  return {
    projectIcon: project ? link(origin, key, "project", project.id, shownProjectIcon(project)) : null,
    appIcon: app ? link(origin, key, "app", app.id, shownAppIcon(app)) : null,
  };
}
