/* What an app runs from, read the same on its Settings tab and its Overview. */

type Kind = "frontend" | "backend" | "bot" | "postgres" | "redis" | "s3";

/**
 * A service Dockify runs itself, by its kind: Postgres and Redis, plus Storage rows older installs
 * hold, which the API treats the same way. No build, start command, release command or image of the
 * owner's choosing. Having an image says nothing here: an app from a published image has one, and
 * its image and start command are the owner's to set.
 */
export const isManaged = (app: { kind: Kind }) => app.kind === "postgres" || app.kind === "redis" || app.kind === "s3";

export type AppSource = "git" | "image" | "managed";

/** An image names what runs even in a project that has a repository, so it is read before the repository. */
export const sourceOf = (app: { kind: Kind; image: string | null; repo?: string | null | undefined }): AppSource => (isManaged(app) ? "managed" : app.image ? "image" : app.repo ? "git" : "image");
