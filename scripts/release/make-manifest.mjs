#!/usr/bin/env node
/*
 * Writes one signed-feed channel file (releases/<channel>.json) for a new release.
 *
 * The shape is the ReleaseFeed schema in apps/api/src/modules/platform/updates/release.ts, and
 * every rule that schema and verifyFeed enforce is checked here too, so a bad manifest fails at
 * release time instead of on every install. Plain Node 22 ESM, no dependencies.
 *
 * The last line on stdout is the minisign trusted comment for scripts/release/sign.sh.
 * Run with --help for the flags. docs/RELEASING.md describes the whole release.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ------------------------------------------------------------------ the rules (mirror release.ts)

export const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/;
export const DIGEST_REF = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::\d{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MIGRATION = /^[0-9a-z_]{1,100}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export const CHANNELS = ["stable", "beta"];
export const ARCHES = ["amd64", "arm64"];
export const MAX_RELEASES = 100;
export const MAX_NOTES = 20_000;
/** A security release's levels: critical (the popup asks again within 3 days) and important (7). */
export const SECURITY_LEVELS = ["critical", "important"];
export const MAX_SUMMARY = 600;
export const MAX_CVES = 20;
const CVE = /^CVE-\d{4}-\d{4,7}$/;
const MAX_URL = 500;
const MAX_REF = 300;

const RELEASE_KEYS = ["version", "date", "publishedAt", "minFrom", "migration", "critical", "notesUrl", "notes", "images", "composeSha256", "socketProxySha256", "security"];
const OPTIONAL_KEYS = new Set(["composeSha256", "socketProxySha256", "security"]);
const SHA_KEYS = ["composeSha256", "socketProxySha256"];
const SECURITY_KEYS = ["level", "summary", "advisory", "cves"];
const FEED_KEYS = ["schema", "channel", "generatedAt", "releases"];

export class ReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseError";
  }
}
const fail = (message) => {
  throw new ReleaseError(message);
};

/** Compares two versions: negative when a < b. A prerelease sorts before its release. */
export function compareVersions(a, b) {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) return a === b ? 0 : a < b ? -1 : 1;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d;
  }
  const ra = pa[4];
  const rb = pb[4];
  if (ra === rb) return 0;
  if (ra === undefined) return 1;
  if (rb === undefined) return -1;
  const xa = ra.split(".");
  const xb = rb.split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const s = xa[i];
    const t = xb[i];
    if (s === undefined) return -1;
    if (t === undefined) return 1;
    const ns = /^\d+$/.test(s);
    const nt = /^\d+$/.test(t);
    if (ns && nt && Number(s) !== Number(t)) return Number(s) - Number(t);
    if (ns !== nt) return ns ? -1 : 1;
    if (s !== t) return s < t ? -1 : 1;
  }
  return 0;
}

export const bare = (v) => String(v).replace(/^v/, "");
export const isPrerelease = (v) => SEMVER.exec(v)?.[4] !== undefined;

export function isCalendarDate(s) {
  if (typeof s !== "string" || !DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

/** A full image reference pinned by digest. A tag, or a tag plus digest, is refused. */
export function checkImageRef(ref, where = "image") {
  if (typeof ref !== "string" || ref === "") fail(`${where}: missing image reference`);
  if (ref.length > MAX_REF) fail(`${where}: image reference is longer than ${MAX_REF} characters`);
  if (!ref.includes("@sha256:")) fail(`${where}: "${ref}" is a tag, not a digest; pass registry/name@sha256:<64 hex>`);
  if (!DIGEST_REF.test(ref)) fail(`${where}: "${ref}" is not a lowercase registry/name@sha256:<64 hex> reference (no tag before the digest)`);
  return ref;
}

export function checkHttpsUrl(url, where = "notesUrl") {
  if (typeof url !== "string" || url.length > MAX_URL) fail(`${where}: must be an https URL of at most ${MAX_URL} characters`);
  let u;
  try {
    u = new URL(url);
  } catch {
    fail(`${where}: "${url}" is not a URL`);
  }
  if (u.protocol !== "https:") fail(`${where}: "${url}" is not https`);
  return url;
}

const checkSemver = (v, where) => {
  if (typeof v !== "string" || !SEMVER.test(v)) fail(`${where}: "${v}" is not a semver version`);
  return v;
};

const checkKeys = (obj, allowed, required, where) => {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) fail(`${where}: must be an object`);
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(`${where}: unknown key "${k}"`);
  for (const k of required) if (!(k in obj)) fail(`${where}: missing "${k}"`);
};

const checkPerArch = (o, where) => {
  checkKeys(o, ARCHES, ARCHES, where);
  for (const a of ARCHES) checkImageRef(o[a], `${where}.${a}`);
};

/**
 * A security block (release.ts SecurityBlock), stricter than an install reads it: the summary is
 * one line of plain text, and nothing it does not know passes, so a typo fails the release instead
 * of being dropped on every install.
 */
export function validateSecurity(s, where = "security") {
  checkKeys(s, SECURITY_KEYS, ["level", "summary"], where);
  if (!SECURITY_LEVELS.includes(s.level)) fail(`${where}.level: "${s.level}" is not one of ${SECURITY_LEVELS.join(", ")}`);
  if (typeof s.summary !== "string" || s.summary.trim() === "") fail(`${where}.summary: say in a sentence or two what the fix closes`);
  if (s.summary !== s.summary.trim()) fail(`${where}.summary: no leading or trailing spaces`);
  if (/[\u0000-\u001f\u007f]/.test(s.summary)) fail(`${where}.summary: one line of plain text, no line breaks or control characters`);
  if (s.summary.length > MAX_SUMMARY) fail(`${where}.summary: ${s.summary.length} characters, the limit is ${MAX_SUMMARY}`);
  if (s.advisory !== undefined) checkHttpsUrl(s.advisory, `${where}.advisory`);
  if (s.cves !== undefined) {
    if (!Array.isArray(s.cves) || s.cves.length === 0) fail(`${where}.cves: a list of CVE ids, or leave the key out`);
    if (s.cves.length > MAX_CVES) fail(`${where}.cves: ${s.cves.length} ids, the limit is ${MAX_CVES}`);
    for (const c of s.cves) if (typeof c !== "string" || !CVE.test(c)) fail(`${where}.cves: "${c}" is not a CVE id like CVE-2026-12345`);
    if (new Set(s.cves).size !== s.cves.length) fail(`${where}.cves: an id is listed twice`);
  }
  return s;
}

/** Every check FeedRelease (zod) makes, with a message that names the field. */
export function validateRelease(r, where = "release") {
  checkKeys(r, RELEASE_KEYS, RELEASE_KEYS.filter((k) => !OPTIONAL_KEYS.has(k)), where);
  checkSemver(r.version, `${where}.version`);
  if (!isCalendarDate(r.date)) fail(`${where}.date: "${r.date}" is not a YYYY-MM-DD date`);
  if (typeof r.publishedAt !== "string" || !ISO.test(r.publishedAt) || Number.isNaN(Date.parse(r.publishedAt))) fail(`${where}.publishedAt: not an ISO datetime`);
  checkSemver(r.minFrom, `${where}.minFrom`);
  if (compareVersions(r.minFrom, r.version) >= 0) fail(`${where}.minFrom: ${r.minFrom} must be older than ${r.version}`);
  if (typeof r.migration !== "string" || !MIGRATION.test(r.migration)) fail(`${where}.migration: "${r.migration}" is not a migration folder name`);
  if (typeof r.critical !== "boolean") fail(`${where}.critical: must be true or false`);
  checkHttpsUrl(r.notesUrl, `${where}.notesUrl`);
  if (typeof r.notes !== "string") fail(`${where}.notes: must be a string`);
  if (r.notes.length > MAX_NOTES) fail(`${where}.notes: ${r.notes.length} characters, the limit is ${MAX_NOTES}`);
  checkKeys(r.images, ["control", "web"], ["control", "web"], `${where}.images`);
  checkPerArch(r.images.control, `${where}.images.control`);
  checkPerArch(r.images.web, `${where}.images.web`);
  for (const k of SHA_KEYS) if (r[k] !== undefined && (typeof r[k] !== "string" || !SHA256.test(r[k]))) fail(`${where}.${k}: not a sha256 hex digest`);
  if (r.security !== undefined) {
    validateSecurity(r.security, `${where}.security`);
    // "Security only" installs take a release by its critical flag; a security release is one.
    if (r.critical !== true) fail(`${where}.critical: a release with a security block is a security release, so critical must be true`);
  }
  return r;
}

/** Every check ReleaseFeed (zod) and verifyFeed make, plus: no prerelease on stable. */
export function validateFeed(feed, where = "feed") {
  checkKeys(feed, FEED_KEYS, FEED_KEYS, where);
  if (feed.schema !== 2) fail(`${where}.schema: ${JSON.stringify(feed.schema)}, expected 2`);
  if (!CHANNELS.includes(feed.channel)) fail(`${where}.channel: "${feed.channel}" is not one of ${CHANNELS.join(", ")}`);
  if (typeof feed.generatedAt !== "string" || !ISO.test(feed.generatedAt) || Number.isNaN(Date.parse(feed.generatedAt))) fail(`${where}.generatedAt: not an ISO datetime`);
  if (!Array.isArray(feed.releases) || feed.releases.length < 1) fail(`${where}.releases: at least one release is required`);
  if (feed.releases.length > MAX_RELEASES) fail(`${where}.releases: ${feed.releases.length} entries, the limit is ${MAX_RELEASES}`);
  feed.releases.forEach((r, i) => validateRelease(r, `${where}.releases[${i}]`));
  const seen = new Set();
  for (const r of feed.releases) {
    if (seen.has(bare(r.version))) fail(`${where}: version ${r.version} is listed twice`);
    seen.add(bare(r.version));
  }
  for (let i = 1; i < feed.releases.length; i++) {
    if (compareVersions(feed.releases[i - 1].version, feed.releases[i].version) <= 0) fail(`${where}: releases are not listed newest first (${feed.releases[i - 1].version} before ${feed.releases[i].version})`);
  }
  if (feed.channel === "stable") {
    const pre = feed.releases.find((r) => isPrerelease(r.version));
    if (pre) fail(`${where}: prerelease ${pre.version} cannot be on the stable channel`);
  }
  return feed;
}

/** Builds one FeedRelease with the keys in schema order. A security block makes it critical. */
export function makeRelease({ version, date, publishedAt, minFrom, migration, critical = false, notesUrl, notes, images, composeSha256, socketProxySha256, security }) {
  const r = {
    version: bare(version),
    date,
    publishedAt,
    minFrom: bare(minFrom),
    migration,
    critical: critical || security !== undefined,
    notesUrl,
    notes,
    images: {
      control: { amd64: images?.control?.amd64, arm64: images?.control?.arm64 },
      web: { amd64: images?.web?.amd64, arm64: images?.web?.arm64 },
    },
  };
  if (composeSha256 !== undefined) r.composeSha256 = composeSha256;
  if (socketProxySha256 !== undefined) r.socketProxySha256 = socketProxySha256;
  if (security !== undefined) {
    validateSecurity(security, "security");
    r.security = { level: security.level, summary: security.summary };
    if (security.advisory !== undefined) r.security.advisory = security.advisory;
    if (security.cves !== undefined) r.security.cves = [...security.cves];
  }
  return validateRelease(r);
}

/** minFrom when --min-from is not given: the previous newest entry's, else 0.0.0. */
export const defaultMinFrom = (previous) => previous?.releases?.[0]?.minFrom ?? "0.0.0";

/**
 * The new channel file: the previous entries carried over, the new release inserted, newest first.
 * Refuses a prerelease on stable, a version already listed (unless replace), a previous file for
 * another channel, and a generatedAt that is not later than the previous one (installs refuse an
 * older feed as a replay).
 */
export function buildFeed({ channel, release, previous = null, generatedAt, replace = false }) {
  if (!CHANNELS.includes(channel)) fail(`channel "${channel}" is not one of ${CHANNELS.join(", ")}`);
  validateRelease(release);
  if (channel === "stable" && isPrerelease(release.version)) fail(`prerelease ${release.version} goes to the beta channel only, never stable`);
  let prior = [];
  if (previous) {
    validateFeed(previous, "previous feed");
    if (previous.channel !== channel) fail(`the previous feed is for the ${previous.channel} channel, not ${channel}`);
    if (!(Date.parse(generatedAt) > Date.parse(previous.generatedAt))) fail(`generatedAt ${generatedAt} is not later than the previous feed's ${previous.generatedAt}`);
    prior = previous.releases;
  }
  const dup = prior.some((r) => bare(r.version) === bare(release.version));
  if (dup && !replace) fail(`${release.version} is already in the ${channel} feed; pass --replace to rewrite that entry`);
  const releases = [release, ...prior.filter((r) => bare(r.version) !== bare(release.version))]
    .sort((a, b) => compareVersions(b.version, a.version))
    .slice(0, MAX_RELEASES);
  const feed = { schema: 2, channel, generatedAt, releases };
  return validateFeed(feed);
}

/** The minisign trusted comment verifyFeed requires: channel and newest version, plus the time. */
export const trustedComment = (feed) => `channel:${feed.channel} version:${feed.releases[0].version} generated:${feed.generatedAt}`;

export const serializeFeed = (feed) => `${JSON.stringify(feed, null, 2)}\n`;

// ------------------------------------------------------------------ release notes

/** Reads the first heading: `## <version> (<YYYY-MM-DD>)` or `## <version> (unreleased)`. */
export function parseNotesHeading(text) {
  const first = String(text).replace(/^﻿/, "").split(/\r?\n/).find((l) => l.trim() !== "");
  const m = first === undefined ? null : /^## (\S+) \((unreleased|\d{4}-\d{2}-\d{2})\)\s*$/.exec(first);
  if (!m) fail(`release notes must start with "## <version> (YYYY-MM-DD)", found: ${first ?? "(empty file)"}`);
  const unreleased = m[2] === "unreleased";
  return { version: m[1], date: unreleased ? null : m[2], unreleased };
}

/** The notes text to publish, or an error when the heading disagrees with this release. */
export function checkNotes(text, version, date) {
  const h = parseNotesHeading(text);
  if (h.unreleased) fail(`the notes for ${h.version} still say "unreleased"; set the heading to "## ${bare(version)} (${date})" first`);
  if (bare(h.version) !== bare(version)) fail(`the notes heading names ${h.version}, but this release is ${bare(version)}`);
  if (h.date !== date) fail(`the notes heading is dated ${h.date}, but the release date is ${date}`);
  const notes = String(text).replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (notes.length > MAX_NOTES) fail(`the notes are ${notes.length} characters, the limit is ${MAX_NOTES}`);
  return notes;
}

// ------------------------------------------------------------------ repository inputs

/** The newest migration folder under packages/db/prisma/migrations. */
export function latestMigration(repoRoot) {
  const dir = join(repoRoot, "packages", "db", "prisma", "migrations");
  if (!existsSync(dir)) fail(`no migrations folder at ${dir}`);
  const names = readdirSync(dir).filter((n) => MIGRATION.test(n) && statSync(join(dir, n)).isDirectory()).sort();
  if (names.length === 0) fail(`no migration folders in ${dir}`);
  return names[names.length - 1];
}

export const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The four digest refs from --digests or the per-image flags (one source, never both). */
export function resolveImages(opts, readJson) {
  const flags = { "control-amd64": opts["control-amd64"], "control-arm64": opts["control-arm64"], "web-amd64": opts["web-amd64"], "web-arm64": opts["web-arm64"] };
  const given = Object.entries(flags).filter(([, v]) => v !== undefined);
  if (opts.digests !== undefined) {
    if (given.length) fail("pass either --digests or the --control-*/--web-* flags, not both");
    const d = readJson(opts.digests);
    checkKeys(d, ["control", "web"], ["control", "web"], "--digests");
    checkPerArch(d.control, "--digests control");
    checkPerArch(d.web, "--digests web");
    return { control: { amd64: d.control.amd64, arm64: d.control.arm64 }, web: { amd64: d.web.amd64, arm64: d.web.arm64 } };
  }
  for (const [k, v] of Object.entries(flags)) if (v === undefined) fail(`missing --${k} (or pass --digests)`);
  const images = { control: { amd64: flags["control-amd64"], arm64: flags["control-arm64"] }, web: { amd64: flags["web-amd64"], arm64: flags["web-arm64"] } };
  for (const [k, v] of Object.entries(flags)) checkImageRef(v, `--${k}`);
  return images;
}

// ------------------------------------------------------------------ command line

const VALUE_FLAGS = ["channel", "version", "date", "previous", "out", "control-amd64", "control-arm64", "web-amd64", "web-arm64", "digests", "notes-url", "notes", "min-from", "repo-root", "compose", "socket-proxy", "generated-at", "security"];
const BOOL_FLAGS = ["critical", "replace", "help"];

export const USAGE = `usage: node scripts/release/make-manifest.mjs --channel stable|beta --version X.Y.Z --out FILE
         (--digests FILE | --control-amd64 REF --control-arm64 REF --web-amd64 REF --web-arm64 REF)
         [--date YYYY-MM-DD] [--previous FILE] [--notes-url URL] [--notes FILE]
         [--min-from X.Y.Z] [--critical] [--security FILE] [--replace] [--repo-root DIR]
         [--compose FILE] [--socket-proxy FILE] [--generated-at ISO]

  --channel        stable or beta (a prerelease version is refused on stable)
  --version        the release version, a leading v is dropped
  --date           release day, default today (UTC); must match the notes heading
  --previous       the currently published <channel>.json; its entries are carried over
  --out            where to write the new <channel>.json
  --digests        JSON {"control":{"amd64":REF,"arm64":REF},"web":{"amd64":REF,"arm64":REF}}
  --*-amd64/arm64  each a registry/name@sha256:<64 hex> per-architecture manifest reference
  --notes-url      https link to the GitHub Release (default from GITHUB_SERVER_URL/GITHUB_REPOSITORY)
  --notes          the notes file, default <repo-root>/docs/releases/<version>.md
  --min-from       oldest version that may upgrade straight to this one (default: previous newest's)
  --critical       mark as a security release (installs set to security only take it)
  --security       the security block, JSON {"level","summary","advisory"?,"cves"?}; default
                   <repo-root>/docs/releases/security/<version>.json when that file exists. It raises the
                   red popup, banner and admin email on every install, and implies --critical
  --replace        allow rewriting an entry for a version already in the feed
  --repo-root      default: two folders above this script
  --compose        default <repo-root>/deploy/docker-compose.yml
  --socket-proxy   default <repo-root>/deploy/socket-proxy/haproxy.cfg
  --generated-at   override the feed timestamp (default now)

The last line on stdout is the minisign trusted comment.`;

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) fail(`unexpected argument "${arg}"`);
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (BOOL_FLAGS.includes(name)) {
      if (eq !== -1) fail(`--${name} takes no value`);
      opts[name] = true;
    } else if (VALUE_FLAGS.includes(name)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || (eq === -1 && value.startsWith("--"))) fail(`--${name} needs a value`);
      if (name in opts) fail(`--${name} given twice`);
      opts[name] = value;
    } else {
      fail(`unknown flag --${name}`);
    }
  }
  return opts;
}

const readJsonFile = (path) => {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    fail(`cannot read ${path}: ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`${path} is not JSON`);
  }
};

/** Runs the whole command: reads inputs, builds, validates and writes the feed. */
export function run(argv, { now = new Date(), cwd = process.cwd(), env = process.env } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) return { help: USAGE };
  const at = (p) => resolve(cwd, p);
  const repoRoot = opts["repo-root"] ? at(opts["repo-root"]) : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

  if (!opts.channel) fail("missing --channel");
  if (!opts.version) fail("missing --version");
  if (!opts.out) fail("missing --out");
  const channel = opts.channel;
  if (!CHANNELS.includes(channel)) fail(`--channel must be one of ${CHANNELS.join(", ")}`);
  const version = bare(checkSemver(opts.version, "--version"));
  if (channel === "stable" && isPrerelease(version)) fail(`prerelease ${version} goes to the beta channel only, never stable`);
  const date = opts.date ?? todayUtc(now);
  if (!isCalendarDate(date)) fail(`--date "${date}" is not a YYYY-MM-DD date`);
  const generatedAt = opts["generated-at"] ?? now.toISOString();
  if (!ISO.test(generatedAt) || Number.isNaN(Date.parse(generatedAt))) fail("--generated-at is not an ISO datetime");

  const previous = opts.previous !== undefined ? readJsonFile(at(opts.previous)) : null;
  const notesPath = opts.notes !== undefined ? at(opts.notes) : join(repoRoot, "docs", "releases", `${version}.md`);
  if (!existsSync(notesPath)) fail(`no release notes at ${notesPath}`);
  const notes = checkNotes(readFileSync(notesPath, "utf8"), version, date);

  let notesUrl = opts["notes-url"];
  if (notesUrl === undefined) {
    if (!env.GITHUB_REPOSITORY) fail("missing --notes-url");
    notesUrl = `${env.GITHUB_SERVER_URL || "https://github.com"}/${env.GITHUB_REPOSITORY}/releases/tag/v${version}`;
  }
  checkHttpsUrl(notesUrl, "--notes-url");
  if (opts["min-from"] !== undefined) checkSemver(opts["min-from"], "--min-from");

  // The security block: --security, else the release's own file beside its notes when there is one.
  const securityPath = opts.security !== undefined ? at(opts.security) : join(repoRoot, "docs", "releases", "security", `${version}.json`);
  if (opts.security !== undefined && !existsSync(securityPath)) fail(`no security block at ${securityPath}`);
  const security = existsSync(securityPath) ? readJsonFile(securityPath) : undefined;

  const composePath = opts.compose !== undefined ? at(opts.compose) : join(repoRoot, "deploy", "docker-compose.yml");
  const proxyPath = opts["socket-proxy"] !== undefined ? at(opts["socket-proxy"]) : join(repoRoot, "deploy", "socket-proxy", "haproxy.cfg");
  for (const p of [composePath, proxyPath]) if (!existsSync(p)) fail(`missing ${p}`);

  const release = makeRelease({
    version,
    date,
    publishedAt: now.toISOString(),
    minFrom: opts["min-from"] ?? defaultMinFrom(previous),
    migration: latestMigration(repoRoot),
    critical: opts.critical === true,
    notesUrl,
    notes,
    images: resolveImages(opts, (p) => readJsonFile(at(p))),
    composeSha256: sha256File(composePath),
    socketProxySha256: sha256File(proxyPath),
    security,
  });
  const feed = buildFeed({ channel, release, previous, generatedAt, replace: opts.replace === true });
  const out = at(opts.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, serializeFeed(feed));
  return { feed, out, comment: trustedComment(feed) };
}

const isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    const res = run(process.argv.slice(2));
    if (res.help) {
      process.stdout.write(`${res.help}\n`);
    } else {
      const top = res.feed.releases[0];
      process.stderr.write(`wrote ${res.out}: ${res.feed.channel}, ${res.feed.releases.length} release(s), newest ${top.version}, migration ${top.migration}, minFrom ${top.minFrom}${top.critical ? ", critical" : ""}${top.security ? `, security release (${top.security.level})` : ""}\n`);
      process.stdout.write(`${res.comment}\n`);
    }
  } catch (e) {
    process.stderr.write(`make-manifest: ${e instanceof ReleaseError ? "" : "unexpected error: "}${e.message}\n`);
    process.exit(1);
  }
}
