type Kind = "frontend" | "backend" | "bot" | "postgres" | "redis" | "s3";

/** A service Dockify runs itself, decided by kind. Having an image says nothing: an app from a
 * published image has one too, and its image and start command are the owner's to set. */
export const isManaged = (app: { kind: Kind }) => app.kind === "postgres" || app.kind === "redis" || app.kind === "s3";

export type AppSource = "git" | "image" | "managed";

/** An image names what runs even in a project that has a repository, so it is read before the repository. */
export const sourceOf = (app: { kind: Kind; image: string | null; repo?: string | null | undefined }): AppSource => (isManaged(app) ? "managed" : app.image ? "image" : app.repo ? "git" : "image");
