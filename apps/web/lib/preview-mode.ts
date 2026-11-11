/** Fixtures are served only when DOCKIFY_PREVIEW=1 and no API URL is set; a set but empty URL is a
 * broken deploy, not a preview. No imports, so the proxy can ask too. */
export const isPreviewMode = (env: NodeJS.ProcessEnv = process.env): boolean => env.DOCKIFY_API_URL === undefined && env.DOCKIFY_PREVIEW === "1";
