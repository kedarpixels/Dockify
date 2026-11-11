/**
 * Traefik watches exactly <dir>/conf. A file is written in <dir>/.staging, on the same volume and outside the
 * watched folder, then renamed in, so Traefik never reads half a file.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RouteChange, RouteStore } from "./seam.ts";

/** The watched folder and the staging folder, both under the route root on one volume. */
export const ROUTES_SUBDIR = "conf";
export const STAGING_SUBDIR = ".staging";

/** A bare file name: no folder, nothing hidden, and only what the route writer makes. */
const FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.yml$/;
/** A staging temp this old is what a crash left between its write and its rename. */
const STALE_TEMP_MS = 3_600_000;

const checked = (name: string): string => {
  if (!FILE_NAME.test(name)) throw new Error(`A route file name must be a bare *.yml, got ${JSON.stringify(name).slice(0, 80)}`);
  return name;
};

export function fileRouteStore(dir: string, opts: { now?: () => number } = {}): RouteStore {
  const conf = join(dir, ROUTES_SUBDIR);
  const staging = join(dir, STAGING_SUBDIR);

  const sweepStaging = async (): Promise<void> => {
    const now = opts.now?.() ?? Date.now();
    for (const name of await readdir(staging).catch(() => [] as string[])) {
      const path = join(staging, name);
      const info = await stat(path).catch(() => null);
      if (info && now - info.mtimeMs > STALE_TEMP_MS) await rm(path, { force: true }).catch(() => {});
    }
  };

  return {
    read: async (name) => readFile(join(conf, checked(name)), "utf8").catch(() => null),

    async snapshot() {
      const files: Record<string, string> = {};
      for (const name of await readdir(conf).catch(() => [] as string[])) {
        if (!FILE_NAME.test(name)) continue;
        const text = await readFile(join(conf, name), "utf8").catch(() => null);
        if (text !== null) files[name] = text;
      }
      return files;
    },

    async apply(change: RouteChange) {
      const writes = Object.entries(change.writes ?? {}).map(([name, content]) => ({ name: checked(name), content }));
      const removes = (change.removes ?? []).map(checked);
      await mkdir(conf, { recursive: true });
      await mkdir(staging, { recursive: true });
      await sweepStaging();
      // Every temp is on disk before the first rename, so a failed write changes nothing Traefik sees.
      const staged: Array<{ tmp: string; name: string }> = [];
      try {
        for (const w of writes) {
          const tmp = join(staging, `${w.name}.${randomUUID()}.tmp`);
          staged.push({ tmp, name: w.name });
          await writeFile(tmp, w.content, { mode: 0o644 });
        }
        // Removes first, then the writes in order: a host moving between apps reads a short 404, never two owners.
        for (const name of removes) await rm(join(conf, name), { force: true });
        for (const s of staged) await rename(s.tmp, join(conf, s.name));
      } catch (e) {
        for (const s of staged) await rm(s.tmp, { force: true }).catch(() => {});
        throw e;
      }
    },
  };
}
