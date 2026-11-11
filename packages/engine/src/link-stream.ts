import type { Duplex } from "node:stream";

/**
 * Keeps every write of a stream below `max` bytes. TLS can hand a WebSocket stream one buffer of many
 * megabytes under load, and the far end closes the connection on a message above its cap, which stays
 * small so that nobody can make the worker buffer one before they have proven a key.
 */
export function capWrites<T extends Duplex>(stream: T, max: number): T {
  const write = stream._write.bind(stream);
  stream._write = (chunk: Buffer, encoding: BufferEncoding, done: (e?: Error | null) => void): void => {
    let at = 0;
    const next = (e?: Error | null): void => {
      if (e || at >= chunk.length) return done(e);
      const part = chunk.subarray(at, at + max);
      at += part.length;
      write(part, encoding, next);
    };
    next();
  };
  return stream;
}

/**
 * Makes an H2 stream take only Buffers. Written a string, node:http2 hands nghttp2 memory that is freed before
 * it is read (Node 24.16), so a response starts with heap garbage. node:http writes its headers as a string,
 * so every Docker call over the link would be one race from it.
 */
export function writesAsBuffers<T extends Duplex>(stream: T): T {
  const asBuffer = (chunk: unknown, encoding: BufferEncoding): Buffer => (typeof chunk === "string" ? Buffer.from(chunk, encoding) : (chunk as Buffer));
  const write = stream._write.bind(stream);
  stream._write = (chunk: unknown, encoding: BufferEncoding, done: (e?: Error | null) => void): void => write(asBuffer(chunk, encoding), "buffer" as BufferEncoding, done);
  const writev = stream._writev?.bind(stream);
  if (writev) {
    stream._writev = (chunks: Array<{ chunk: unknown; encoding: BufferEncoding }>, done: (e?: Error | null) => void): void =>
      writev(chunks.map((c) => ({ chunk: asBuffer(c.chunk, c.encoding), encoding: "buffer" as BufferEncoding })), done);
  }
  return stream;
}

/**
 * When `from` is gone, ends `to` and only then lets it go. An H2 stream under flow control can hold many
 * megabytes the far end has not read: destroying it there and then would drop them, and a dump cut short
 * that way still looks finished. A failure on either side is not this: those destroy at once.
 */
export function endWhenDone(from: Duplex, to: Duplex): void {
  from.once("close", () => {
    if (!to.destroyed && !to.writableEnded) to.end();
  });
  to.once("finish", () => to.destroy());
}
