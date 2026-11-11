/**
 * browser <- WebSocket -> api <- frames over a control-network socket -> worker <- hijacked exec -> container.
 * Binary browser messages are terminal bytes and are never parsed, logged or stored; text messages are JSON
 * control. The api to worker hop uses frames because a resize must share the socket with the bytes.
 */
import { z } from "zod";

export const TERMINAL = {
  /** A ticket lives this long and opens one socket. */
  ticketTtlMs: 30_000,
  /** How long a socket may sit without presenting its ticket. */
  authTimeoutMs: 5_000,
  /** No keystroke for this long closes the session. Output does not count: a log tail is not a person. */
  idleMs: 15 * 60_000,
  totalMs: 60 * 60_000,
  /** How often an open session re-checks the session, the role, the app and the off switch. */
  recheckMs: 10_000,
  heartbeatMs: 25_000,
  /** The largest one binary or text message from a browser, enforced by the socket itself. */
  maxMessageBytes: 64 * 1024,
  /** A sustained typing or paste rate past this closes the session. */
  inputBytesPerSecond: 128 * 1024,
  inputBurstBytes: 512 * 1024,
  /** Output waits while this much sits unsent to a slow browser, so `yes` cannot fill the api's memory. */
  outputHighWaterBytes: 1024 * 1024,
  maxPerUser: 3,
  maxPerApp: 3,
  maxPerInstance: 8,
  /** The worker's own ceilings, independent of the api's. */
  workerMaxPerApp: 4,
  workerMaxTotal: 16,
  /** The worker gives up a session past this even if the api never closes it. */
  workerTotalMs: 61 * 60_000,
} as const;

export const TerminalAuthMessage = z.strictObject({
  t: z.literal("auth"),
  ticket: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/),
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(200),
});
export const TerminalResizeMessage = z.strictObject({
  t: z.literal("resize"),
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(200),
});
export const TerminalClientMessage = z.discriminatedUnion("t", [TerminalAuthMessage, TerminalResizeMessage]);

/**
 * Why a session ended, as close codes the browser maps to a sentence. A fixed list: no daemon or
 * worker text ever reaches a browser through a close.
 */
export const TERMINAL_CLOSE = {
  exited: 4000,
  /** The browser went away. For the audit row; no browser is left to read it. */
  left: 4001,
  badMessage: 4400,
  ticketRefused: 4401,
  accessEnded: 4403,
  appGone: 4404,
  /** The container failed a check before the shell started: nothing about the visitor's sign-in. */
  targetRefused: 4406,
  idle: 4408,
  timeLimit: 4410,
  inputTooFast: 4413,
  tooMany: 4429,
  notRunning: 4409,
  noShell: 4412,
  unavailable: 4503,
} as const;
export type TerminalCloseName = keyof typeof TERMINAL_CLOSE;

export const TerminalEnd = z.object({ reason: z.enum(["exited", "not_running", "no_shell", "refused", "failed"]), exitCode: z.number().int().nullable() });
export type TerminalEnd = z.infer<typeof TerminalEnd>;

export const FRAME = { data: 0, resize: 1, end: 2 } as const;
export type FrameType = (typeof FRAME)[keyof typeof FRAME];
const HEADER = 5;
/** Larger than any browser message plus a read from the exec stream. */
export const MAX_FRAME_BYTES = 256 * 1024;

export function encodeFrame(type: FrameType, payload: Buffer | string = Buffer.alloc(0)): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  if (body.length > MAX_FRAME_BYTES) throw new RangeError("Terminal frame too large");
  const head = Buffer.alloc(HEADER);
  head[0] = type;
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

export class FrameError extends Error {}

/** Keeps a partial frame across reads. A bad type or a length past the cap is a protocol error, never a large allocation. */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer, emit: (type: FrameType, payload: Buffer) => void): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= HEADER) {
      const type = this.buf[0]!;
      if (type !== FRAME.data && type !== FRAME.resize && type !== FRAME.end) throw new FrameError("Unknown terminal frame");
      const size = this.buf.readUInt32BE(1);
      if (size > MAX_FRAME_BYTES) throw new FrameError("Terminal frame too large");
      if (this.buf.length < HEADER + size) return;
      emit(type as FrameType, this.buf.subarray(HEADER, HEADER + size));
      this.buf = this.buf.subarray(HEADER + size);
    }
  }
}
