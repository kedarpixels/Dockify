/**
 * Containers run without a TTY, so Docker's log stream is always multiplexed: an 8 byte header
 * (stream id, three zero bytes, big-endian length) per frame.
 */
export type LogStream = "stdout" | "stderr";
export type LogLevel = "error" | "warn" | "info" | "debug";

export const MAX_LINE = 8 * 1024;

export interface Frame {
  stream: LogStream;
  payload: Buffer;
}

export class Demuxer {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Frame[] = [];
    while (this.buf.length >= 8) {
      const kind = this.buf[0];
      const size = this.buf.readUInt32BE(4);
      if (this.buf.length < 8 + size) break;
      const payload = this.buf.subarray(8, 8 + size);
      this.buf = this.buf.subarray(8 + size);
      if (kind === 1 || kind === 2) out.push({ stream: kind === 2 ? "stderr" : "stdout", payload });
    }
    // A runaway frame header would grow the buffer forever; Docker frames are far below this.
    if (this.buf.length > 4 * 1024 * 1024) this.buf = Buffer.alloc(0);
    return out;
  }
}

export class LineSplitter {
  private partial: Record<LogStream, string> = { stdout: "", stderr: "" };

  push(f: Frame): Array<{ stream: LogStream; raw: string }> {
    const text = this.partial[f.stream] + f.payload.toString("utf8");
    const parts = text.split("\n");
    this.partial[f.stream] = (parts.pop() ?? "").slice(0, MAX_LINE * 2);
    // A whole frame can be one line: a full line is bounded here too, not only the partial one.
    return parts.map((raw) => ({ stream: f.stream, raw: raw.replace(/\r$/, "").slice(0, MAX_LINE * 2) }));
  }
}

const TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2}) /;

/** "2026-10-30T12:00:00.123456789Z text" from `timestamps=1`, to milliseconds and the text. */
export function splitTimestamp(raw: string, fallbackMs: number): { ms: number; text: string } {
  const m = TS.exec(raw);
  if (!m) return { ms: fallbackMs, text: raw };
  const frac = (m[2] ?? "").slice(0, 4); // keep milliseconds; Date.parse refuses nanoseconds
  const ms = Date.parse(`${m[1]}${frac}${m[3]}`);
  return { ms: Number.isFinite(ms) ? ms : fallbackMs, text: raw.slice(m[0].length) };
}

/** Strips ANSI escapes and other control characters an app may print. Tabs survive. */
export const clean = (s: string): string =>
  s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, MAX_LINE);

const PINO: Record<number, LogLevel> = { 10: "debug", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "error" };

export function guessLevel(text: string): LogLevel | null {
  const t = text.trimStart();
  if (t.startsWith("{")) {
    const m = /"(?:level|severity|lvl)"\s*:\s*("?)([A-Za-z]+|\d+)\1/.exec(t.slice(0, 400));
    if (m?.[2]) {
      const v = m[2];
      if (/^\d+$/.test(v)) return PINO[Number(v)] ?? null;
      return wordLevel(v);
    }
  }
  const head = t.slice(0, 120);
  const w = /\b(FATAL|PANIC|CRIT(?:ICAL)?|ERROR|ERR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/i.exec(head);
  return w?.[1] ? wordLevel(w[1]) : null;
}

function wordLevel(w: string): LogLevel | null {
  const u = w.toUpperCase();
  if (/^(FATAL|PANIC|CRIT|CRITICAL|ERROR|ERR)$/.test(u)) return "error";
  if (/^WARN(ING)?$/.test(u)) return "warn";
  if (u === "INFO" || u === "NOTICE") return "info";
  if (u === "DEBUG" || u === "TRACE") return "debug";
  return null;
}
