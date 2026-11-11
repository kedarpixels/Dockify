/**
 * deploy_notify with fakes: the member who started a failed deploy (by click, or by a push whose
 * author login they linked) gets one email, unless they turned it off, left the team, or email is
 * not set up.
 */
import { describe, expect, it } from "vitest";
import { mailIconKey, verifyMailIcon } from "@dockify/crypto";
import type { Db, SecretVault } from "@dockify/db";
import type { OutgoingEmail } from "@dockify/email";
import { fakeMailer, SMTP_ROW } from "../test-mailer.ts";
import { discordBody, genericBody, googleChatBody, mattermostBody, ntfyRequest, parseNotifyMessage, rocketChatBody, slackBody, teamsBody, telegramBody, type NotifyMessage } from "@dockify/notify";
import { isPermanentError } from "../errors.ts";
import { deliverDeployFailed } from "./deploy-notify.ts";

const DEP = "0f0e0d0c-0000-4000-8000-0000000000d1";
const KEY = "0f0e0d0c-0000-4000-8000-0000000000bb";
const APP_ID = "0f0e0d0c-0000-4000-8000-0000000000a1";
const PROJECT_ID = "0f0e0d0c-0000-4000-8000-0000000000c1";
const TOKEN = "internal-token-of-this-instance";

type User = { id: string; email: string; githubLogin: string | null; githubVerifiedAt?: Date | null; emailDeployFailed: boolean; member: boolean; disabledAt: Date | null };
const VERIFIED = new Date("2026-10-01T00:00:00Z");
/** The project's uploaded icon; its sha256 prefix is the version a mail icon link names. */
const UPLOAD = { id: "img1", source: "upload", sha256: "ab".repeat(32), width: 64, height: 64, origin: null, updatedAt: VERIFIED };

function world(opts: { email?: boolean; deployment?: Record<string, unknown>; users?: User[]; events?: Record<string, boolean>; hooks?: Array<{ id: string }>; token?: boolean; displayName?: string } = {}) {
  const users: User[] = opts.users ?? [
    { id: "u1", email: "sam@example.com", githubLogin: "sam", githubVerifiedAt: VERIFIED, emailDeployFailed: true, member: true, disabledAt: null },
    { id: "u2", email: "lena@example.com", githubLogin: "lena", githubVerifiedAt: VERIFIED, emailDeployFailed: false, member: true, disabledAt: null },
    { id: "u3", email: "gone@example.com", githubLogin: "gone", githubVerifiedAt: VERIFIED, emailDeployFailed: true, member: false, disabledAt: null },
    { id: "u4", email: "squat@example.com", githubLogin: "boss", githubVerifiedAt: null, emailDeployFailed: true, member: true, disabledAt: null },
  ];
  const deployment = {
    status: "failed", error: "build failed: exit 1", branch: "main", commitSha: "4f2a9c1e".padEnd(40, "0"), finishedAt: new Date("2026-10-30T14:05:00Z"),
    actorType: "user", actorId: "u1", gitAuthor: null,
    app: {
      id: APP_ID, name: "web", displayName: opts.displayName ?? null, kind: "frontend", iconChoice: "auto", icons: [], gitRepository: "https://github.com/sam/horseai", gitInstallationId: null,
      environment: { name: "production", project: { id: PROJECT_ID, slug: "horseai", name: "horseai", iconChoice: "upload", icons: [UPLOAD], environments: [] } },
    },
    ...opts.deployment,
  };
  const row = { id: "int1", kind: "email", name: "default", status: "connected", secretId: KEY, config: { ...SMTP_ROW, fromName: "Acme", fromAddress: "ops@acme.dev", replyTo: null } };
  const jobs: Array<{ kind: string; dedupeKey: string; payload: { message: { event: string; title: string } } }> = [];
  const tx = {
    $executeRaw: async () => 1,
    job: {
      findFirst: async () => null,
      create: async ({ data }: { data: (typeof jobs)[number] }) => (jobs.push(data), { id: `j${jobs.length}` }),
    },
  };
  const db = {
    deployment: { findUnique: async () => deployment },
    user: {
      findFirst: async ({ where }: { where: { id?: string; githubLogin?: string; githubVerifiedAt?: { not: null } } }) => {
        const u = users.find((x) => x.member && !x.disabledAt && (where.id ? x.id === where.id : x.githubLogin === where.githubLogin && (!where.githubVerifiedAt || !!x.githubVerifiedAt)));
        return u ? { id: u.id, email: u.email, emailDeployFailed: u.emailDeployFailed } : null;
      },
    },
    integration: { findUnique: async () => (opts.email === false ? null : row), update: async () => row },
    instance: { findUnique: async () => ({ name: "Acme Cloud", notifyEvents: opts.events ?? {} }) },
    notificationWebhook: { findMany: async () => opts.hooks ?? [] },
    job: { findFirst: async ({ where }: { where: { dedupeKey: string } }) => (jobs.some((j) => j.dedupeKey === where.dedupeKey) ? { id: "seen" } : null) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  };
  const vault: SecretVault = {
    open: async (_tx, ids) => new Map(ids.map((id) => [id, id === KEY ? "re_live_abcdefghijklmnop" : null])),
    seal: async () => {
      throw new Error("not used");
    },
    escrow: async () => "",
  };
  const r = fakeMailer();
  const calls = r.calls;
  return { deps: { db: db as unknown as Db, vault, mail: r.mail, publicUrl: "https://dash.example.com", internalToken: opts.token === false ? undefined : TOKEN }, calls, jobs };
}

const sentTo = (calls: OutgoingEmail[]) => calls.map((c) => c.to);
const htmlOf = (calls: OutgoingEmail[]) => calls[0]!.html;

describe("deploy_notify and the Deploy failed switch", () => {
  it("off, nothing goes out, by email or webhook", async () => {
    const w = world({ events: { deployFailed: false }, hooks: [{ id: "h1" }] });
    expect(await deliverDeployFailed(w.deps, { deploymentId: DEP })).toBe("skipped");
    expect(w.calls).toHaveLength(0);
    expect(w.jobs).toHaveLength(0);
  });
  it("on, every enabled webhook hears it even when no member started the deploy, and a retry does not repeat it", async () => {
    const w = world({ hooks: [{ id: "h1" }, { id: "h2" }], deployment: { actorType: "webhook", actorId: null, gitAuthor: "nobody" } });
    expect(await deliverDeployFailed(w.deps, { deploymentId: DEP })).toBe("skipped");
    expect(w.calls).toHaveLength(0);
    expect(w.jobs.map((j) => j.kind)).toEqual(["webhook_send", "webhook_send"]);
    expect(w.jobs[0]!.payload.message).toMatchObject({ event: "deploy.failed", title: "Deploy failed: web" });
    await deliverDeployFailed(w.deps, { deploymentId: DEP });
    expect(w.jobs).toHaveLength(2);
  });
});

describe("a failed deployment on Vercel", () => {
  const vercel = { provider: "vercel", externalTarget: "production", actorType: "webhook", actorId: null, gitAuthor: "sam" };
  // What a stranger can name a branch or put in a build error, after the mirror's control character pass.
  const HOSTILE_BRANCH = "@everyone <!channel> [click](https://evil.example/x) <img src=x onerror=alert(1)> `pwn`";
  const HOSTILE_ERROR = "Build failed @here see https://evil.example/login <script>alert(1)</script> token=abcdef123456";
  const hostile = { ...vercel, branch: HOSTILE_BRANCH, commitSha: "<b>evil</b>", error: HOSTILE_ERROR };
  const sent = (w: ReturnType<typeof world>) => w.jobs[0]!.payload.message as unknown as NotifyMessage;

  it("uses the same switch: off, nothing goes out", async () => {
    const w = world({ events: { deployFailed: false }, hooks: [{ id: "h1" }], deployment: vercel });
    expect(await deliverDeployFailed(w.deps, { deploymentId: DEP })).toBe("skipped");
    expect(w.jobs).toHaveLength(0);
    expect(w.calls).toHaveLength(0);
  });

  it("tells every webhook and the member behind it, under the same event, and names Vercel", async () => {
    const w = world({ hooks: [{ id: "h1" }], deployment: vercel });
    expect(await deliverDeployFailed(w.deps, { deploymentId: DEP })).toBe("sent");
    expect(sent(w)).toMatchObject({ event: "deploy.failed", title: "Deploy failed on Vercel: web" });
    expect(sent(w).fields.find((f) => f.name === "Source")?.value).toBe("Vercel, main, 4f2a9c1");
    expect(sentTo(w.calls)).toEqual(["sam@example.com"]);
    expect(htmlOf(w.calls)).toContain("Vercel, main, 4f2a9c1");
    // Vercel built it, whatever the repository is: no GitHub mark on its Source row.
    expect(htmlOf(w.calls)).not.toContain("/dk-f-github.png");
  });

  it("says a preview is a preview: the site is not down", async () => {
    const w = world({ hooks: [{ id: "h1" }], deployment: { ...vercel, externalTarget: "preview" } });
    await deliverDeployFailed(w.deps, { deploymentId: DEP });
    expect(sent(w).title).toBe("Preview failed on Vercel: web");
    expect(sent(w).fields.find((f) => f.name === "Source")?.value).toContain("Vercel preview");
  });

  it("a retry of the job sends neither webhook nor a second mail key", async () => {
    const w = world({ hooks: [{ id: "h1" }], deployment: vercel });
    await deliverDeployFailed(w.deps, { deploymentId: DEP });
    await deliverDeployFailed(w.deps, { deploymentId: DEP });
    expect(w.jobs).toHaveLength(1);
    const keys = w.calls.map((c) => c.idempotencyKey);
    expect(new Set(keys)).toEqual(new Set([`deploy-failed:${DEP}:u1`]));
  });

  it("hostile text cannot mention, link or inject, in the message or any provider's markup", async () => {
    const w = world({ hooks: [{ id: "h1" }], deployment: hostile });
    await deliverDeployFailed(w.deps, { deploymentId: DEP });
    const m = sent(w);
    // The message parses back, as the webhook_send job will read it.
    expect(parseNotifyMessage(m)).not.toBeNull();
    const all = JSON.stringify(m);
    for (const bad of ["@everyone", "@here", "<!channel>", "https://evil", "<img", "<script", "<b>", "`pwn`", "abcdef123456"]) expect(all, bad).not.toContain(bad);
    const bodies = [discordBody(m), slackBody(m), teamsBody(m), googleChatBody(m), telegramBody(m, "1"), mattermostBody(m), rocketChatBody(m), genericBody(m), ntfyRequest(m)];
    for (const body of bodies) {
      const text = JSON.stringify(body);
      for (const bad of ["@everyone", "<!channel>", "](https://evil", "<img", "<script"]) expect(text, bad).not.toContain(bad);
    }
    expect(discordBody(m)).toMatchObject({ allowed_mentions: { parse: [] } });
  });

  it("hostile text stays inert in the mail, its subject and its plain part", async () => {
    const w = world({ deployment: hostile });
    expect(await deliverDeployFailed(w.deps, { deploymentId: DEP })).toBe("sent");
    const mail = w.calls[0]!;
    for (const part of [mail.html, mail.text, mail.subject]) {
      // The template has images of its own, so this names the hostile one.
      for (const bad of ["evil.example", "<img src=x", "<script", "onerror=alert(1)>", "abcdef123456"]) expect(part, bad).not.toContain(bad);
    }
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });

  it("a server build's output is as inert as Vercel's: its last line cannot post a masked link under Dockify's name", async () => {
    const error = "The build failed. Its last lines:\nstep 4/9 RUN npm run build\n[Session expired, sign in](https://evil.example/login) @channel <https://evil.example|here> `x`";
    const w = world({ hooks: [{ id: "h1" }], deployment: { provider: "dockify", externalTarget: null, branch: "[main](https://evil.example/b)", error } });
    expect(await deliverDeployFailed(w.deps, { deploymentId: DEP })).toBe("sent");
    const m = sent(w);
    // Still one line per line of output, and nothing a chat or a mail client turns into a link.
    expect(m.text).toBe("The build failed. Its last lines:\nstep 4/9 RUN npm run build\n[Session expired, sign in] ([link] channel [link] x");
    expect(m.fields.find((f) => f.name === "Source")?.value).toBe("[main] ([link], 4f2a9c1");
    for (const body of [mattermostBody(m), rocketChatBody(m), discordBody(m), slackBody(m), teamsBody(m)]) {
      const text = JSON.stringify(body);
      for (const bad of ["evil.example", "](", "@channel", "<http"]) expect(text, bad).not.toContain(bad);
    }
    const mail = w.calls[0]!;
    for (const part of [mail.html, mail.text, mail.subject]) expect(part).not.toContain("evil.example");
    expect(mail.text).toContain("[Session expired, sign in] ([link]");
  });

  it("a server deploy's message is unchanged", async () => {
    const w = world({ hooks: [{ id: "h1" }], deployment: { actorType: "webhook", actorId: null, gitAuthor: "nobody", provider: "dockify", externalTarget: null } });
    await deliverDeployFailed(w.deps, { deploymentId: DEP });
    expect(sent(w).title).toBe("Deploy failed: web");
    expect(sent(w).fields.find((f) => f.name === "Source")?.value).toBe("main, 4f2a9c1");
  });
});

describe("deploy_notify", () => {
  it("mails the member who clicked deploy, once per deployment and member", async () => {
    const w = world();
    expect(await deliverDeployFailed(w.deps, { deploymentId: DEP })).toBe("sent");
    expect(sentTo(w.calls)).toEqual(["sam@example.com"]);
    expect(w.calls[0]!.idempotencyKey).toBe(`deploy-failed:${DEP}:u1`);
    expect(w.calls[0]!.text).toContain("horseai / production / web");
  });
  it("draws the place as the dashboard's chip: a signed link to the project's own icon, the app on its kind tile", async () => {
    const w = world();
    await deliverDeployFailed(w.deps, { deploymentId: DEP });
    const html = htmlOf(w.calls);
    const link = /https:\/\/dash\.example\.com\/api\/icons\/mail\/([A-Za-z0-9_-]+)"/.exec(html);
    // The link names the project and the version of the icon it shows now, under this instance's key.
    expect(verifyMailIcon(mailIconKey(TOKEN), link?.[1] ?? "")).toEqual({ target: "project", id: PROJECT_ID, version: "ab".repeat(6) });
    expect(html).toContain("/dk-kind-web.png");
    expect(html).not.toContain("/dk-folder.png");
    expect(html).toContain("/dk-f-github.png");
    // Nothing to sign with: the tiles stand in, and nothing points at the icon route.
    const bare = world({ token: false });
    await deliverDeployFailed(bare.deps, { deploymentId: DEP });
    expect(htmlOf(bare.calls)).not.toContain("/api/icons/mail/");
    expect(htmlOf(bare.calls)).toContain("/dk-folder.png");
  });
  it("mails the member behind a push by the GitHub login they linked", async () => {
    const w = world({ deployment: { actorType: "webhook", actorId: null, gitAuthor: "sam" } });
    expect(await deliverDeployFailed(w.deps, { deploymentId: DEP })).toBe("sent");
    expect(sentTo(w.calls)).toEqual(["sam@example.com"]);
  });
  it("skips a member who turned it off, a former member, an unlinked push, a deploy that did not fail and an instance without email", async () => {
    const cases = [
      world({ deployment: { actorId: "u2" } }),
      world({ deployment: { actorType: "webhook", actorId: null, gitAuthor: "gone" } }),
      world({ deployment: { actorType: "webhook", actorId: null, gitAuthor: "octocat" } }),
      // An unverified claim on a login never receives that login's deploy mail.
      world({ deployment: { actorType: "webhook", actorId: null, gitAuthor: "boss" } }),
      world({ deployment: { actorType: "system", actorId: null } }),
      world({ deployment: { status: "ready" } }),
      world({ email: false }),
    ];
    for (const w of cases) expect(await deliverDeployFailed(w.deps, { deploymentId: DEP })).toBe("skipped");
    expect(cases.flatMap((w) => w.calls)).toHaveLength(0);
  });
  it("refuses a malformed payload for good", async () => {
    const e = await deliverDeployFailed(world().deps, { deploymentId: "nope" }).catch((x: unknown) => x);
    expect(isPermanentError(e)).toBe(true);
  });
});

describe("a renamed app", () => {
  it("is named by its display name in the webhook and the email, and by its name in the webhook's data", async () => {
    const w = world({ hooks: [{ id: "h1" }], displayName: "Storefront" });
    expect(await deliverDeployFailed(w.deps, { deploymentId: DEP })).toBe("sent");
    const message = w.jobs[0]!.payload.message as unknown as NotifyMessage;
    expect(message.title).toBe("Deploy failed: Storefront");
    expect(message.fields.find((f) => f.name === "Where")?.value).toBe("horseai / production / Storefront");
    // A receiver that keys on the app keeps working: the data names it by its identity.
    expect((message.data as { deployment: { app: string } }).deployment.app).toBe("web");
    const mail = w.calls[0]!;
    expect(mail.html).toContain("Storefront");
    expect(mail.text).toContain("horseai / production / Storefront");
    expect(mail.text).not.toContain("production / web");
  });
});
