/**
 * A minimal Redis client: RESP2 over one connection, one command at a time, a timeout on each.
 * The data browser needs AUTH, SCAN, TYPE, PTTL, MEMORY USAGE and DBSIZE, which does not justify a
 * driver dependency. Replies are bounded so a hostile or huge value cannot exhaust memory.
 */
import type { Duplex } from "node:stream";

export type RespValue = string | number | null | RespValue[] | RespError;

export class RespError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RespError";
  }
}

const MAX_REPLY = 8 * 1024 * 1024;

/** Encodes one command as a RESP array of bulk strings. */
export function encodeCommand(args: readonly string[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = Buffer.from(a, "utf8");
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from("\r\n"));
  }
  return Buffer.concat(parts);
}

/** Parses one reply from the front of `buf`. Returns null when more bytes are needed. */
export function parseReply(buf: Buffer, offset = 0): { value: RespValue; next: number } | null {
  if (offset >= buf.length) return null;
  const eol = buf.indexOf("\r\n", offset);
  if (eol === -1) return null;
  const type = String.fromCharCode(buf[offset]!);
  const line = buf.subarray(offset + 1, eol).toString("utf8");
  const after = eol + 2;
  switch (type) {
    case "+":
      return { value: line, next: after };
    case "-":
      return { value: new RespError(line), next: after };
    case ":":
      return { value: Number(line), next: after };
    case "$": {
      const len = Number(line);
      if (len === -1) return { value: null, next: after };
      if (!Number.isInteger(len) || len < 0 || len > MAX_REPLY) throw new RespError("reply too large");
      if (buf.length < after + len + 2) return null;
      return { value: buf.subarray(after, after + len).toString("utf8"), next: after + len + 2 };
    }
    case "*": {
      const count = Number(line);
      if (count === -1) return { value: null, next: after };
      if (!Number.isInteger(count) || count < 0 || count > 1_000_000) throw new RespError("reply too large");
      const items: RespValue[] = [];
      let at = after;
      for (let i = 0; i < count; i++) {
        const r = parseReply(buf, at);
        if (!r) return null;
        items.push(r.value);
        at = r.next;
      }
      return { value: items, next: at };
    }
    default:
      throw new RespError(`unexpected reply type ${type}`);
  }
}

export interface RedisConn {
  command(args: readonly string[]): Promise<RespValue>;
  close(): void;
}

export async function connectRedis(opts: { connect: (timeoutMs: number) => Promise<Duplex>; password: string; user?: string; timeoutMs?: number }): Promise<RedisConn> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const socket = await opts.connect(timeoutMs).catch((e: unknown) => {
    throw (e as { code?: unknown } | null)?.code === "ETIMEDOUT" ? new RespError("could not connect to Redis in time") : e;
  });
  let buf: Buffer = Buffer.alloc(0);
  let waiting: { resolve: (v: RespValue) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  const failAll = (e: Error) => {
    if (waiting) (clearTimeout(waiting.timer), waiting.reject(e));
    waiting = null;
  };
  socket.on("error", failAll);
  socket.on("close", () => failAll(new RespError("Redis closed the connection")));
  socket.on("data", (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    if (buf.length > MAX_REPLY * 2) return failAll(new RespError("reply too large")), socket.destroy();
    try {
      const r = parseReply(buf);
      if (!r || !waiting) return;
      buf = buf.subarray(r.next);
      const w = waiting;
      waiting = null;
      clearTimeout(w.timer);
      w.resolve(r.value);
    } catch (e) {
      failAll(e as Error);
      socket.destroy();
    }
  });
  const conn: RedisConn = {
    command: (args) =>
      new Promise((resolve, reject) => {
        if (waiting) return reject(new RespError("one command at a time"));
        const timer = setTimeout(() => {
          waiting = null;
          socket.destroy();
          reject(new RespError("Redis did not answer in time"));
        }, timeoutMs);
        waiting = { resolve, reject, timer };
        socket.write(encodeCommand(args));
      }),
    close: () => socket.destroy(),
  };
  const auth = await conn.command(opts.user && opts.user !== "default" ? ["AUTH", opts.user, opts.password] : ["AUTH", opts.password]);
  if (auth instanceof RespError) {
    conn.close();
    throw new RespError("Redis refused the stored credentials");
  }
  return conn;
}
