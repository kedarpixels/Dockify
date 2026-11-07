/*
 * What the Vercel runtime log card says, kept pure so it tests without React. The card reads once,
 * then holds one live stream; these lines are what a viewer sees when either of those has nothing to
 * show or could not be had.
 */

/** Said in place of an empty pane when Vercel has printed nothing at runtime. */
export const NO_RUNTIME_LINES = "No runtime logs yet. A static site served from cache often has none.";

/** The one line for a read of the runtime logs that failed, by the status the dashboard answered. */
export function readFailure(status: number, error: string | null | undefined): string {
  if (status === 429) return "Too many log reads are running for your account right now. Wait a moment, then try again.";
  if (status === 401) return "Your session ended. Sign in again to read the logs.";
  if (status === 0) return "Could not reach the dashboard. Check your connection, then try again.";
  const said = (error ?? "").trim().replace(/[.\s]+$/, "");
  return `Could not read the logs. ${said ? `${said.charAt(0).toUpperCase()}${said.slice(1)}` : "The API did not answer"}.`;
}

/** The live stream gave up: an HTTP refusal (a 429 among them) closes it for good, so this is said once. */
export const STREAM_LOST = "The live stream could not connect. Other open log views may hold your streams; close one, then reconnect.";

/**
 * Whether the card also shows the deployment's build log: on an app's Logs tab (no deployment named,
 * so the page has no build log of its own) once the runtime read came back with no lines.
 */
export function wantsBuildLog(o: { named: boolean; runtimeLines: number; deploymentId: string | null }): boolean {
  return !o.named && o.runtimeLines === 0 && !!o.deploymentId;
}
