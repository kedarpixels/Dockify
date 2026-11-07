/**
 * The design preview's one gate: fixtures are served only when no API is configured at all and
 * DOCKIFY_PREVIEW=1. An API URL that is set but empty is a broken deploy, not a preview, so it gets
 * no fixture. No imports, so the proxy can ask too; on a client it is always false (the flag never
 * reaches a browser bundle).
 */
export const isPreviewMode = (env: NodeJS.ProcessEnv = process.env): boolean => env.DOCKIFY_API_URL === undefined && env.DOCKIFY_PREVIEW === "1";
