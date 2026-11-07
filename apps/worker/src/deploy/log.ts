/**
 * The deploy log. Every line a deployment stores goes through one DeployLog: redacted, split with
 * a byte cap, batched, gzipped into deployment_log_chunks. Sequence numbers are allocated in the
 * database by bumping deployments."logSeq", so the api (cancel notes) and the worker can both
 * write to one deployment and never collide.
 */
import { gzipSync, gunzipSync } from "node:zlib";
import type { Db } from "@dockify/db";
import { LineSplitter, MAX_LINE } from "@dockify/engine";
import { Redactor } from "@dockify/redact";

export { LineSplitter, MAX_LINE };

export type Stream = "stdout" | "stderr";
export interface LogLine {
  ts: string;
  stream: Stream;
  text: string;
}

/** Lines one deployment may store; past it a single notice is written and the rest dropped. */
export const MAX_LINES = 20_000;
const FLUSH_LINES = 200;
const FLUSH_MS = 500;

/** Chunk codec: gzipped NDJSON of { ts, stream, text }. The api module decodes the same format. */
export function encodeChunk(lines: LogLine[]): Buffer {
  return gzipSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n"), "utf8"));
}
export function decodeChunk(gz: Uint8Array): LogLine[] {
  const text = gunzipSync(gz).toString("utf8");
  if (!text) return [];
  return text.split("\n").map((l) => JSON.parse(l) as LogLine);
}


/** Allocates n sequence numbers for a deployment; returns the first. */
export async function allocateSeq(db: Db, deploymentId: string, n: number): Promise<number> {
  const rows = await db.$queryRaw<Array<{ logSeq: number }>>`
    UPDATE deployments SET "logSeq" = "logSeq" + ${n} WHERE id = ${deploymentId}::uuid RETURNING "logSeq"`;
  const end = rows[0]?.logSeq;
  if (end === undefined) throw new Error(`deployment ${deploymentId} is gone`);
  return end - n;
}

export interface LogSink {
  write(lines: LogLine[]): Promise<void>;
}

export function dbSink(db: Db, deploymentId: string): LogSink {
  return {
    async write(lines) {
      if (!lines.length) return;
      const firstSeq = await allocateSeq(db, deploymentId, lines.length);
      await db.deploymentLogChunk.create({
        data: { deploymentId, firstSeq, lineCount: lines.length, gzip: new Uint8Array(encodeChunk(lines)) },
      });
    },
  };
}

export class DeployLog {
  readonly redactor = new Redactor();
  private pending: LogLine[] = [];
  private stored = 0;
  private capped = false;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();

  private readonly sink: LogSink;
  private readonly now: () => Date;
  constructor(sink: LogSink, now: () => Date = () => new Date()) {
    this.sink = sink;
    this.now = now;
  }

  /** A line from Dockify itself. */
  system(text: string): void {
    this.add("stdout", `==> ${text}`);
  }
  error(text: string): void {
    this.add("stderr", `==> ${text}`);
  }

  /**
   * Stores one line, redacted. Returns the redacted text exactly as stored, so a caller quoting the
   * line elsewhere (a build failure's reason) shows what the log shows; null once the cap is hit.
   */
  add(stream: Stream, raw: string): string | null {
    if (this.capped) return null;
    if (this.stored + this.pending.length >= MAX_LINES) {
      this.capped = true;
      this.pending.push({ ts: this.now().toISOString(), stream: "stderr", text: `==> log limit of ${MAX_LINES} lines reached; later output is not stored` });
      this.schedule(true);
      return null;
    }
    const text = this.redactor.line(raw.length > MAX_LINE ? raw.slice(0, MAX_LINE) : raw);
    this.pending.push({ ts: this.now().toISOString(), stream, text });
    this.schedule(this.pending.length >= FLUSH_LINES);
    return text;
  }

  /** A splitter that feeds this log, for a process or container output stream. */
  splitter(stream: Stream): LineSplitter {
    return new LineSplitter((t) => this.add(stream, t));
  }

  private schedule(now: boolean): void {
    if (now) {
      void this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), FLUSH_MS);
      this.timer.unref?.();
    }
  }

  /** Writes what is pending. Log writes are diagnostics: a failed write never fails the deploy. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.pending;
    this.pending = [];
    if (!batch.length) return this.chain;
    this.stored += batch.length;
    this.chain = this.chain.then(() => this.sink.write(batch)).catch(() => {});
    return this.chain;
  }
}
