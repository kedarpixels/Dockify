/**
 * An app's display name: what people read, while `name` stays the identity everything else uses
 * (containers, volumes, network aliases, preview hosts, links, the CLI). Within one environment no two
 * apps may look alike: a display name is compared, ignoring case, with every other app's name and
 * display name there, and a new app's name with every display name. Names are already unique per
 * environment, so this is the same scope. The database holds display names to it as well
 * (apps_display_name_unique), which also catches two renames racing each other.
 */
import type { Tx } from "@dockify/db";
import { appLabel } from "@dockify/contracts";
import { HttpError } from "../../errors.ts";

/** Another app of the environment that shows `label` or answers to it, ignoring case; null when none does. */
export async function appShowing(
  db: Pick<Tx, "app">, environmentId: string, labels: string[], exceptId?: string,
): Promise<{ name: string; displayName: string | null } | null> {
  if (!labels.length) return null;
  return db.app.findFirst({
    where: {
      environmentId,
      ...(exceptId ? { id: { not: exceptId } } : {}),
      OR: labels.flatMap((l) => [{ name: { equals: l, mode: "insensitive" as const } }, { displayName: { equals: l, mode: "insensitive" as const } }]),
    },
    select: { name: true, displayName: true },
  });
}

/** The refusal of a name another app of the environment already shows or answers to. */
export const nameShownElsewhere = (label: string, other: { name: string; displayName: string | null } | null, field = "displayName") =>
  new HttpError(
    409,
    other && other.displayName && other.name.toLowerCase() !== label.toLowerCase()
      ? `${appLabel(other)} in this environment already goes by that name. Pick another one.`
      : `Another app in this environment is called ${label}. Pick another name.`,
    "NAME_TAKEN",
    { field },
  );

/** What a rename stores: null when it is the app's own name, so the app follows its name again. */
export const storedDisplayName = (name: string, displayName: string | null): string | null => (displayName === null || displayName === name ? null : displayName);
