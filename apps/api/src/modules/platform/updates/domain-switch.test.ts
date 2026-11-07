import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dashboardDomain as D } from "@dockify/contracts";
import type { Db } from "@dockify/db";
import type { Claimed } from "./engine.ts";
import { envWriterArgs, runDomainSwitch, type DomainSwitchDeps } from "./domain-switch.ts";
import { isPlainHost, publicHostOf, withPublicUrl, writePublicUrl } from "./env-file.ts";

const NEW = "dash.new.example.com";
const OLD = "1-2-3-4.sslip.io";
const NOW = new Date("2026-11-06T12:00:00Z");
const ENV = `# Written by install.sh\nDOCKIFY_DIR=/opt/dockify\nDOCKIFY_PUBLIC_URL=https://${OLD}\nDOCKIFY_INGRESS=direct_tls\n`;
const IMG = `ghcr.io/x/control@sha256:${"a".repeat(64)}`;

const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });
function install(env = ENV) {
  const dir = mkdtempSync(path.join(tmpdir(), "dom-switch-"));
  tmps.push(dir);
  writeFileSync(path.join(dir, ".env"), env);
  return dir;
}

describe("the .env writer", () => {
  it("changes the one line and keeps every other line", () => {
    expect(withPublicUrl(ENV, NEW)).toBe(ENV.replace(`https://${OLD}`, `https://${NEW}`));
    expect(publicHostOf(withPublicUrl(ENV, NEW))).toBe(NEW);
  });
  it("adds the line to a file that lacks it", () => {
    expect(withPublicUrl("A=1", NEW)).toBe(`A=1\nDOCKIFY_PUBLIC_URL=https://${NEW}\n`);
  });
  it("takes only a plain hostname: nothing can smuggle a second line or a compose variable", () => {
    for (const bad of [`${NEW}\nCOMPOSE_PROFILES=x`, "a b.example.com", "https://x.example.com", "x", "$(id).example.com", "EXAMPLE.com"]) {
      expect(isPlainHost(bad), bad).toBe(false);
      expect(() => withPublicUrl(ENV, bad)).toThrow();
    }
    expect(isPlainHost("1-2-3-4.sslip.io")).toBe(true);
  });
  it("replaces the file by rename, and refuses a symlink", () => {
    const dir = install();
    writePublicUrl(dir, NEW, null);
    expect(publicHostOf(readFileSync(path.join(dir, ".env"), "utf8"))).toBe(NEW);
    if (process.platform !== "win32") expect(statSync(path.join(dir, ".env")).mode & 0o777).toBe(0o640);
    if (process.platform === "win32") return;
    const other = install();
    rmSync(path.join(other, ".env"));
    symlinkSync(path.join(dir, ".env"), path.join(other, ".env"));
    expect(() => writePublicUrl(other, NEW, null)).toThrow(/symlink/);
  });
  it("runs as a program: only node's own modules, so it needs nothing but the image", () => {
    const src = readFileSync(path.join(import.meta.dirname, "env-file.ts"), "utf8");
    for (const m of src.matchAll(/from "([^"]+)"/g)) expect(m[1], m[1]).toMatch(/^node:/);
    const dir = install();
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "env-file.ts"), dir], { encoding: "utf8" });
    expect(r.status).toBe(64);
  });
  it("the throwaway container has no network, one capability and one mount", () => {
    const a = envWriterArgs("/opt/dockify", IMG, NEW);
    expect(a.slice(0, 2)).toEqual(["run", "--rm"]);
    expect(a.join(" ")).toContain("--network none --user 0:0 --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges --read-only -v /opt/dockify:/install --entrypoint node");
    expect(a.filter((x) => x === "-v")).toHaveLength(1);
    expect(a.at(-1)).toBe(NEW);
  });
});

interface World {
  row: { dashboardDomain: unknown; dashboardPreviousHosts: string[]; dashboardLastChange: unknown; createdAt: Date };
  raw: string[];
  execs: string[][];
  swaps: string[];
}

function world(pending: Partial<D.PendingDomain> | null = { phase: "switching" }): { w: World; db: Db } {
  const w: World = {
    row: { dashboardDomain: pending ? { ...D.freshPendingDomain(NEW, "Ana", new Date(NOW.getTime() - 60_000)), ...pending } : null, dashboardPreviousHosts: [], dashboardLastChange: null, createdAt: NOW },
    raw: [], execs: [], swaps: [],
  };
  const tx = {
    $executeRaw: async (s: TemplateStringsArray) => {
      w.raw.push(s.join("?"));
      return 1;
    },
    instance: {
      findUnique: async () => w.row,
      update: async ({ data }: { data: Record<string, unknown> }) => void Object.assign(w.row, data),
    },
  };
  return { w, db: { ...tx, $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as Db };
}

function deps(db: Db, w: World, dir: string, over: Partial<DomainSwitchDeps> = {}): DomainSwitchDeps {
  return {
    db,
    steps: {
      currentImages: async () => ({ control: IMG, web: IMG }),
      swap: async (s) => void w.swaps.push(s),
      healthy: async () => null,
    },
    exec: async (cmd, args) => {
      w.execs.push([cmd, ...args]);
      // What the throwaway container does to the file.
      writePublicUrl(dir, args.at(-1)!, null);
      return "";
    },
    cfg: { composeDir: dir },
    probe: { busy: async () => null },
    log: () => undefined,
    now: () => NOW,
    ...over,
  };
}
const job = (payload: object = { host: NEW, from: OLD }): Claimed => ({ id: "11111111-1111-4111-8111-111111111111", payload, attempts: 1, maxAttempts: 3 } as unknown as Claimed);

describe("runDomainSwitch", () => {
  it("rewrites .env, then recreates api, worker and web in that order", async () => {
    const dir = install();
    const { w, db } = world();
    expect(await runDomainSwitch(deps(db, w, dir), job(), "h")).toBe("done");
    expect(publicHostOf(readFileSync(path.join(dir, ".env"), "utf8"))).toBe(NEW);
    expect(w.swaps).toEqual(["api", "worker", "web"]);
    expect(w.raw.some((s) => s.includes('"completedAt" = now()'))).toBe(true);
  });

  it("is safe to repeat: a lease taken over after a crash does not write twice", async () => {
    const dir = install(ENV.replace(OLD, NEW));
    const { w, db } = world();
    expect(await runDomainSwitch(deps(db, w, dir), job(), "h")).toBe("done");
    expect(w.execs).toEqual([]);
    expect(w.swaps).toEqual(["api", "worker", "web"]);
  });

  it("waits for a deploy: recreating the worker would stop it, and the file stays as it is", async () => {
    const dir = install();
    const { w, db } = world();
    const out = await runDomainSwitch(deps(db, w, dir, { probe: { busy: async () => "a deploy" } }), job(), "h");
    expect(out).toContain("waiting");
    expect(w.execs).toEqual([]);
    expect(w.swaps).toEqual([]);
    expect(w.raw.some((s) => s.includes('"runAfter"'))).toBe(true);
    expect(publicHostOf(readFileSync(path.join(dir, ".env"), "utf8"))).toBe(OLD);
  });

  it("gives up after two hours of waiting, with the old address untouched", async () => {
    const dir = install();
    const { w, db } = world({ phase: "switching", requestedAt: new Date(NOW.getTime() - 3 * 3_600_000).toISOString() });
    const out = await runDomainSwitch(deps(db, w, dir, { probe: { busy: async () => "a deploy" } }), job(), "h");
    expect(out).toContain("failed");
    expect(D.readPendingDomain(w.row.dashboardDomain)?.phase).toBe("failed");
    expect(publicHostOf(readFileSync(path.join(dir, ".env"), "utf8"))).toBe(OLD);
  });

  it("goes back when a service does not come up: the old address returns, and the page says why", async () => {
    const dir = install();
    const { w, db } = world();
    let first = true;
    const d = deps(db, w, dir, {
      steps: {
        currentImages: async () => ({ control: IMG, web: IMG }),
        swap: async (s) => {
          w.swaps.push(s);
          if (first && s === "worker") {
            first = false;
            throw new Error("the worker did not report healthy");
          }
        },
        healthy: async () => null,
      },
    });
    // The api's boot on the new address recorded the old one and took the pending row off it.
    w.row.dashboardPreviousHosts = [NEW, "older.example.com"];
    const out = await runDomainSwitch(d, job(), "h");
    expect(out).toContain("failed");
    expect(publicHostOf(readFileSync(path.join(dir, ".env"), "utf8"))).toBe(OLD);
    expect(w.swaps).toEqual(["api", "worker", "api", "worker", "web"]);
    const p = D.readPendingDomain(w.row.dashboardDomain)!;
    expect(p.phase).toBe("failed");
    expect(p.error).toContain(OLD);
    expect(p.error).toContain("did not report healthy");
    // The failed name is not an address the dashboard left.
    expect(w.row.dashboardPreviousHosts).toEqual(["older.example.com"]);
  });

  it("when going back fails too it does not claim where the dashboard is, and says what to do", async () => {
    const dir = install();
    const { w, db } = world();
    const d = deps(db, w, dir, {
      steps: {
        currentImages: async () => ({ control: IMG, web: IMG }),
        swap: async (s) => {
          w.swaps.push(s);
          if (s === "worker") throw new Error("the worker did not report healthy");
        },
        healthy: async () => null,
      },
    });
    const out = await runDomainSwitch(d, job(), "h");
    expect(out).toContain("failed");
    const p = D.readPendingDomain(w.row.dashboardDomain)!;
    expect(p.phase).toBe("failed");
    expect(p.error).toContain("going back");
    expect(p.error).toContain("set-domain");
    expect(p.error).not.toMatch(/went back|stayed where it is/);
  });

  it("goes back when the three are up but not healthy together", async () => {
    const dir = install();
    const { w, db } = world();
    let n = 0;
    const d = deps(db, w, dir, { steps: { currentImages: async () => ({ control: IMG, web: IMG }), swap: async () => undefined, healthy: async () => (n++ === 0 ? "the api is not ready" : null) } });
    expect(await runDomainSwitch(d, job(), "h")).toContain("failed");
    expect(publicHostOf(readFileSync(path.join(dir, ".env"), "utf8"))).toBe(OLD);
  });

  it("refuses a job that does not name a plain hostname, and touches nothing", async () => {
    const dir = install();
    const { w, db } = world();
    expect(await runDomainSwitch(deps(db, w, dir), job({ host: "x\nCOMPOSE_PROFILES=y" }), "h")).toContain("refused");
    expect(w.execs).toEqual([]);
    expect(w.swaps).toEqual([]);
  });
});

