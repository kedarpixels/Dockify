/**
 * preview_notify with fakes: who reads it, when it is owed, what it leaves out, and a retry that
 * never sends twice. No real email: the mailer only records.
 */
import type { Db, SecretVault } from "@dockify/db";
import { MailError, type OutgoingEmail } from "@dockify/email";
import { fakeMailer, SMTP_ROW } from "../test-mailer.ts";
import { describe, expect, it } from "vitest";
import { failureLines, firstErrorLine, previewNoticeFor, settlePreview } from "../deploy/preview.ts";
import { deliverPreviewNotice, parsePreviewNotify } from "./preview-notify.ts";

const ID = "7b0a4f6e-9c1d-4e2a-8f3b-1a2b3c4d5e6f";
const SHA = "4f2a9c1e".padEnd(40, "0");
const KEY = "11111111-1111-4111-8111-111111111111";
const VERIFIED = new Date("2026-10-01T00:00:00Z");

type User = { id: string; email: string; githubLogin: string | null; githubVerifiedAt: Date | null; member: boolean; admin: boolean; disabledAt: Date | null };

const BUILD_ERROR = 'The build failed (buildctl exit 1). Its last lines:\n#9 npm error Missing script: "build"\nERROR: see https://evil.example/x and @maintainer <img src=x>';

function world(opts: { env?: Record<string, unknown>; users?: User[]; events?: unknown; email?: boolean; status?: number } = {}) {
  const users: User[] = opts.users ?? [
    { id: "u1", email: "sam@example.com", githubLogin: "sam", githubVerifiedAt: VERIFIED, member: true, admin: false, disabledAt: null },
    { id: "a1", email: "boss@example.com", githubLogin: "boss", githubVerifiedAt: VERIFIED, member: true, admin: true, disabledAt: null },
    { id: "a2", email: "gone-admin@example.com", githubLogin: null, githubVerifiedAt: null, member: true, admin: true, disabledAt: new Date() },
    { id: "u3", email: "left@example.com", githubLogin: "left", githubVerifiedAt: VERIFIED, member: false, admin: false, disabledAt: null },
    { id: "u4", email: "squat@example.com", githubLogin: "squat", githubVerifiedAt: null, member: true, admin: false, disabledAt: null },
  ];
  const env: Record<string, unknown> = {
    prNumber: 42, title: "Fix the header, see https://evil.example/pay", author: "sam", branch: "fix/header", commitSha: SHA, repo: "acme/web", status: "failed",
    error: "The build failed (buildctl exit 1).", fromFork: false, isolatedDb: true, notifiedKey: `failed:${SHA}`,
    baseEnvironment: { name: "production" }, project: { slug: "acme", previewProductionAccess: false, environments: [{ id: "a" }, { id: "b" }] },
    apps: [{ hostname: "pr-42-web.preview.example.com", currentDeploymentId: null, app: { port: 3000 }, deployments: [{ status: "failed", error: BUILD_ERROR }] }],
    ...opts.env,
  };
  const updates: unknown[] = [];
  const row = { id: "int1", kind: "email", name: "default", status: "connected", secretId: KEY, config: { ...SMTP_ROW, fromName: "Acme", fromAddress: "ops@acme.dev", replyTo: null } };
  const db = {
    previewEnv: {
      findUnique: async () => env,
      updateMany: async (a: unknown) => (updates.push(a), { count: 1 }),
    },
    user: {
      findFirst: async ({ where }: { where: { githubLogin: string } }) => {
        const u = users.find((x) => x.member && !x.disabledAt && x.githubVerifiedAt && x.githubLogin === where.githubLogin);
        return u ? { id: u.id, email: u.email } : null;
      },
    },
    member: { findMany: async () => users.filter((u) => u.member && u.admin && !u.disabledAt).map((u) => ({ user: { id: u.id, email: u.email } })) },
    integration: { findUnique: async () => (opts.email === false ? null : row), update: async () => row },
    activityLog: { create: async () => ({}) },
    instance: { findUnique: async () => ({ name: "Acme Cloud", notifyEvents: opts.events ?? {} }) },
  };
  const vault: SecretVault = {
    open: async (_tx, ids) => new Map(ids.map((id) => [id, id === KEY ? "re_live_abcdefghijklmnop" : null])),
    seal: async () => {
      throw new Error("not used");
    },
    escrow: async () => "",
  };
  const r = fakeMailer(() => (opts.status === 503 ? new MailError("busy", "busy", { smtpCode: 451 }) : opts.status === 422 ? new MailError("rejected", "no", { smtpCode: 554 }) : null));
  return { deps: { db: db as unknown as Db, vault, mail: r.mail, publicUrl: "https://dockify.example.com" }, calls: r.calls, updates, to: r.to };
}

const FAILED = { previewId: ID, state: "failed", commit: SHA };
const body = (c: OutgoingEmail) => c;

describe("who reads a preview email", () => {
  it("goes to the member whose verified login opened the pull request, and only them", async () => {
    const w = world();
    expect(await deliverPreviewNotice(w.deps, FAILED)).toBe("sent");
    expect(w.to()).toEqual(["sam@example.com"]);
    expect(body(w.calls[0]!).text).toContain("because you opened this pull request");
  });

  for (const [why, author] of [["a stranger", "stranger"], ["an unverified login", "squat"], ["someone who left the team", "left"], ["no author", null]] as const) {
    it(`falls back to current admins for ${why}, never mailing the author`, async () => {
      const w = world({ env: { author, fromFork: true } });
      expect(await deliverPreviewNotice(w.deps, FAILED)).toBe("sent");
      expect(w.to()).toEqual(["boss@example.com"]);
      expect(body(w.calls[0]!).text).toContain("the pull request's author is not a member");
    });
  }

  it("sends nothing with the toggle off, without email, or with no admin to tell", async () => {
    expect(await deliverPreviewNotice(world({ events: { previewDeployments: false } }).deps, FAILED)).toBe("skipped");
    expect(await deliverPreviewNotice(world({ email: false }).deps, FAILED)).toBe("skipped");
    expect(await deliverPreviewNotice(world({ env: { author: "x" }, users: [] }).deps, FAILED)).toBe("skipped");
    expect(await deliverPreviewNotice(world({ events: {} }).deps, FAILED)).toBe("sent");
  });
});

describe("what a preview email says", () => {
  it("quotes the last build lines with links, mentions and markup gone, and the reason without a dangling promise", async () => {
    const w = world();
    await deliverPreviewNotice(w.deps, FAILED);
    const m = body(w.calls[0]!);
    expect(m.subject).toContain("Preview failed: acme/web #42");
    expect(m.text).toContain('#9 npm error Missing script: "build"');
    expect(m.text).toContain("[link]");
    for (const part of [m.html, m.text]) {
      expect(part).not.toContain("evil.example");
      expect(part).not.toContain("@maintainer");
      expect(part).not.toContain("<img src=x>");
      expect(part).not.toContain("Its last lines");
    }
    expect(m.text).toContain("Commit: 4f2a9c1");
    expect(m.text).toContain("Database: Its own temporary database, separate from your real data");
    // Nothing serves: no link to a page that is not there.
    expect(m.html).not.toContain("pr-42-web.preview.example.com");
    expect(m.text).toContain("Open in Dockify: https://dockify.example.com/projects/acme?tab=previews");
  });

  it("offers Open preview when ready", async () => {
    const w = world({ env: { status: "ready", error: null, apps: [{ hostname: "pr-42-web.preview.example.com", currentDeploymentId: "d1", app: { port: 3000 }, deployments: [{ status: "ready", error: null }] }] } });
    expect(await deliverPreviewNotice(w.deps, { previewId: ID, state: "ready", commit: SHA })).toBe("sent");
    const m = body(w.calls[0]!);
    expect(m.text).toContain("Open preview: https://pr-42-web.preview.example.com");
    expect(m.text).not.toContain("Last build lines");
  });
});

describe("a preview email is stale or repeated", () => {
  it("skips when a push or a close moved the preview on, and a lost first ready stays owed", async () => {
    const pushed = world({ env: { status: "building", notifiedKey: "ready" } });
    expect(await deliverPreviewNotice(pushed.deps, { previewId: ID, state: "ready", commit: SHA })).toBe("skipped");
    expect(pushed.calls).toHaveLength(0);
    expect(pushed.updates).toHaveLength(1);
    const closed = world({ env: { status: "closed" } });
    expect(await deliverPreviewNotice(closed.deps, FAILED)).toBe("skipped");
    const newer = world({ env: { commitSha: "f".repeat(40) } });
    expect(await deliverPreviewNotice(newer.deps, FAILED)).toBe("skipped");
  });

  it("keys each send, so a retried job is a no-op at the provider", async () => {
    const w = world();
    await deliverPreviewNotice(w.deps, FAILED);
    await deliverPreviewNotice(w.deps, FAILED);
    const keys = w.calls.map((c) => c.idempotencyKey);
    expect(keys[0]).toBe(`preview:${ID}:failed:${SHA}:u1`);
    expect(keys[1]).toBe(keys[0]);
  });

  it("retries a provider outage, stops on a refusal, and refuses a malformed payload", async () => {
    await expect(deliverPreviewNotice(world({ status: 503 }).deps, FAILED)).rejects.toThrow(/451/);
    await expect(deliverPreviewNotice(world({ status: 422 }).deps, FAILED)).rejects.toMatchObject({ name: "PermanentJobError" });
    for (const bad of [null, {}, { previewId: "x", state: "failed", commit: null }, { previewId: ID, state: "closed", commit: null }]) expect(() => parsePreviewNotify(bad)).toThrow(/malformed/);
  });
});

describe("when a preview email is owed", () => {
  const v = (o: Partial<Parameters<typeof previewNoticeFor>[1]>) => ({ buildFailed: true, fromFork: false, commit: "c1", notifiedKey: null, ...o });

  it("tells a first ready, then nothing for a push that merely updates it", () => {
    expect(previewNoticeFor("ready", v({ buildFailed: false }))).toEqual({ state: "ready", key: "ready" });
    expect(previewNoticeFor("ready", v({ buildFailed: false, notifiedKey: "ready" }))).toBeNull();
  });

  it("tells a recovery from failed", () => {
    expect(previewNoticeFor("ready", v({ buildFailed: false, notifiedKey: "failed:c1" }))).toEqual({ state: "ready", key: "ready" });
  });

  it("tells a failure once per commit, and a fork's once until it recovers", () => {
    expect(previewNoticeFor("failed", v({}))).toEqual({ state: "failed", key: "failed:c1" });
    expect(previewNoticeFor("failed", v({ notifiedKey: "failed:c1" }))).toBeNull();
    expect(previewNoticeFor("failed", v({ commit: "c2", notifiedKey: "failed:c1" }))).toEqual({ state: "failed", key: "failed:c2" });
    expect(previewNoticeFor("failed", v({ fromFork: true }))).toEqual({ state: "failed", key: "failed" });
    expect(previewNoticeFor("failed", v({ fromFork: true, commit: "c2", notifiedKey: "failed" }))).toBeNull();
  });

  it("says nothing for a cancelled build or one still running", () => {
    expect(previewNoticeFor("failed", v({ buildFailed: false }))).toBeNull();
    expect(previewNoticeFor("building", v({}))).toBeNull();
  });
});

describe("the lost build lines (seen live: 'Its last lines:' with nothing after it)", () => {
  it("keeps the reason clean and the lines separate", () => {
    expect(firstErrorLine(BUILD_ERROR)).toBe("The build failed (buildctl exit 1).");
    expect(failureLines(BUILD_ERROR)).toHaveLength(2);
    expect(failureLines("one line")).toEqual([]);
    expect(failureLines(null)).toEqual([]);
  });
});

describe("settlePreview queues the email in the transaction that writes the state", () => {
  function fake(status: string, deployment: { status: string; error: string | null }, notifiedKey: string | null = null) {
    const jobs: Array<{ kind: string; dedupeKey: string; payload: unknown }> = [];
    const updates: Array<Record<string, unknown>> = [];
    const tx = {
      $executeRaw: async () => 0,
      previewEnv: {
        findUnique: async () => ({ status, fromFork: false, commitSha: SHA, notifiedKey, apps: [{ deployments: [deployment] }] }),
        update: async ({ data }: { data: Record<string, unknown> }) => (updates.push(data), {}),
      },
      job: {
        findFirst: async () => null,
        create: async ({ data }: { data: { kind: string; dedupeKey: string; payload: unknown } }) => (jobs.push(data), { id: "j" }),
      },
    };
    const db = { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
    return { db: db as unknown as Db, jobs, updates, mail: () => jobs.filter((j) => j.kind === "preview_notify") };
  }

  it("a failed build: one job, the row remembers it, the reason keeps no dangling promise", async () => {
    const w = fake("building", { status: "failed", error: BUILD_ERROR });
    await settlePreview(w.db, ID);
    expect(w.mail()).toHaveLength(1);
    expect(w.mail()[0]).toMatchObject({ dedupeKey: `preview_notify:${ID}:failed:${SHA}`, payload: { previewId: ID, state: "failed", commit: SHA } });
    expect(w.updates[0]).toMatchObject({ status: "failed", error: "The build failed (buildctl exit 1).", notifiedKey: `failed:${SHA}` });
    expect(w.jobs.some((j) => j.kind === "preview_feedback")).toBe(true);
  });

  it("a push that merely updates a ready preview: the comment updates, no mail", async () => {
    const w = fake("building", { status: "ready", error: null }, "ready");
    await settlePreview(w.db, ID);
    expect(w.mail()).toHaveLength(0);
    expect(w.jobs.some((j) => j.kind === "preview_feedback")).toBe(true);
  });

  it("recovered from failed: mail; closed: nothing at all", async () => {
    const back = fake("building", { status: "ready", error: null }, `failed:${SHA}`);
    await settlePreview(back.db, ID);
    expect(back.mail()).toHaveLength(1);
    const closed = fake("closed", { status: "failed", error: BUILD_ERROR });
    await settlePreview(closed.db, ID);
    expect(closed.jobs).toHaveLength(0);
  });

  it("a cancelled build: no mail", async () => {
    const w = fake("building", { status: "cancelled", error: null });
    await settlePreview(w.db, ID);
    expect(w.mail()).toHaveLength(0);
  });
});
