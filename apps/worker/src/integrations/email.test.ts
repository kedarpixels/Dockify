/**
 * The worker's email delivery with fakes: the sealed message is opened through the vault, sent
 * once with its key, deleted when settled, and neither a retry message nor a permanent
 * failure ever carries the recipient or the code. Alert email goes to admins only.
 */
import { describe, expect, it } from "vitest";
import type { Db, SecretVault } from "@dockify/db";
import { LOGIN_REFUSED, MailError } from "@dockify/email";
import { isPermanentError } from "../errors.ts";
import { fakeMailer, SMTP_ROW } from "../test-mailer.ts";
import { runEmailSend, sendAlertEmails } from "./email.ts";

const MSG = "0f0e0d0c-0000-4000-8000-0000000000aa";
const KEY = "0f0e0d0c-0000-4000-8000-0000000000bb";

function world(opts: { email?: boolean } = {}) {
  const secrets = new Map<string, string>([
    [MSG, JSON.stringify({ to: "someone@example.com", subject: "482913 is your code", html: "<p>482913</p>", text: "482913" })],
    [KEY, "stored-mail-password"],
  ]);
  const integrationUpdates: unknown[] = [];
  const row = { id: "int1", kind: "email", name: "default", status: "connected", secretId: KEY, config: { ...SMTP_ROW, fromName: "Acme", fromAddress: "ops@acme.dev", replyTo: null } };
  const db = {
    integration: {
      findUnique: async () => (opts.email === false ? null : row),
      update: async (q: unknown) => (integrationUpdates.push(q), row),
    },
    secret: { delete: async ({ where }: { where: { id: string } }) => secrets.delete(where.id) },
    instance: { findUnique: async () => ({ name: "Acme Cloud" }) },
    member: {
      findMany: async ({ where }: { where: { role: { in: string[] } } }) =>
        [
          { role: "admin", user: { id: "u1", email: "owner@example.com" } },
          { role: "admin", user: { id: "u2", email: "admin@example.com" } },
          { role: "viewer", user: { id: "u3", email: "viewer@example.com" } },
        ].filter((m) => where.role.in.includes(m.role)),
    },
  };
  const vault: SecretVault = {
    open: async (_tx, ids) => new Map(ids.map((id) => [id, secrets.get(id) ?? null])),
    seal: async () => {
      throw new Error("not used");
    },
    escrow: async () => "",
  };
  return { db: db as unknown as Db, vault, secrets, integrationUpdates };
}

/** The error a call ends with; fails the test when it resolves. */
async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
}

const job = (attempts = 1) => ({ payload: { messageId: MSG }, attempts, maxAttempts: 5 });

describe("email_send", () => {
  it("sends once with the message id as its key, over the stored server, then deletes the sealed message", async () => {
    const w = world();
    const r = fakeMailer();
    expect(await runEmailSend({ ...w, mail: r.mail }, job())).toBe("sent");
    expect(r.calls[0]).toMatchObject({ fromName: "Acme", fromAddress: "ops@acme.dev", to: "someone@example.com", idempotencyKey: MSG });
    expect(r.servers[0]).toEqual({ ...SMTP_ROW, password: "stored-mail-password" });
    expect(w.secrets.has(MSG)).toBe(false);
    expect(await runEmailSend({ ...w, mail: r.mail }, job())).toBe("skipped");
  });

  it("retries a 451 without naming the recipient, and keeps the message", async () => {
    const w = world();
    const busy = new MailError("busy", "busy", { smtpCode: 451, detail: "451 too many emails to someone@example.com" });
    const e = await failure(runEmailSend({ ...w, mail: fakeMailer(() => busy).mail }, job()));
    expect(isPermanentError(e)).toBe(false);
    expect(e.message).not.toContain("someone@example.com");
    expect(w.secrets.has(MSG)).toBe(true);
  });

  it("stops on a refused request or the last attempt, drops the message and redacts the reason", async () => {
    const w = world();
    const refused = new MailError("rejected", "refused", { smtpCode: 554, detail: "554 482913 is your code was rejected for someone@example.com" });
    const e = await failure(runEmailSend({ ...w, mail: fakeMailer(() => refused).mail }, job()));
    expect(isPermanentError(e)).toBe(true);
    expect(e.message).not.toMatch(/someone@example\.com|482913 is your code/);
    expect(w.secrets.has(MSG)).toBe(false);

    const last = world();
    const e2 = await failure(runEmailSend({ ...last, mail: fakeMailer(() => new MailError("unreachable", "no route")).mail }, job(5)));
    expect(isPermanentError(e2)).toBe(true);
  });

  it("marks the integration when the server refuses the login", async () => {
    const w = world();
    await runEmailSend({ ...w, mail: fakeMailer(() => new MailError("auth", "refused", { smtpCode: 535 })).mail }, job()).catch(() => undefined);
    expect(w.integrationUpdates[0]).toMatchObject({ data: { status: "error", error: LOGIN_REFUSED } });
  });

  it("drops the message when email was disconnected meanwhile", async () => {
    const w = world({ email: false });
    const e = await failure(runEmailSend({ ...w, mail: fakeMailer().mail }, job()));
    expect(isPermanentError(e)).toBe(true);
    expect(w.secrets.has(MSG)).toBe(false);
  });

  it("refuses a malformed payload", async () => {
    const w = world();
    const e = await failure(runEmailSend({ ...w, mail: fakeMailer().mail }, { payload: { messageId: "x" }, attempts: 1, maxAttempts: 5 }));
    expect(isPermanentError(e)).toBe(true);
  });
});

describe("alert email", () => {
  it("mails each admin, never a viewer, with a per-person key", async () => {
    const w = world();
    const r = fakeMailer();
    const n = await sendAlertEmails({ ...w, mail: r.mail }, {
      eventId: "ev1", transition: "firing", kind: "appDown", title: "App down", detail: "web failed 3 checks",
      where: { projectName: "horseai", projectSlug: "horseai", env: "production", appName: "web", appKind: "frontend", projectIcon: "https://dockify.example.com/api/icons/mail/p-token" },
      at: new Date("2026-10-30T14:05:00Z"), url: "https://runbooks.example.org/app-down", origin: "https://dockify.example.com",
    });
    expect(n).toBe(2);
    expect(r.keys()).toEqual(["alert:ev1:firing:u1", "alert:ev1:firing:u2"]);
    const sent = r.calls[0]!;
    expect(sent.subject).toBe("Firing: App down, horseai / production / web");
    expect(sent.text).toContain("Where: horseai / production / web");
    // Brand assets load from the dashboard's origin, never from wherever the alert links; the place
    // is the dashboard's chip, with the project's signed icon link and the app's kind tile.
    expect(sent.html).toContain("https://dockify.example.com/dk-logo.png");
    expect(sent.html).toContain("https://dockify.example.com/api/icons/mail/p-token");
    expect(sent.html).toContain("https://dockify.example.com/dk-kind-web.png");
    expect(sent.html).toContain("@font-face");
    expect(sent.html).not.toContain("runbooks.example.org/dk-");
  });

  it("sends nothing when email is not set up", async () => {
    const w = world({ email: false });
    const r = fakeMailer();
    expect(await sendAlertEmails({ ...w, mail: r.mail }, { eventId: "e", transition: "resolved", kind: "alert", title: "t", detail: "d", where: "w", at: new Date(0), url: "https://d.example.com/alerts", origin: "https://d.example.com" })).toBe(0);
    expect(r.calls).toHaveLength(0);
  });
});
