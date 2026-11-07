/**
 * The public status page said Operational while the app
 * answered 502 and while its container was stopped or crash looping.
 */
import { describe, expect, it } from "vitest";
import { componentState, REACH_FRESH_MS } from "./status.ts";

const now = Date.parse("2026-11-06T10:00:00Z");
const app = (status: string, reachable: boolean | null = null, ageMs = 0) => ({ status, reachable, reachableAt: reachable === null ? null : new Date(now - ageMs) });

describe("componentState", () => {
  it("is an outage when nothing serves, whether or not an alert rule exists", () => {
    for (const s of ["exited", "missing", "failed", "stopped", "unknown"]) expect(componentState([], app(s), now), s).toBe("outage");
  });

  it("is an outage when the container runs but a visitor gets a gateway error", () => {
    expect(componentState([], app("running", false, 60_000), now)).toBe("outage");
    // A verdict older than the freshness window no longer speaks for the app.
    expect(componentState([], app("running", false, REACH_FRESH_MS + 1), now)).toBe("operational");
    expect(componentState([], app("running", true), now)).toBe("operational");
  });

  it("is degraded for a crash loop or a failing health check, and for any open alert but down", () => {
    expect(componentState([], app("restarting"), now)).toBe("degraded");
    expect(componentState([], app("degraded"), now)).toBe("degraded");
    expect(componentState(["memory"], app("running"), now)).toBe("degraded");
    expect(componentState(["down"], app("running"), now)).toBe("outage");
  });

  it("keeps a redeploy, which leaves the old container serving, operational", () => {
    expect(componentState([], app("deploying"), now)).toBe("operational");
  });
});
