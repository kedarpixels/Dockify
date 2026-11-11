/**
 * Validates a tar stream before it is extracted into a volume: a tampered archive could write anywhere in
 * the container. Every entry must be a plain file or directory inside the archive root. Links, devices,
 * FIFOs, absolute paths and ".." are refused. Reads ustar, GNU long names and pax headers, nothing else.
 */
import { Writable } from "node:stream";

export class TarGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarGuardError";
  }
}

const BLOCK = 512;
const MAX_META = 1024 * 1024;

function cstr(b: Buffer): string {
  const z = b.indexOf(0);
  return b.subarray(0, z === -1 ? b.length : z).toString("utf8");
}

function octal(b: Buffer): number {
  // Base-256 (high bit set) sizes are for files over 8 GiB; refuse rather than misparse.
  if (b[0]! & 0x80) throw new TarGuardError("tar entry uses a base-256 size, which is not supported");
  const s = cstr(b).trim();
  if (s && !/^[0-7]+$/.test(s)) throw new TarGuardError("tar header has a malformed size");
  return s ? parseInt(s, 8) : 0;
}

/** `backslash`: allowed in an archive of volumes, where GNU tar on Linux extracts it as any other character of a name. */
export function checkEntryPath(name: string, backslash = false): void {
  const n = name.replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (n === "" || n === ".") return; // the archive root itself
  if (name.startsWith("/") || (!backslash && name.includes("\\")) || name.includes("\0")) throw new TarGuardError(`tar entry ${name} is not a relative path`);
  if (n.split("/").some((p) => p === "..")) throw new TarGuardError(`tar entry ${name} leaves the volume`);
}

/** A header's numeric field: octal, or base-256 when the high bit is set (a gid past 2097151). Null when it is neither. */
function numeric(b: Buffer): number | null {
  if (b[0]! & 0x80) {
    let n = b[0]! & 0x7f;
    for (const byte of b.subarray(1)) n = n * 256 + byte;
    return Number.isSafeInteger(n) ? n : null;
  }
  const s = cstr(b).trim();
  return /^[0-7]+$/.test(s) ? parseInt(s, 8) : null;
}

function paxRecords(data: Buffer, links: boolean): { path: string | null; size: number | null; link: string | null; gid: number | null } {
  let o = 0;
  let path: string | null = null;
  let size: number | null = null;
  let link: string | null = null;
  let gid: number | null = null;
  while (o < data.length) {
    const sp = data.indexOf(0x20, o);
    if (sp === -1) break;
    const len = Number(data.subarray(o, sp).toString("ascii"));
    if (!Number.isInteger(len) || len <= 0 || o + len > data.length) throw new TarGuardError("malformed pax header");
    const rec = data.subarray(sp + 1, o + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    const key = rec.slice(0, eq);
    if (key === "path") path = rec.slice(eq + 1);
    if (key === "linkpath") {
      if (!links) throw new TarGuardError("tar entry carries a link path");
      link = rec.slice(eq + 1);
    }
    if (key === "gid" && /^\d{1,10}$/.test(rec.slice(eq + 1))) gid = Number(rec.slice(eq + 1));
    if (key === "size") {
      // An extractor reads this many bytes whatever the header says: read as many, or lose the place.
      if (!/^\d{1,15}$/.test(rec.slice(eq + 1))) throw new TarGuardError("malformed pax size");
      size = Number(rec.slice(eq + 1));
    }
    o += len;
  }
  return { path, size, link, gid };
}

/**
 * The header's own name of an entry that a long name or a pax path renames: an extractor that
 * skips those writes this one. It may be cut at the field's 100 bytes, so a last part cut there
 * is not held against it.
 */
function ownName(prefix: string, raw: Buffer): string {
  const name = cstr(raw);
  const full = prefix ? `${prefix}/${name}` : name;
  return raw.indexOf(0) === -1 ? full.slice(0, full.lastIndexOf("/") + 1) : full;
}

const topOf = (name: string): string => name.replace(/^\.\/+/, "").split("/")[0]!;

export interface TarSummary {
  files: number;
  dirs: number;
  bytes: number;
}

const SETGID = 0o2000;
/** Past this many the list is cut and `setgidCut` says so: a restore then names how many it put back. */
export const MAX_SETGID = 50_000;

/** A file or folder whose setgid bit a restore puts back by hand (volume-backup.ts restoreSetgid). */
export interface SetgidEntry {
  path: string;
  gid: number;
}

/** An app keeps at most ten volumes; an archive with more top-level names than this is not one of ours. */
const MAX_ROOTS = 64;

export interface TarGuardOptions {
  /**
   * An archive of app volumes, one top-level folder each. Symlinks are kept as text (GNU tar never writes
   * through one that is absolute or has ".."), and a hard link must point inside its own volume's folder.
   * Any name Linux allows passes, a backslash too.
   */
  volumes?: boolean;
}

/** A sink that throws on the first bad entry. Pipe the archive into it; `summary` is set at finish. */
export class TarGuard extends Writable {
  #buf: Buffer = Buffer.alloc(0);
  #skip = 0;
  #meta: { type: string; left: number; parts: Buffer[] } | null = null;
  #nextName: string | null = null;
  #nextSize: number | null = null;
  #nextLink: string | null = null;
  #zeroBlocks = 0;
  #ended = false;
  readonly #volumes: boolean;
  readonly #roots = new Set<string>();
  summary: TarSummary = { files: 0, dirs: 0, bytes: 0 };
  /** Volumes only: the links kept, and the top-level names in the order met. */
  links = 0;
  readonly roots: string[] = [];
  /** Volumes only: the files and folders that carry the setgid bit, with the group they belong to. */
  readonly setgid: SetgidEntry[] = [];
  setgidCut = false;
  #nextGid: number | null = null;

  constructor(opts: TarGuardOptions = {}) {
    super();
    this.#volumes = opts.volumes ?? false;
  }

  override _write(chunk: Buffer, _e: BufferEncoding, cb: (e?: Error | null) => void): void {
    try {
      this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
      this.#drain();
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }

  override _final(cb: (e?: Error | null) => void): void {
    if (!this.#ended && (this.#skip > 0 || this.#meta)) return cb(new TarGuardError("tar archive is truncated"));
    cb();
  }

  #drain(): void {
    for (;;) {
      if (this.#ended) {
        this.#buf = Buffer.alloc(0);
        return;
      }
      if (this.#skip > 0) {
        const n = Math.min(this.#skip, this.#buf.length);
        if (this.#meta) {
          const take = Math.min(n, this.#meta.left);
          this.#meta.parts.push(this.#buf.subarray(0, take));
          this.#meta.left -= take;
        }
        this.#buf = this.#buf.subarray(n);
        this.#skip -= n;
        if (this.#skip > 0) return;
        if (this.#meta) this.#finishMeta();
        continue;
      }
      if (this.#buf.length < BLOCK) return;
      const h = this.#buf.subarray(0, BLOCK);
      this.#buf = this.#buf.subarray(BLOCK);
      if (h.every((b) => b === 0)) {
        if (++this.#zeroBlocks >= 2) this.#ended = true;
        continue;
      }
      this.#zeroBlocks = 0;
      this.#header(h);
    }
  }

  #finishMeta(): void {
    const m = this.#meta!;
    this.#meta = null;
    const data = Buffer.concat(m.parts);
    if (m.type === "L") {
      this.#nextName = cstr(data);
      return;
    }
    if (m.type === "K") {
      this.#nextLink = cstr(data);
      return;
    }
    const pax = paxRecords(data, this.#volumes);
    if (m.type === "x") {
      this.#nextName = pax.path ?? this.#nextName;
      this.#nextSize = pax.size ?? this.#nextSize;
      this.#nextLink = pax.link ?? this.#nextLink;
      this.#nextGid = pax.gid ?? this.#nextGid;
    } else if (pax.path !== null || pax.size !== null || pax.link !== null) {
      throw new TarGuardError("tar global header sets a path, a size or a link");
    }
  }

  #header(h: Buffer): void {
    const type = String.fromCharCode(h[156]!) === "\0" ? "0" : String.fromCharCode(h[156]!);
    const meta = type === "L" || type === "x" || type === "g" || (type === "K" && this.#volumes);
    const size = meta || this.#nextSize === null ? octal(h.subarray(124, 136)) : this.#nextSize;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (meta) {
      if (size > MAX_META) throw new TarGuardError("tar metadata entry is too large");
      this.#meta = { type, left: size, parts: [] };
      this.#skip = padded;
      return;
    }
    const prefix = h.subarray(257, 263).toString("latin1").startsWith("ustar") ? cstr(h.subarray(345, 500)) : "";
    const raw = h.subarray(0, 100);
    const name = this.#nextName ?? (prefix ? `${prefix}/${cstr(raw)}` : cstr(raw));
    if (this.#nextName !== null) checkEntryPath(ownName(prefix, raw), this.#volumes);
    const link = this.#nextLink ?? cstr(h.subarray(157, 257));
    this.#nextName = null;
    this.#nextSize = null;
    this.#nextLink = null;
    const gid = this.#nextGid ?? numeric(h.subarray(116, 124));
    this.#nextGid = null;
    checkEntryPath(name, this.#volumes);
    if (this.#volumes) this.#root(name);
    if (type === "0" || type === "7" || type === "5") {
      if (type === "5") this.summary.dirs++;
      else {
        this.summary.files++;
        this.summary.bytes += size;
      }
      if (this.#volumes && gid !== null && ((numeric(h.subarray(100, 108)) ?? 0) & SETGID)) {
        if (this.setgid.length < MAX_SETGID) this.setgid.push({ path: name, gid });
        else this.setgidCut = true;
      }
    } else if (this.#volumes && (type === "1" || type === "2")) {
      if (type === "1") {
        if (!link.replace(/^\.\/+/, "")) throw new TarGuardError(`tar entry ${name} is a hard link to nothing`);
        checkEntryPath(link, true);
        // A real hard link never crosses a mount, so its target is in the entry's own volume folder.
        if (topOf(link) !== topOf(name)) throw new TarGuardError(`tar entry ${name} is a hard link into another volume`);
      }
      this.links++;
    } else {
      const kinds: Record<string, string> = { "1": "a hard link", "2": "a symlink", "3": "a device", "4": "a device", "6": "a FIFO" };
      throw new TarGuardError(`tar entry ${name} is ${kinds[type] ?? `of type ${type}`}, which a restore does not accept`);
    }
    this.#skip = padded;
  }

  #root(name: string): void {
    const top = topOf(name);
    if (!top || this.#roots.has(top)) return;
    if (this.#roots.size >= MAX_ROOTS) throw new TarGuardError("tar archive has too many top-level entries to be a backup of volumes");
    this.#roots.add(top);
    this.roots.push(top);
  }
}
