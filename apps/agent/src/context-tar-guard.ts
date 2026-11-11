/**
 * Unpacks a build context into a fresh folder, checking every entry first. A symlink may be an entry, but
 * nothing is written through one and no path leaves the folder. Hard links, devices and FIFOs are refused.
 */
import { open, mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export class ContextTarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextTarError";
  }
}

const BLOCK = 512;
const MAX_PAX = 256 * 1024;
const MAX_ENTRIES = 1_000_000;
const MAX_NAME = 4096;

const cstr = (b: Buffer): string => {
  const z = b.indexOf(0);
  return b.subarray(0, z === -1 ? b.length : z).toString("utf8");
};

function octal(b: Buffer): number {
  if (b[0]! & 0x80) throw new ContextTarError("tar entry uses a base-256 number");
  const s = cstr(b).trim();
  if (s && !/^[0-7]+$/.test(s)) throw new ContextTarError("tar header has a malformed number");
  return s ? parseInt(s, 8) : 0;
}

function checksumOk(h: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
  return sum === octal(h.subarray(148, 156));
}

function cleanPath(name: string): string[] {
  if (!name || name.length > MAX_NAME || name.startsWith("/") || name.includes("\\") || name.includes("\0")) throw new ContextTarError(`tar entry ${JSON.stringify(name).slice(0, 200)} is not a relative path`);
  const parts = name.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "").split("/");
  if (parts.some((p) => p === ".." || p === "." || p === "")) throw new ContextTarError(`tar entry ${JSON.stringify(name).slice(0, 200)} leaves the folder`);
  return parts;
}

function parsePax(data: Buffer): { path?: string; linkpath?: string } {
  const out: { path?: string; linkpath?: string } = {};
  let o = 0;
  while (o < data.length) {
    const sp = data.indexOf(0x20, o);
    if (sp === -1) throw new ContextTarError("malformed pax header");
    const len = Number(data.subarray(o, sp).toString("ascii"));
    if (!Number.isInteger(len) || len <= 0 || o + len > data.length) throw new ContextTarError("malformed pax header");
    const rec = data.subarray(sp + 1, o + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0) {
      const key = rec.slice(0, eq);
      if (key === "path") out.path = rec.slice(eq + 1);
      if (key === "linkpath") out.linkpath = rec.slice(eq + 1);
    }
    o += len;
  }
  return out;
}

export interface UnpackSummary {
  files: number;
  bytes: number;
}

/** Reads the archive to its end into `dest`, which must be empty. A bad entry throws, and the caller discards `dest`. */
export async function unpackContext(source: AsyncIterable<Buffer | Uint8Array | string>, dest: string, limits: { maxBytes: number }): Promise<UnpackSummary> {
  await mkdir(dest, { recursive: true, mode: 0o700 });
  const iter = source[Symbol.asyncIterator]();
  let buf: Buffer = Buffer.alloc(0);
  let ended = false;
  const fill = async (n: number): Promise<boolean> => {
    while (buf.length < n && !ended) {
      const r = await iter.next();
      if (r.done) ended = true;
      else {
        const c = typeof r.value === "string" ? Buffer.from(r.value) : Buffer.from(r.value as Uint8Array);
        buf = buf.length ? Buffer.concat([buf, c]) : c;
      }
    }
    return buf.length >= n;
  };

  const links = new Set<string>();
  const summary: UnpackSummary = { files: 0, bytes: 0 };
  let entries = 0;
  let pax: { path?: string; linkpath?: string } | null = null;
  let zeros = 0;

  for (;;) {
    if (!(await fill(BLOCK))) throw new ContextTarError("the context's tar is truncated");
    const h = buf.subarray(0, BLOCK);
    buf = buf.subarray(BLOCK);
    if (h.every((b) => b === 0)) {
      if (++zeros === 2) break;
      continue;
    }
    zeros = 0;
    if (!checksumOk(h)) throw new ContextTarError("a tar header has a bad checksum");
    if (++entries > MAX_ENTRIES) throw new ContextTarError("the context has too many entries");
    const type = String.fromCharCode(h[156]!);
    const size = octal(h.subarray(124, 136));
    const padded = Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") {
      if (size > MAX_PAX) throw new ContextTarError("a pax header is too large");
      if (!(await fill(padded))) throw new ContextTarError("the context's tar is truncated");
      pax = parsePax(buf.subarray(0, size));
      buf = buf.subarray(padded);
      continue;
    }

    const prefix = h.subarray(257, 263).toString("latin1").startsWith("ustar") ? cstr(h.subarray(345, 500)) : "";
    const raw = cstr(h.subarray(0, 100));
    const name = pax?.path ?? (prefix ? `${prefix}/${raw}` : raw);
    const link = pax?.linkpath ?? cstr(h.subarray(157, 257));
    pax = null;
    const parts = cleanPath(name);
    for (let i = 1; i <= parts.length; i++) {
      if (links.has(parts.slice(0, i).join("/"))) throw new ContextTarError(`tar entry ${name.slice(0, 200)} is beneath a link`);
    }
    const rel = parts.join("/");
    const full = join(dest, ...parts);
    const mode = octal(h.subarray(100, 108)) & 0o777;

    if (type === "5") {
      if (size) throw new ContextTarError("a folder entry has a size");
      await mkdir(full, { recursive: true });
    } else if (type === "2") {
      if (size) throw new ContextTarError("a link entry has a size");
      if (!link || link.length > MAX_NAME || link.includes("\0")) throw new ContextTarError(`tar entry ${name.slice(0, 200)} has a bad link target`);
      await mkdir(dirname(full), { recursive: true });
      await symlink(link, full);
      links.add(rel);
    } else if (type === "0" || type === "\0") {
      summary.bytes += size;
      if (summary.bytes > limits.maxBytes) throw new ContextTarError(`the context is larger than ${limits.maxBytes} bytes`);
      await mkdir(dirname(full), { recursive: true });
      // wx: an entry never lands on something already there, a link above all.
      const file = await open(full, "wx", mode || 0o644);
      try {
        let left = size;
        while (left > 0) {
          if (!(await fill(1))) throw new ContextTarError("the context's tar is truncated");
          const piece = buf.subarray(0, Math.min(left, buf.length));
          await file.write(piece);
          buf = buf.subarray(piece.length);
          left -= piece.length;
        }
        await file.chmod(mode || 0o644);
      } finally {
        await file.close();
      }
      if (!(await fill(padded - size))) throw new ContextTarError("the context's tar is truncated");
      buf = buf.subarray(padded - size);
      summary.files++;
    } else {
      const kinds: Record<string, string> = { "1": "a hard link", "3": "a device", "4": "a device", "6": "a FIFO" };
      throw new ContextTarError(`tar entry ${name.slice(0, 200)} is ${kinds[type] ?? `of type ${JSON.stringify(type)}`}, which a build's context cannot hold`);
    }
  }
  return summary;
}
