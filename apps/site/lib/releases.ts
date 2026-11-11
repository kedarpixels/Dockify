import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { REPO } from "@/lib/site";

/* One docs/releases/<version>.md per release, headed "## 1.1.0 (2026-11-03)" or "## 1.0.0 (unreleased)".
   The prebuild copies them into content/releases/, the only folder read here. */

export type Release = {
  version: string;
  /** ISO date of the signed release; null while unreleased. */
  date: string | null;
  summary: string;
  /** Link to the signed release; absent while unreleased or while the repository is not set. */
  signed?: string;
  groups: { title: string; items: string[] }[];
};

const DIR = path.join(process.cwd(), "content", "releases");

const HEAD = /^##\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s+\((\d{4}-\d{2}-\d{2}|unreleased)\)\s*$/;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-03" as "3 Nov 2026", the way the dashboard writes an absolute day. */
export function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-").map((n) => Number.parseInt(n, 10));
  return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : iso;
}

/** Lines before the first release heading are ignored. */
function parseNotes(source: string): Release[] {
  const out: Release[] = [];
  let cur: Release | null = null;
  let group: Release["groups"][number] | null = null;
  let summary: string[] = [];
  let summaryDone = false;

  const finish = () => {
    if (!cur) return;
    cur.summary = summary.join(" ").trim();
    cur.groups = cur.groups.filter((g) => g.items.length > 0);
    out.push(cur);
  };

  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const head = HEAD.exec(line);
    if (head) {
      finish();
      const version = head[1]!;
      const date = head[2] === "unreleased" ? null : head[2]!;
      cur = { version, date, summary: "", groups: [] };
      if (date !== null && REPO) cur.signed = `${REPO}/releases/tag/v${version}`;
      group = null;
      summary = [];
      summaryDone = false;
      continue;
    }
    if (!cur) continue;
    const g = /^###\s+(.+?)\s*$/.exec(line);
    if (g) {
      group = { title: g[1]!, items: [] };
      cur.groups.push(group);
      summaryDone = true;
      continue;
    }
    const item = /^\s*[-*]\s+(.+)$/.exec(line);
    if (item && group) {
      group.items.push(item[1]!.trim());
      continue;
    }
    if (group) {
      // A wrapped list item continues the previous one.
      if (line.trim() && /^\s+\S/.test(line) && group.items.length > 0) {
        group.items[group.items.length - 1] += ` ${line.trim()}`;
      }
      continue;
    }
    // Before the first group: the first paragraph is the summary.
    if (summaryDone) continue;
    if (line.trim()) summary.push(line.trim());
    else if (summary.length > 0) summaryDone = true;
  }
  finish();
  return out;
}

function parseVersion(v: string) {
  const [core = "", pre] = v.split("-", 2);
  const nums = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
  return { nums, pre };
}

/** Semver order, newest first. A pre-release sorts below its release. */
function compareDesc(a: string, b: string) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const d = (y.nums[i] ?? 0) - (x.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return -1;
  if (!y.pre) return 1;
  return y.pre.localeCompare(x.pre, undefined, { numeric: true });
}

/** Every release in the notes, newest first. Empty when there are no notes yet. */
export async function loadReleases(): Promise<Release[]> {
  let names: string[];
  try {
    names = (await readdir(DIR)).filter((n) => /^[0-9A-Za-z.-]+\.md$/.test(n));
  } catch {
    return [];
  }
  const all: Release[] = [];
  for (const name of names) {
    try {
      all.push(...parseNotes(await readFile(path.join(DIR, name), "utf8")));
    } catch {
      // An unreadable file is skipped rather than taking the page down.
    }
  }
  const seen = new Set<string>();
  return all
    .sort((a, b) => compareDesc(a.version, b.version))
    .filter((r) => (seen.has(r.version) ? false : (seen.add(r.version), true)));
}
