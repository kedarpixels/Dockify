/**
 * Getting source onto disk: execFile argv only, https only, redirects off, HOME set to the throwaway dir.
 * The credential is an http.extraHeader in git's environment config, so the token lives only in the git
 * child's environment. Resolution is pinned to the address that passed the public-address check (DNS rebinding).
 */
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { PermanentDeployError } from "@dockify/engine";

export interface CloneCredential {
  username: string;
  secret: string;
}

export interface CheckoutOptions {
  url: string;
  branch: string;
  commit: string | null;
  root: string;
  credential: CloneCredential | null;
  timeoutMs: number;
  maxBytes: number;
  signal: AbortSignal;
  resolve?: (host: string) => Promise<string[]>;
}

export interface Checkout {
  root: string;
  dir: string;
  commit: string;
  subject: string | null;
}

const REPO_URL = /^https:\/\/([a-z0-9.-]+\.[a-z]{2,})\/[\w.-]+\/[\w.-]+?(?:\.git)?$/i;
const BRANCH = /^(?!-|\/|.*\/\/|.*\.\.|.*\/$|.*@\{)[A-Za-z0-9._/-]{1,200}$/;
const SHA = /^[0-9a-f]{40}$/;
const MAX_ENTRIES = 200_000;
const CHECKOUT_PREFIX = "build-";

/** Only globally routable unicast addresses. Covers the IANA special-purpose ranges. */
export function isPublicAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) {
    const [a, b, c] = addr.split(".").map(Number) as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 192 && b === 88 && c === 99) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (v === 6) {
    const s = addr.toLowerCase();
    if (s === "::" || s === "::1") return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (/^(fc|fd|fe[89ab]|ff)/.test(s)) return false; // ULA, link-local, multicast
    if (s.startsWith("64:ff9b:") || s.startsWith("100::") || s.startsWith("2001:db8") || s.startsWith("2001:0db8")) return false;
    const [h1, h2] = s.split(":");
    if (h1 === "2001" && parseInt(h2 || "0", 16) <= 0x1ff) return false; // 2001::/23 IETF protocol assignments
    if (s.startsWith("2002:")) return false; // 6to4
    return /^[23]/.test(s);
  }
  return false;
}

export function repoHost(url: string): string | null {
  return REPO_URL.exec(url)?.[1]?.toLowerCase() ?? null;
}

interface ExecFailure {
  code?: number | string;
  killed?: boolean;
  stderr?: string;
}

function run(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { env, timeout: timeoutMs, maxBuffer: 1_000_000, killSignal: "SIGKILL", windowsHide: true, signal }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve(stdout);
    });
  });
}

const NO_SPACE = /No space left on device|ENOSPC|Disk quota exceeded/i;
const noSpaceMessage = (step: string) => `git ${step} ran out of disk space in the build folder. Free some space (Server, Prune), then deploy again.`;

/** Decides permanent versus retryable from git's stderr, and never echoes the credential. Retrying a full disk only fills it again. */
export function translateGitError(e: ExecFailure, step: string, hadCredential: boolean): Error {
  if (e.code === "ENOENT") return new PermanentDeployError("git is not installed in the worker image");
  if (e.killed) return new Error(`git ${step} timed out`);
  const stderr = (e.stderr ?? "").trim().split("\n").slice(-6).join("\n").slice(0, 1_000);
  if (NO_SPACE.test(stderr)) return new PermanentDeployError(noSpaceMessage(step));
  let text = `git ${step} failed${stderr ? `: ${stderr}` : ""}`;
  if (/Authentication failed|could not read Username|Repository not found|not found|403|401/i.test(stderr)) {
    text += hadCredential
      ? "\nThe GitHub App token was rejected: check the App is installed on the owner and covers this repository."
      : "\nThe clone was anonymous: install the GitHub App on the owning account, or make the repository public.";
  }
  const hopeless = /Authentication failed|could not read Username|Permission denied|Repository not found|not found|does not exist|couldn't find remote ref|invalid path|not our ref/i;
  return hopeless.test(stderr) ? new PermanentDeployError(text) : new Error(text);
}

export async function checkout(o: CheckoutOptions): Promise<Checkout> {
  const host = repoHost(o.url);
  if (!host) throw new PermanentDeployError(`${JSON.stringify(o.url)} is not an https repository URL Dockify clones`);
  if (!BRANCH.test(o.branch)) throw new PermanentDeployError(`${JSON.stringify(o.branch)} is not a valid branch name`);
  if (o.commit !== null && !SHA.test(o.commit)) throw new PermanentDeployError(`${o.commit} is not a full commit sha`);

  const resolveHost = o.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map((r) => r.address));
  let addrs: string[];
  try {
    addrs = await resolveHost(host);
  } catch (e) {
    throw new Error(`could not resolve ${host}: ${(e as Error).message}`);
  }
  const bad = addrs.find((a) => !isPublicAddress(a));
  if (!addrs.length || bad) throw new PermanentDeployError(`${host} resolves to ${bad ?? "nothing"}, which is not a public address; refusing to clone`);
  const pinned = addrs.find((a) => isIP(a) === 4) ?? addrs[0]!;

  await mkdir(o.root, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(o.root, CHECKOUT_PREFIX));
  try {
    const dir = join(root, "repo");
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: root,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_LFS_SKIP_SMUDGE: "1",
    };
    if (o.credential) {
      // Through git's environment config: nothing to execute from the build root, and not -c on argv,
      // where the token would show in the process list. Scoped to this host.
      const basic = Buffer.from(`${o.credential.username}:${o.credential.secret}`).toString("base64");
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = `http.https://${host}/.extraHeader`;
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
    }
    const net = [
      "-c", "http.followRedirects=false",
      "-c", "protocol.allow=never",
      "-c", "protocol.https.allow=always",
      "-c", `http.curloptResolve=${host}:443:${isIP(pinned) === 6 ? `[${pinned}]` : pinned}`,
    ];
    const step = async (args: string[], name: string, ms: number) => {
      try {
        return await run(args, env, ms, o.signal);
      } catch (e) {
        if (o.signal.aborted) throw e;
        throw translateGitError(e as ExecFailure, name, !!o.credential);
      }
    };
    const ref = o.commit ?? `refs/heads/${o.branch}`;
    await step(["init", "--quiet", dir], "init", 30_000);
    await step(["-C", dir, ...net, "fetch", "--quiet", "--depth", "1", "--no-tags", "--", o.url, ref], "fetch", o.timeoutMs);
    await step(["-C", dir, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", "FETCH_HEAD"], "checkout", 60_000);
    const meta = (await step(["-C", dir, "log", "-1", "--no-color", "--format=%H%n%s"], "log", 30_000)).split("\n");
    const commit = (meta[0] ?? "").trim();
    if (!SHA.test(commit)) throw new Error("git did not report a commit; refusing to deploy an unrecorded revision");
    await step(["-C", dir, "read-tree", "HEAD"], "read-tree", 60_000);
    await dropCloneOnlyGitFiles(dir);
    await measure(dir, o.maxBytes);
    return { root, dir, commit, subject: (meta[1] ?? "").trim() || null };
  } catch (e) {
    await discard(root);
    throw e;
  }
}

/**
 * BuildKit hashes every file of the context, `.git` included, so one commit must give the same bytes in every
 * clone or `COPY . .` rebuilds on each deploy. The reflog and FETCH_HEAD differ per clone, and no build needs them.
 */
export async function dropCloneOnlyGitFiles(dir: string): Promise<void> {
  await rm(join(dir, ".git", "logs"), { recursive: true, force: true });
  await rm(join(dir, ".git", "FETCH_HEAD"), { force: true });
}

export async function discard(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}

/** Removes checkouts a crash left behind. Only at worker boot, when no build of this worker can be running. */
export async function sweepCheckouts(root: string): Promise<number> {
  const names = await readdir(root).catch(() => [] as string[]);
  const stale = names.filter((n) => n.startsWith(CHECKOUT_PREFIX));
  await Promise.all(stale.map((n) => discard(join(root, n))));
  return stale.length;
}

async function measure(dir: string, maxBytes: number): Promise<void> {
  let total = 0;
  let entries = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const ent of await readdir(cur, { withFileTypes: true })) {
      if (++entries > MAX_ENTRIES) throw new PermanentDeployError(`the checkout holds more than ${MAX_ENTRIES} files`);
      const p = join(cur, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && (total += (await lstat(p)).size) > maxBytes) {
        throw new PermanentDeployError(`the checkout is larger than the ${Math.round(maxBytes / 1024 ** 2)} MiB build limit`);
      }
    }
  }
}

