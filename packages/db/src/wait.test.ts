import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { tcpProbe, waitUntilReachable } from "./wait.ts";

/** A log that records, a clock the fake sleep moves, and a probe that fails `n` times. */
function harness(failures: number, stepMs = 1_000) {
  const lines: Array<[string, string]> = [];
  let t = 0;
  let calls = 0;
  const delays: number[] = [];
  return {
    lines,
    delays,
    calls: () => calls,
    probe: async () => {
      calls++;
      if (calls <= failures) throw Object.assign(new Error("connect ECONNREFUSED 172.30.2.5:5432"), { code: "ECONNREFUSED" });
    },
    opts: {
      log: { info: (m: string) => void lines.push(["info", m]), error: (m: string) => void lines.push(["error", m]) },
      sleep: async (ms: number) => {
        delays.push(ms);
        t += Math.max(ms, stepMs);
      },
      now: () => t,
    },
  };
}

describe("waiting for a dependency at boot", () => {
  it("says nothing when the first try works", async () => {
    const h = harness(0);
    expect(await waitUntilReachable("the database", h.probe, h.opts)).toBe(true);
    expect(h.lines).toEqual([]);
  });

  it("logs once when it starts waiting and once when it is reachable, with backoff in between", async () => {
    const h = harness(4);
    expect(await waitUntilReachable("the database", h.probe, h.opts)).toBe(true);
    expect(h.lines).toEqual([["info", "waiting for the database"], ["info", "the database is reachable"]]);
    expect(h.delays).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it("logs a single error only once the failure has lasted long enough to be an outage", async () => {
    const h = harness(40);
    expect(await waitUntilReachable("Docker", h.probe, { ...h.opts, sustainedMs: 60_000, maxDelayMs: 15_000 })).toBe(true);
    const errors = h.lines.filter(([l]) => l === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]![1]).toMatch(/^Docker has been unreachable for \d+ s; still retrying$/);
    expect(h.lines.filter(([l]) => l === "info").map(([, m]) => m)).toEqual(["waiting for Docker", "Docker is reachable"]);
    expect(Math.max(...h.delays)).toBe(15_000);
  });

  it("gives up quietly when stopped", async () => {
    const h = harness(1_000);
    const ac = new AbortController();
    let n = 0;
    const out = await waitUntilReachable("the database", h.probe, { ...h.opts, signal: ac.signal, sleep: async () => void (++n === 3 && ac.abort()) });
    expect(out).toBe(false);
    expect(h.lines.filter(([l]) => l === "error")).toEqual([]);
  });
});

describe("the database port probe", () => {
  it("passes when something listens, fails when nothing does", async () => {
    const server = createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    await expect(tcpProbe(`postgresql://dockify:secret@127.0.0.1:${port}/dockify`)()).resolves.toBeUndefined();
    await new Promise<void>((r) => server.close(() => r()));
    await expect(tcpProbe(`postgresql://dockify:secret@127.0.0.1:${port}/dockify`, 1_000)()).rejects.toThrow();
  });
});
