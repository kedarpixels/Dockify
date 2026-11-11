// Mirrors packages/contracts terminal.ts; tests/terminal.test.mjs holds the numbers to that file.
// The ticket is the socket's first message, never part of the URL: a URL ends up in proxy logs.

export const TERMINAL_CLOSE = {
  exited: 4000,
  left: 4001,
  badMessage: 4400,
  ticketRefused: 4401,
  accessEnded: 4403,
  appGone: 4404,
  targetRefused: 4406,
  idle: 4408,
  notRunning: 4409,
  timeLimit: 4410,
  noShell: 4412,
  inputTooFast: 4413,
  tooMany: 4429,
  unavailable: 4503,
} as const;

/** The largest one message may be; a paste is cut into pieces under it. */
const MAX_MESSAGE_BYTES = 64 * 1024;
export const PASTE_CHUNK_BYTES = 32 * 1024;
/** The session's input burst. A larger paste would close the session, so it is refused up front. */
export const MAX_PASTE_BYTES = 256 * 1024;
export const TERMINAL_IDLE_MINUTES = 15;
export const TERMINAL_TOTAL_MINUTES = 60;

export interface TerminalEnd {
  title: string;
  body: string;
  /** Opening again can help. A shell that cannot exist, or a terminal that is off, cannot. */
  retry: boolean;
}

/** What a close code means, as the page says it. An unknown code reads as the connection dropping. */
export function describeClose(code: number): TerminalEnd {
  switch (code) {
    case TERMINAL_CLOSE.exited:
      return { title: "The shell exited", body: "The session is over. Open a new one to carry on.", retry: true };
    case TERMINAL_CLOSE.notRunning:
      return { title: "This app is not running", body: "A terminal opens inside a running container. Start or deploy the app, then open it again.", retry: true };
    case TERMINAL_CLOSE.noShell:
      return { title: "This image has no shell", body: "The container has no /bin/sh, as a distroless or scratch image does not, so there is nothing to open.", retry: false };
    case TERMINAL_CLOSE.accessEnded:
      return { title: "Access ended", body: "The session ended because your sign-in or role changed, or the terminal was turned off in Settings, Instance.", retry: true };
    case TERMINAL_CLOSE.targetRefused:
      return { title: "Dockify would not open this container", body: "It did not pass the safety check made before a shell starts. Redeploy the app and try again. The worker's log names the check.", retry: true };
    case TERMINAL_CLOSE.appGone:
      return { title: "This app was removed", body: "Its container is gone, and the session with it.", retry: false };
    case TERMINAL_CLOSE.idle:
      return { title: "Closed after 15 minutes idle", body: "A session with no input closes by itself. Open a new one to carry on.", retry: true };
    case TERMINAL_CLOSE.timeLimit:
      return { title: "Closed after an hour", body: "A session lasts an hour at most. Open a new one to carry on.", retry: true };
    case TERMINAL_CLOSE.inputTooFast:
    case 1009:
      return { title: "Too much input at once", body: "The session closed because too much was sent too quickly. Paste less at a time.", retry: true };
    case TERMINAL_CLOSE.tooMany:
      return { title: "Too many terminals open", body: "Each person and each app can hold three at a time, and the server eight. Close one and try again.", retry: true };
    case TERMINAL_CLOSE.ticketRefused:
      return { title: "The connection was refused", body: "The check behind this session did not match. Open the terminal again.", retry: true };
    case TERMINAL_CLOSE.unavailable:
      return { title: "The server could not open it", body: "Dockify's worker did not answer. Check the Server page, then try again.", retry: true };
    default:
      return { title: "The connection dropped", body: "The session ended with it, and whatever ran in the shell was stopped. Open a new one to carry on.", retry: true };
  }
}

/** Same origin, never a query string. */
export function terminalUrl(location: { protocol: string; host: string }, appId: string): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/v1/apps/${encodeURIComponent(appId)}/terminal`;
}

export function chunkBytes(bytes: Uint8Array, size: number = PASTE_CHUNK_BYTES): Uint8Array[] {
  const piece = Math.min(size, MAX_MESSAGE_BYTES);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += piece) out.push(bytes.subarray(i, i + piece));
  return out;
}

/** The same limits the server applies to a window, so a resize can never be what closes a session. */
export function clampSize(cols: number, rows: number): { cols: number; rows: number } {
  const whole = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(Number.isFinite(v) ? v : lo)));
  return { cols: whole(cols, 2, 500), rows: whole(rows, 1, 200) };
}
