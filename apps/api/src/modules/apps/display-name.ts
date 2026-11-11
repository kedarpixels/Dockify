// A display name is what people read; `name` stays the identity everything else uses. Within one
// environment no two apps may look alike, ignoring case, across both names and display names.
// The apps_display_name_unique index also catches two renames racing each other.
import type { Tx } from "@dockify/db";
import { appLabel } from "@dockify/contracts";
import { HttpError } from "../../errors.ts";

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

export const nameShownElsewhere = (label: string, other: { name: string; displayName: string | null } | null, field = "displayName") =>
  new HttpError(
    409,
    other && other.displayName && other.name.toLowerCase() !== label.toLowerCase()
      ? `${appLabel(other)} in this environment already goes by that name. Pick another one.`
      : `Another app in this environment is called ${label}. Pick another name.`,
    "NAME_TAKEN",
    { field },
  );

/** Null when it equals the app's own name, so the app follows its name again. */
export const storedDisplayName = (name: string, displayName: string | null): string | null => (displayName === null || displayName === name ? null : displayName);
