/**
 * Signed mail icon links for the emails the worker sends (a failed deploy, an alert): the project's
 * and the app's own icons, as the dashboard shows them, reachable by a mail client that has no
 * session. The api serves /api/v1/icons/mail/:token (the web relays it at /api/icons/mail/:token)
 * for a token signed under a key both sides derive from the internal channel token, which this
 * process already holds. No token to sign with (a test without one) means no link, and the email
 * shows the project folder or the app's kind tile instead.
 */
import { mailIconKey, signMailIcon, type MailIconTarget } from "@dockify/crypto";
import { iconVersion, shownAppIcon, shownProjectIcon, type ShownAppIconRow, type ShownProjectIconRow } from "@dockify/db";

export { SHOWN_APP_ICON, SHOWN_PROJECT_ICON } from "@dockify/db";

export interface MailIconLinks {
  projectIcon: string | null;
  appIcon: string | null;
}

/** The signing key for this instance's links, or null when there is no internal token to derive it from. */
export const mailIconSigner = (internalToken: string | undefined): Buffer | null => (internalToken ? mailIconKey(internalToken) : null);

function link(origin: string, key: Buffer, target: MailIconTarget, id: string, shown: { sha256: string } | null): string | null {
  return shown ? `${origin}/api/icons/mail/${signMailIcon(key, { target, id, version: iconVersion(shown.sha256) })}` : null;
}

/** The two links a project chip can show, each null when its owner shows no image or nothing can be signed. */
export function mailIconLinks(origin: string | undefined, key: Buffer | null, app: ShownAppIconRow | null, project: ShownProjectIconRow | null): MailIconLinks {
  if (!origin || !key) return { projectIcon: null, appIcon: null };
  return {
    projectIcon: project ? link(origin, key, "project", project.id, shownProjectIcon(project)) : null,
    appIcon: app ? link(origin, key, "app", app.id, shownAppIcon(app)) : null,
  };
}
