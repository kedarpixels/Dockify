/* Kept pure so it tests without React. */

export const NO_RUNTIME_LINES = "No runtime logs yet. A static site served from cache often has none.";

export function readFailure(status: number, error: string | null | undefined): string {
  if (status === 429) return "Too many log reads are running for your account right now. Wait a moment, then try again.";
  if (status === 401) return "Your session ended. Sign in again to read the logs.";
  if (status === 0) return "Could not reach the dashboard. Check your connection, then try again.";
  const said = (error ?? "").trim().replace(/[.\s]+$/, "");
  return `Could not read the logs. ${said ? `${said.charAt(0).toUpperCase()}${said.slice(1)}` : "The API did not answer"}.`;
}

/** The live stream gave up: an HTTP refusal (a 429 among them) closes it for good, so this is said once. */
export const STREAM_LOST = "The live stream could not connect. Other open log views may hold your streams; close one, then reconnect.";

/** True on an app's Logs tab (no deployment named) once the runtime read came back with no lines. */
export function wantsBuildLog(o: { named: boolean; runtimeLines: number; deploymentId: string | null }): boolean {
  return !o.named && o.runtimeLines === 0 && !!o.deploymentId;
}
