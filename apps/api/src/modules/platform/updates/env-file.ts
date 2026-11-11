/**
 * The one writer of DOCKIFY_PUBLIC_URL after install. .env is root's alone and the updater is not
 * root, so this file also runs as a program in a throwaway root container: `node env-file.ts <install
 * folder> <hostname>`. It must import nothing but node's own modules.
 */
import { chownSync, chmodSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Same grammar as the installer's is_dashboard_host, so nothing but a plain hostname reaches the file. */
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const isPlainHost = (host: string): boolean => HOST.test(host);

export function publicHostOf(env: string): string | null {
  const m = /^DOCKIFY_PUBLIC_URL=https?:\/\/([^/:\s]+)/m.exec(env);
  return m?.[1] ?? null;
}

/** Every other line stays as it was. */
export function withPublicUrl(env: string, host: string): string {
  if (!isPlainHost(host)) throw new Error(`Not a plain hostname: ${host}`);
  const line = `DOCKIFY_PUBLIC_URL=https://${host}`;
  if (!/^DOCKIFY_PUBLIC_URL=/m.test(env)) return `${env.endsWith("\n") || env === "" ? env : `${env}\n`}${line}\n`;
  return env.replace(/^DOCKIFY_PUBLIC_URL=.*$/m, line);
}

/** Writes beside the file and renames over it, so a crash leaves either the old file or the new one. */
export function writePublicUrl(dir: string, host: string, owner: { uid: number; gid: number } | null = { uid: 0, gid: 1000 }): void {
  const file = path.join(dir, ".env");
  const st = lstatSync(file);
  if (st.isSymbolicLink()) throw new Error(`${file} is a symlink`);
  const next = withPublicUrl(readFileSync(file, "utf8"), host);
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, next, { mode: 0o640 });
  if (owner) chownSync(tmp, owner.uid, owner.gid);
  chmodSync(tmp, 0o640);
  renameSync(tmp, file);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, host] = process.argv.slice(2);
  if (!dir || !host) {
    process.stderr.write("usage: env-file.ts <install folder> <hostname>\n");
    process.exit(64);
  }
  try {
    writePublicUrl(dir, host);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
