/**
 * ustar headers plus a pax header for a long name, the form apps/agent/src/context-tar-guard.ts reads. .git
 * goes too (a Dockerfile may read it); it holds no token: the clone's credential lives only in its environment.
 */
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { PermanentDeployError } from "./errors.ts";

const BLOCK = 512;
/** What a ustar size field holds. */
const MAX_FILE = 8 * 1024 ** 3 - 1;

const octal = (n: number, width: number) => n.toString(8).padStart(width - 1, "0") + "\0";

function header(name: string, type: "0" | "2" | "5" | "x", size: number, mode: number, link = ""): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, "utf8");
  h.write(octal(mode & 0o777, 8), 100, "latin1");
  h.write(octal(0, 8), 108, "latin1");
  h.write(octal(0, 8), 116, "latin1");
  h.write(octal(size, 12), 124, "latin1");
  h.write(octal(0, 12), 136, "latin1");
  h.write("        ", 148, "latin1");
  h.write(type, 156, "latin1");
  h.write(link, 157, 100, "utf8");
  h.write("ustar\0" + "00", 257, "latin1");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + " ", 148, "latin1");
  return h;
}

const paxRecord = (key: string, value: string): string => {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body);
  for (;;) {
    const next = Buffer.byteLength(body) + String(len).length;
    if (next === len) return `${len}${body}`;
    len = next;
  }
};

const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** One entry's header, with a pax header first when a name or link target would not fit. */
function* entry(name: string, type: "0" | "2" | "5", size: number, mode: number, link = ""): Generator<Buffer> {
  const records = [
    Buffer.byteLength(name) > 99 ? paxRecord("path", name) : "",
    Buffer.byteLength(link) > 99 ? paxRecord("linkpath", link) : "",
  ].join("");
  if (records) {
    const data = Buffer.from(records);
    yield header("pax", "x", data.length, 0o644);
    yield data;
    yield padding(data.length);
  }
  yield header(Buffer.byteLength(name) > 99 ? "long-name" : name, type, size, mode, Buffer.byteLength(link) > 99 ? "long-link" : link);
}

async function* walk(root: string, rel: string): AsyncGenerator<Buffer> {
  const names = (await readdir(join(root, rel))).sort();
  for (const name of names) {
    const path = rel ? `${rel}/${name}` : name;
    const full = join(root, path);
    const st = await lstat(full);
    if (st.isSymbolicLink()) {
      yield* entry(path, "2", 0, 0o777, await readlink(full));
    } else if (st.isDirectory()) {
      yield* entry(`${path}/`, "5", 0, st.mode);
      yield* walk(root, path);
    } else if (st.isFile()) {
      if (st.size > MAX_FILE) throw new PermanentDeployError(`${path} is over 8 GiB, too large for a build's context`);
      yield* entry(path, "0", st.size, st.mode);
      let sent = 0;
      for await (const chunk of createReadStream(full)) {
        sent += (chunk as Buffer).length;
        if (sent > st.size) throw new Error(`${path} changed while it was being sent`);
        yield chunk as Buffer;
      }
      if (sent !== st.size) throw new Error(`${path} changed while it was being sent`);
      yield padding(st.size);
    } else {
      throw new PermanentDeployError(`${path} is not a file, folder or symlink, which a build's context cannot hold`);
    }
  }
}

export function packContext(root: string): Readable {
  async function* all(): AsyncGenerator<Buffer> {
    yield* walk(root, "");
    yield Buffer.alloc(BLOCK * 2);
  }
  return Readable.from(all(), { objectMode: false, highWaterMark: 1024 * 1024 });
}
