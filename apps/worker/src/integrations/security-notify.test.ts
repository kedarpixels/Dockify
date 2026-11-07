import { describe, expect, it } from "vitest";
import type { Db, SecretVault } from "@dockify/db";
import { MailError } from "@dockify/email";
import { fakeMailer, SMTP_ROW } from "../test-mailer.ts";
import { PermanentJobError } from "../errors.ts";
import { deliverSecurityNotice, parseSecurityNotify } from "./security-notify.ts";

const PAYLOAD = {
  version: "1.4.1",
  level: "critical",
  summary: "A crafted request could read files outside the log folder.",
  advisory: "https://example.com/advisories/1",
  cves: ["CVE-2026-0000"],
  publishedAt: "2026-11-05T10:00:00.000Z",
  current: "1.4.0",
};

const vault: SecretVault = {
  open: async (_tx: unknown, ids: string[]) => new Map(ids.map((id: string) => [id, id === "s-email" ? "re_key" : null])),
  seal: async () => { throw new Error("no seal"); },
  escrow: async () => { throw new Error("no escrow"); },
} as unknown as SecretVault;

function db(o: { email?: boolean; admins?: Array<{ id: string; email: string }> } = {}) {
  return {
    instance: { findUnique: async () => ({ name: "Acme Cloud" }) },
    integration: {
      findUnique: async () => (o.email === false ? null : { id: "i1", secretId: "s-email", status: "connected", config: { ...SMTP_ROW, fromName: "Dockify", fromAddress: "dockify@mail.example.com" } }),
    },
    member: { findMany: async () => (o.admins ?? [{ id: "u1", email: "ana@example.com" }, { id: "u2", email: "sam@example.com" }]).map((user) => ({ user })) },
    secret: { findMany: async () => [] },
    activityLog: { create: async () => ({}) },
  } as unknown as Db;
}


describe("security_notify", () => {
  it("accepts only a well formed security block", () => {
    expect(parseSecurityNotify(PAYLOAD)).toEqual({ version: "1.4.1", level: "critical", summary: PAYLOAD.summary, advisory: PAYLOAD.advisory, cves: PAYLOAD.cves, current: "1.4.0" });
    expect(parseSecurityNotify({ ...PAYLOAD, version: "v1.4.1", advisory: null, cves: undefined, current: null })).toMatchObject({ version: "1.4.1", advisory: null, cves: [], current: null });
    for (const bad of [
      null,
      { ...PAYLOAD, version: "latest" },
      { ...PAYLOAD, level: "low" },
      { ...PAYLOAD, summary: "" },
      { ...PAYLOAD, summary: "x".repeat(601) },
      { ...PAYLOAD, summary: "bell\u0007" },
      { ...PAYLOAD, advisory: "http://example.com/a" },
      { ...PAYLOAD, advisory: "javascript:alert(1)" },
      { ...PAYLOAD, cves: ["CVE-1"] },
      { ...PAYLOAD, current: "x" },
    ]) {
      expect(() => parseSecurityNotify(bad), JSON.stringify(bad)).toThrow(PermanentJobError);
    }
  });

  it("emails every admin once, keyed by release and admin, with the red security variant", async () => {
    const r = fakeMailer();
    const sent = await deliverSecurityNotice({ db: db(), vault, mail: r.mail, publicUrl: "https://dash.example.com" }, PAYLOAD);
    expect(sent).toBe(2);
    expect(r.keys()).toEqual(["security-release:1.4.1:u1", "security-release:1.4.1:u2"]);
    const body = r.calls[0]!;
    expect(body.to).toBe("ana@example.com");
    expect(body.subject).toBe("Important security release: Dockify v1.4.1, Acme Cloud");
    expect(body.html).toContain("/dk-badge-critical.png");
    expect(body.html).toContain('href="https://dash.example.com/server#updates"');
    expect(body.text).toContain("Read the advisory: https://example.com/advisories/1");
    expect(body.text).toContain("CVE: CVE-2026-0000");
  });

  it("sends nothing without email set up or a public URL to link to", async () => {
    const r = fakeMailer();
    expect(await deliverSecurityNotice({ db: db({ email: false }), vault, mail: r.mail, publicUrl: "https://dash.example.com" }, PAYLOAD)).toBe(0);
    expect(await deliverSecurityNotice({ db: db(), vault, mail: r.mail, publicUrl: null }, PAYLOAD)).toBe(0);
    expect(r.calls).toHaveLength(0);
  });

  it("retries a busy mail server and stops on a refusal", async () => {
    await expect(deliverSecurityNotice({ db: db(), vault, mail: fakeMailer(() => new MailError("busy", "busy", { smtpCode: 451 })).mail, publicUrl: "https://dash.example.com" }, PAYLOAD)).rejects.not.toBeInstanceOf(PermanentJobError);
    await expect(deliverSecurityNotice({ db: db(), vault, mail: fakeMailer(() => new MailError("rejected", "no", { smtpCode: 554 })).mail, publicUrl: "https://dash.example.com" }, PAYLOAD)).rejects.toBeInstanceOf(PermanentJobError);
  });
});
