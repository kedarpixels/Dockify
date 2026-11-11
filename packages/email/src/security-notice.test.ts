import { describe, expect, it } from "vitest";
import { securityNotice } from "./templates.ts";

const base = { instanceName: "Acme", origin: "https://d.example.com", at: new Date("2026-11-07T00:00:00Z"), url: "https://d.example.com/settings?section=security" };

describe("the notice for too many wrong two-factor codes", () => {
  it("says codes are paused and what to do if it was someone else", () => {
    const m = securityNotice({ ...base, event: "mfaLocked", device: "Firefox on Windows", ip: "203.0.113.9" }, "light");
    expect(m.subject).toBe("Too many wrong two-factor codes on your Acme account");
    expect(m.text).toContain("change your password");
    expect(m.text).toContain("203.0.113.9");
    expect(m.text + m.subject).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("what a password notice says about API tokens", () => {
  it("a change says they keep working, and where to revoke them", () => {
    const m = securityNotice({ ...base, event: "password" }, "light");
    expect(m.text).toContain("API tokens keep working");
    expect(m.text).toContain("Settings, API tokens");
  });

  it("a reset says they were revoked", () => {
    const m = securityNotice({ ...base, event: "passwordReset" }, "light");
    expect(m.subject).toBe("Your password was reset on your Acme account");
    expect(m.text).toContain("your API tokens were revoked");
  });
});
