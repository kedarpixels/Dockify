/* What the project page watches in the polled data, kept free of React so it can be tested. */

/** The apps' states as one comparable string: when it changes, the page's own snapshot is stale. */
export const statusKey = (apps: ReadonlyArray<{ id: string; status: string }>) => apps.map((a) => `${a.id}:${a.status}`).join(" ");

/** True while a preview is still building or being deleted: its row has not settled yet. */
export const previewsMoving = (previews: ReadonlyArray<{ status: string }> | null | undefined) =>
  Boolean(previews?.some((p) => p.status === "building" || p.status === "closing"));
