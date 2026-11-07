/**
 * Behaviours that once failed on a running server; the
 * fakes stand for the mail server, GitHub and Docker, which this machine does not reach.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db, SecretVault } from "@dockify/db";
import { LOGIN_REFUSED, MailError, type Mailer } from "@dockify/email";
import { fakeMailer, SMTP_ROW } from "./test-mailer.ts";
import { isPermanentError } from "./errors.ts";
import { loadDeployConfig } from "./deploy/config.ts";
import { sweepCheckouts, translateGitError } from "./deploy/git.ts";
import { DeployLog } from "./deploy/log.ts";
import { waitForCertificate } from "./deploy/preview.ts";
import { deployStatusFor, runDeployStatus } from "./integrations/deploy-status.ts";
import { mailEach, runEmailSend, sendAlertEmails } from "./integrations/email.ts";
import { announceExpiringCertificates, announceFailedBackups, deliverEventNotice, eventOn, metricEvent, parseEventNotice, queueEventNotice } from "./integrations/events.ts";
import { parseRequestCounters, prunePreviewImages, sweepPreviewDbVolumes } from "./integrations/previews.ts";
import { planLogLines } from "@dockify/engine";
import { isConnectionError } from "./data/channel.ts";
import { pgResult } from "./data/pg-session.ts";
import { API_UPSTREAM } from "./edge/ingress.ts";
import { renderAsleepRouteFile } from "./edge/routes.ts";
import { checkTls, type TlsProbe } from "./edge/tls.ts";
import { deliverAlert } from "./observe/channels.ts";

vi.mock("./deploy/github.ts", async (real) => ({ ...(await real<object>()), installationCredential: async () => ({ username: "x-access-token", secret: "ghs_token" }) }));

const MSG = "0f0e0d0c-0000-4000-8000-0000000000aa";
const KEY = "0f0e0d0c-0000-4000-8000-0000000000bb";
const INVITE = "0f0e0d0c-0000-4000-8000-0000000000cc";

function world(o: { integration?: Record<string, unknown>; events?: Record<string, boolean>; admins?: Array<{ id: string; email: string }>; hooks?: Array<{ id: string }> } = {}) {
  const row = { id: "int1", kind: "email", name: "default", status: "connected", error: null, secretId: KEY, config: { ...SMTP_ROW, fromName: "Acme", fromAddress: "ops@acme.dev", replyTo: null }, ...o.integration };
  const integrationUpdates: Array<{ data: { status: string; error: string | null } }> = [];
  const inviteUpdates: Array<{ where: { id: string }; data: { emailStatus: string; emailError: string | null } }> = [];
  const activity: Array<{ data: { action: string; targetLabel: string; suffix: string; failed: boolean } }> = [];
  const jobs: Array<{ kind: string; dedupeKey: string | null; payload: Record<string, unknown> }> = [];
  const secrets = new Map<string, string>([
    [MSG, JSON.stringify({ to: "new@acme.dev", subject: "Join Acme", html: "<p>x</p>", text: "x" })],
    [KEY, "stored-mail-password"],
  ]);
  const tx = {
    $executeRaw: async () => 1,
    job: {
      findFirst: async () => null,
      create: async ({ data }: { data: (typeof jobs)[number] }) => (jobs.push(data), { id: `j${jobs.length}` }),
    },
  };
  const db = {
    integration: { findUnique: async () => row, update: async (q: (typeof integrationUpdates)[number]) => (integrationUpdates.push(q), row) },
    invite: { updateMany: async (q: (typeof inviteUpdates)[number]) => (inviteUpdates.push(q), { count: 1 }) },
    secret: { delete: async ({ where }: { where: { id: string } }) => secrets.delete(where.id) },
    activityLog: { create: async (q: (typeof activity)[number]) => (activity.push(q), {}) },
    instance: { findUnique: async () => ({ name: "Acme", notifyEvents: o.events ?? {} }) },
    member: { findMany: async () => (o.admins ?? [{ id: "u1", email: "gone@acme.dev" }, { id: "u2", email: "here@acme.dev" }]).map((user) => ({ user })) },
    notificationWebhook: { findMany: async () => o.hooks ?? [] },
    job: { findFirst: async ({ where }: { where: { dedupeKey: string } }) => (jobs.some((j) => j.dedupeKey === where.dedupeKey) ? { id: "seen" } : null) },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const vault: SecretVault = {
    open: async (_tx, ids) => new Map(ids.map((id) => [id, secrets.get(id) ?? null])),
    seal: async () => {
      throw new Error("not used");
    },
    escrow: async () => "",
  };
  return { db: db as unknown as Db, vault, row, integrationUpdates, inviteUpdates, activity, jobs, secrets };
}

const REFUSED = () => new MailError("recipient", "The mail server refused this recipient.", { smtpCode: 550, detail: "550 5.1.1 no such user owner@acme.dev here" });
const LOGIN = () => new MailError("auth", "refused", { smtpCode: 535 });
const BUSY = () => new MailError("busy", "busy", { smtpCode: 451 });
/** Answers per recipient; success for anyone not named. */
const answering = (answers: Record<string, () => MailError> = {}) => fakeMailer((m) => answers[m.to]?.() ?? null);
const job = (over: Record<string, unknown> = {}, attempts = 1) => ({ payload: { messageId: MSG, ...over }, attempts, maxAttempts: 5 });
const failure = async (p: Promise<unknown>): Promise<Error> => p.then(() => { throw new Error("expected a failure"); }, (e: Error) => e);
const alertInput = { eventId: "ev1", transition: "firing" as const, kind: "appDown" as const, title: "App down", detail: "web failed", where: "shop / web", at: new Date(0), url: "https://dash.example.com/alerts", origin: "https://dash.example.com" };

describe("one refused recipient does not mark the email integration broken", () => {
  it("a refused recipient leaves the row alone", async () => {
    const w = world();
    await failure(runEmailSend({ ...w, mail: answering({ "new@acme.dev": REFUSED }).mail }, job()));
    expect(w.integrationUpdates).toEqual([]);
  });
  it("a refused from address leaves the row alone too", async () => {
    const w = world();
    await failure(runEmailSend({ ...w, mail: answering({ "new@acme.dev": () => new MailError("sender", "no", { smtpCode: 553 }) }).mail }, job()));
    expect(w.integrationUpdates).toEqual([]);
  });
  it("a refused login marks it", async () => {
    const w = world();
    await failure(runEmailSend({ ...w, mail: answering({ "new@acme.dev": LOGIN }).mail }, job()));
    expect(w.integrationUpdates[0]!.data).toMatchObject({ status: "error", error: LOGIN_REFUSED });
  });
  it("a host the address rule refuses marks it", async () => {
    const w = world();
    await failure(runEmailSend({ ...w, mail: answering({ "new@acme.dev": () => new MailError("blocked", "no", { field: "host" }) }).mail }, job()));
    expect(w.integrationUpdates[0]!.data.status).toBe("error");
    expect(w.integrationUpdates[0]!.data.error).toContain("not allowed");
  });
  it("an unreachable server says nothing about the settings", async () => {
    const w = world();
    await failure(runEmailSend({ ...w, mail: answering({ "new@acme.dev": () => new MailError("unreachable", "no route") }).mail }, job()));
    expect(w.integrationUpdates).toEqual([]);
  });
  it("a send that works clears a red card", async () => {
    const w = world({ integration: { status: "error", error: LOGIN_REFUSED } });
    await runEmailSend({ ...w, mail: answering().mail }, job());
    expect(w.integrationUpdates[0]!.data).toEqual({ status: "connected", error: null });
  });
  it("a send that works on a healthy row writes nothing", async () => {
    const w = world();
    await runEmailSend({ ...w, mail: answering().mail }, job());
    expect(w.integrationUpdates).toEqual([]);
  });
});

describe("an invite's email reports what became of it", () => {
  it("a refused address is written on the invite, with every address taken out, and is final", async () => {
    const w = world();
    const e = await failure(runEmailSend({ ...w, mail: answering({ "new@acme.dev": REFUSED }).mail }, job({ inviteId: INVITE })));
    expect(isPermanentError(e)).toBe(true);
    expect(w.inviteUpdates).toHaveLength(1);
    expect(w.inviteUpdates[0]!.where.id).toBe(INVITE);
    expect(w.inviteUpdates[0]!.data.emailStatus).toBe("failed");
    expect(w.inviteUpdates[0]!.data.emailError).toContain("550 5.1.1 no such user");
    expect(w.inviteUpdates[0]!.data.emailError).not.toContain("@");
    // lastError takes this message too, and its header comment promises no address.
    expect(e.message).not.toContain("@");
  });
  it("a delivered one says sent", async () => {
    const w = world();
    await runEmailSend({ ...w, mail: answering().mail }, job({ inviteId: INVITE }));
    expect(w.inviteUpdates[0]!.data).toEqual({ emailStatus: "sent", emailError: null });
  });
  it("a retry that may still work leaves it queued; the last attempt says failed", async () => {
    const w = world();
    const busy = answering({ "new@acme.dev": BUSY }).mail;
    await failure(runEmailSend({ ...w, mail: busy }, job({ inviteId: INVITE }, 1)));
    expect(w.inviteUpdates).toEqual([]);
    await failure(runEmailSend({ ...w, mail: busy }, job({ inviteId: INVITE }, 5)));
    expect(w.inviteUpdates[0]!.data.emailStatus).toBe("failed");
  });
  it("a message with no invite writes nothing, and a bad id is ignored", async () => {
    const w = world();
    await runEmailSend({ ...w, mail: answering().mail }, job());
    await runEmailSend({ ...world(), mail: answering().mail }, job({ inviteId: "x" }));
    expect(w.inviteUpdates).toEqual([]);
  });
});

describe("one refused admin address does not stop the others", () => {
  it("every other admin still gets the alert, and the refusal goes on the activity log, not the integration", async () => {
    const w = world();
    const r = answering({ "gone@acme.dev": REFUSED });
    expect(await sendAlertEmails({ ...w, mail: r.mail }, alertInput)).toBe(1);
    expect(r.to()).toEqual(["gone@acme.dev", "here@acme.dev"]);
    expect(w.integrationUpdates).toEqual([]);
    expect(w.activity[0]!.data).toMatchObject({ action: "email.refused", targetLabel: "gone@acme.dev", failed: true });
    expect(w.activity[0]!.data.suffix).not.toContain("@");
  });
  it("a busy answer for one retries the job, after trying the rest, with the same keys", async () => {
    const w = world();
    const r = answering({ "gone@acme.dev": BUSY });
    const e = await failure(sendAlertEmails({ ...w, mail: r.mail }, alertInput));
    expect(isPermanentError(e)).toBe(false);
    expect(r.to()).toEqual(["gone@acme.dev", "here@acme.dev"]);
    expect(r.keys()).toEqual(["alert:ev1:firing:u1", "alert:ev1:firing:u2"]);
    expect(w.activity).toEqual([]);
  });
  it("every recipient refused is final, and says only a status", async () => {
    const w = world();
    const e = await failure(sendAlertEmails({ ...w, mail: answering({ "gone@acme.dev": REFUSED, "here@acme.dev": REFUSED }).mail }, alertInput));
    expect(isPermanentError(e)).toBe(true);
    expect(e.message).toBe("email failed: 550");
  });
  it("a refused login stops at once: no send can work", async () => {
    const w = world();
    const r = answering({ "gone@acme.dev": LOGIN });
    const e = await failure(sendAlertEmails({ ...w, mail: r.mail }, alertInput));
    expect(isPermanentError(e)).toBe(true);
    expect(r.calls).toHaveLength(1);
    expect(w.integrationUpdates[0]!.data.status).toBe("error");
  });
  it("no connection stops the loop and retries, so a blocked port does not wait once per admin", async () => {
    const w = world();
    const r = answering({ "gone@acme.dev": () => new MailError("unreachable", "no route") });
    const e = await failure(sendAlertEmails({ ...w, mail: r.mail }, alertInput));
    expect(isPermanentError(e)).toBe(false);
    expect(e.message).toBe("email failed: unreachable");
    expect(r.calls).toHaveLength(1);
    expect(w.integrationUpdates).toEqual([]);
  });
  it("is the one loop behind mail to several people", async () => {
    const dir = fileURLToPath(new URL("./integrations/", import.meta.url));
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f === "email.ts") continue;
      expect(await readFile(join(dir, f), "utf8"), f).not.toMatch(/\.mail\.send\(/);
    }
    expect(typeof mailEach).toBe("function");
  });
});

describe("the build root is on the work volume", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });
  it("compose points it there, not at the 256 MB tmpfs", async () => {
    const compose = await readFile(fileURLToPath(new URL("../../../deploy/docker-compose.yml", import.meta.url)), "utf8");
    const line = /DOCKIFY_BUILD_ROOT: (\S+)/.exec(compose)?.[1];
    expect(line).toBe("/var/lib/dockify/work/builds");
    expect(compose).toContain("dockify-work:/var/lib/dockify/work");
    expect(loadDeployConfig({ DOCKIFY_BUILD_ROOT: line } as NodeJS.ProcessEnv).buildRoot).toBe(line);
  });
  it("a full disk is permanent and says what to do, not 'fatal: unable to write loose object file' three times", () => {
    const e = translateGitError({ stderr: "fatal: unable to write loose object file: No space left on device" }, "fetch", true);
    expect(isPermanentError(e)).toBe(true);
    expect(e.message).toContain("ran out of disk space");
    expect(e.message).toContain("Server, Prune");
  });
  it("boot sweeps what a crash left, and only checkouts", async () => {
    dir = await mkdtemp(join(tmpdir(), "dk-builds-"));
    await mkdir(join(dir, "build-abc", "repo"), { recursive: true });
    await writeFile(join(dir, "build-abc", "repo", "x"), "x");
    await writeFile(join(dir, "other"), "keep");
    expect(await sweepCheckouts(dir)).toBe(1);
    expect(await readdir(dir)).toEqual(["other"]);
    expect(await sweepCheckouts(join(dir, "missing"))).toBe(0);
  });
});

describe("a preview's database volume goes with it", () => {
  const live = "11111111-1111-4111-8111-111111111111";
  const gone = "22222222-2222-4222-8222-222222222222";
  it("sweeps a volume no live preview holds, and leaves one in use or live", async () => {
    const removed: string[] = [];
    const db = { previewEnv: { findMany: async () => [{ id: live }] } } as unknown as Db;
    const n = await sweepPreviewDbVolumes({
      db,
      serverId: "s1",
      docker: { removeVolume: async (v) => void removed.push(v) },
      volumes: async () => [
        { Name: `dk-pvdb-data-${live}`, UsageData: { RefCount: 0 } },
        { Name: `dk-pvdb-data-${gone}`, UsageData: { RefCount: 0 } },
        { Name: `dk-pvdb-data-${"3".repeat(36)}`, UsageData: { RefCount: 1 } },
        { Name: "dockify-data-keep", UsageData: { RefCount: 0 } },
      ],
    });
    expect(n).toBe(1);
    expect(removed).toEqual([`dk-pvdb-data-${gone}`]);
  });
});

describe("a preview waits for its certificate", () => {
  const log = () => {
    const lines: string[] = [];
    const l = new DeployLog({ write: async () => {} });
    const system = l.system.bind(l);
    l.system = (m: string) => (lines.push(m), system(m));
    return { l, lines };
  };
  it("asks until the good one is served", async () => {
    const { l } = log();
    let asked = 0;
    expect(await waitForCertificate("pr-1.example.com", async () => ++asked === 3, l, new AbortController().signal, { everyMs: 1 })).toBe(true);
    expect(asked).toBe(3);
  });
  it("gives up after the limit, says so, and a probe that throws counts as not yet", async () => {
    const { l, lines } = log();
    expect(await waitForCertificate("pr-1.example.com", async () => { throw new Error("refused"); }, l, new AbortController().signal, { timeoutMs: 5, everyMs: 1 })).toBe(false);
    expect(lines.join()).toContain("not issued yet");
  });
  it("stops at a cancel", async () => {
    const { l } = log();
    const c = new AbortController();
    c.abort();
    expect(await waitForCertificate("pr-1.example.com", async () => false, l, c.signal, { timeoutMs: 60_000 })).toBe(false);
  });
});

describe("a deploy sets a status on its commit", () => {
  const SHA = "a".repeat(40);
  const deployment = (over: Record<string, unknown> = {}) => ({
    status: "ready", error: null, commitSha: SHA,
    app: { gitRepository: "https://github.com/acme/web.git", gitInstallation: { installationId: 7n }, environment: { project: { gitInstallation: null } } },
    ...over,
  });
  const deps = (d: unknown, status = 201) => {
    const calls: Array<{ url: string; body?: string }> = [];
    return {
      calls,
      deps: {
        db: {
          deployment: { findUnique: async () => d },
          integration: { findUnique: async () => null },
          gitHubInstallation: { findUnique: async () => null },
        } as unknown as Db,
        vault: {} as SecretVault,
        http: (async (r: { url: string; body?: string }) => (calls.push(r), { status, headers: {}, body: Buffer.from("{}") })) as never,
        apiBase: "https://api.github.com",
        publicUrl: "https://dash.example.com",
      },
    };
  };
  it("words success and failure, and says nothing for anything else", () => {
    expect(deployStatusFor({ status: "ready", error: null })).toEqual({ state: "success", description: "Deployed" });
    expect(deployStatusFor({ status: "failed", error: "The build failed (exit 1). Its last lines:\n#9 boom @you https://evil.example" })).toEqual({ state: "failure", description: "Failed: The build failed (exit 1). Its last lines:" });
    // The description once stopped at "Its last lines:". It now says where.
    expect(deployStatusFor({ status: "failed", error: "The build failed (buildctl exit 1). Its last lines:\n#9 ERROR: process did not complete\nDockerfile:10\n--------------------" })!.description).toMatch(/^Failed: Build failed/);
    expect(deployStatusFor({ status: "failed", error: "The build failed (buildctl exit 1). Its last lines:\nboom" })!.description).not.toMatch(/buildctl|last lines/);
    expect(deployStatusFor({ status: "cancelled", error: null })).toBeNull();
    expect(deployStatusFor({ status: "failed", error: "x".repeat(300) })!.description).toHaveLength(140);
  });
  it("posts to the deployment's commit, with a link back, and retries only what can recover", async () => {
    const ID = "0f0e0d0c-0000-4000-8000-0000000000dd";
    const w = deps(deployment());
    expect(await runDeployStatus(w.deps, { deploymentId: ID })).toBe("sent");
    expect(w.calls[0]!.url).toBe(`https://api.github.com/repos/acme/web/statuses/${SHA}`);
    expect(JSON.parse(w.calls[0]!.body!)).toEqual({ state: "success", description: "Deployed", context: "Dockify", target_url: `https://dash.example.com/deployments/${ID}` });
    await expect(runDeployStatus(deps(deployment(), 502).deps, { deploymentId: ID })).rejects.toThrow("502");
    expect(await runDeployStatus(deps(deployment(), 404).deps, { deploymentId: ID })).toBe("skipped");
  });
  it("skips what has no commit, no GitHub repository or no installation", async () => {
    const ID = "0f0e0d0c-0000-4000-8000-0000000000dd";
    for (const d of [
      null,
      deployment({ commitSha: null }),
      deployment({ app: { gitRepository: "https://gitlab.com/a/b", gitInstallation: { installationId: 7n }, environment: { project: { gitInstallation: null } } } }),
      deployment({ app: { gitRepository: "https://github.com/a/b", gitInstallation: null, environment: { project: { gitInstallation: null } } } }),
    ]) {
      const w = deps(d);
      expect(await runDeployStatus(w.deps, { deploymentId: ID })).toBe("skipped");
      expect(w.calls).toEqual([]);
    }
    await expect(runDeployStatus(deps(null).deps, {})).rejects.toThrow("malformed");
  });
});

describe("the event switches control what is sent", () => {
  const notice = { event: "backupFailed" as const, id: "0f0e0d0c-0000-4000-8000-0000000000ee", title: "Backup failed: db", detail: "pg_dump exited 1", where: "shop / production / db", href: "/backups", at: "2026-11-06T10:00:00.000Z" };
  const deps = (w: ReturnType<typeof world>, mail: Mailer) => ({ db: w.db, vault: w.vault, mail, publicUrl: "https://dash.example.com" });

  it("every switch defaults on, and only an explicit false turns it off", async () => {
    expect(await eventOn(world().db, "tlsExpiring")).toBe(true);
    expect(await eventOn(world({ events: { tlsExpiring: false } }).db, "tlsExpiring")).toBe(false);
    expect(await eventOn(world({ events: { tlsExpiring: false } }).db, "appDown")).toBe(true);
  });
  it("is read at one place in the worker", async () => {
    const root = fileURLToPath(new URL(".", import.meta.url));
    const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const readers: string[] = [];
    for (const f of files) if (/notifyEvents/.test(await readFile(join(root, f), "utf8"))) readers.push(f.replace(/\\/g, "/"));
    expect(readers).toEqual(["integrations/events.ts"]);
  });
  it("Backup failed on: admins and every enabled webhook hear it, once", async () => {
    const w = world({ hooks: [{ id: "h1" }] });
    const r = answering();
    expect(await deliverEventNotice(deps(w, r.mail), notice)).toBe("sent");
    expect(r.to()).toEqual(["gone@acme.dev", "here@acme.dev"]);
    expect(w.jobs.filter((j) => j.kind === "webhook_send")).toHaveLength(1);
    expect(w.jobs[0]!.payload.message).toMatchObject({ event: "backup.failed", severity: "critical", title: "Backup failed: db" });
    const sent = r.calls[0]!;
    expect(sent.subject).toBe("Backup failed: db, shop / production / db");
    expect(sent.html).toContain("Settings, Notifications");
    expect(sent.html).toContain("https://dash.example.com/backups");
    await deliverEventNotice(deps(w, r.mail), notice);
    expect(w.jobs.filter((j) => j.kind === "webhook_send")).toHaveLength(1);
  });
  it("Backup failed off: nothing goes out, even a notice already queued", async () => {
    const w = world({ events: { backupFailed: false }, hooks: [{ id: "h1" }] });
    const r = answering();
    expect(await deliverEventNotice(deps(w, r.mail), notice)).toBe("skipped");
    expect(r.calls).toEqual([]);
    expect(w.jobs).toEqual([]);
  });
  it("App down off: a down or crash loop rule stays in the bell, and nothing leaves; other rules are not its business", async () => {
    expect(metricEvent("down")).toBe("appDown");
    expect(metricEvent("crash_loop")).toBe("appDown");
    expect(metricEvent("disk")).toBeNull();
    expect(metricEvent("memory")).toBeNull();
    const event = (metric: string) => ({ id: notice.id, metric, service: null, detail: "d", href: "/alerts", startedAt: new Date(0), resolvedAt: null, muted: false, ruleId: null, app: null });
    const run = async (metric: string, events: Record<string, boolean>) => {
      const w = world({ events });
      const r = answering();
      const db = { ...(w.db as unknown as Record<string, unknown>), alertEvent: { findUnique: async () => event(metric), update: async () => ({}) } } as unknown as Db;
      const out = await deliverAlert({ db, vault: w.vault, mail: r.mail, publicUrl: "https://dash.example.com" }, { eventId: notice.id, channel: "email", transition: "firing" });
      return { out, calls: r.calls.length };
    };
    expect(await run("down", { appDown: false })).toEqual({ out: "skipped", calls: 0 });
    expect(await run("crash_loop", { appDown: false })).toEqual({ out: "skipped", calls: 0 });
    expect(await run("down", {})).toEqual({ out: "sent", calls: 2 });
    expect(await run("disk", { appDown: false })).toEqual({ out: "sent", calls: 2 });
  });
  it("refuses a malformed notice", () => {
    for (const bad of [null, {}, { ...notice, event: "x" }, { ...notice, href: "https://evil.example" }, { ...notice, id: "a b" }, { ...notice, at: "nope" }]) {
      expect(() => parseEventNotice(bad)).toThrow("malformed");
    }
  });

  describe("sweeps", () => {
    const now = new Date("2026-11-06T12:00:00.000Z");
    it("one notice per failed scheduled backup, however many passes see it", async () => {
      const w = world();
      let where: unknown;
      const db = {
        ...(w.db as unknown as Record<string, unknown>),
        backup: {
          findMany: async (q: { where: unknown }) => {
            where = q.where;
            return [{ id: notice.id, appSnapshot: { name: "db", projectSlug: "shop", environment: "production" }, error: "pg_dump\nexited 1", finishedAt: now }];
          },
        },
      } as unknown as Db;
      expect(await announceFailedBackups(db, now)).toBe(1);
      expect(await announceFailedBackups(db, now)).toBe(0);
      expect(where).toMatchObject({ status: "failed", trigger: "schedule" });
      expect(w.jobs[0]).toMatchObject({ kind: "event_notify", dedupeKey: `event:backupFailed:${notice.id}`, payload: { title: "Backup failed: db", where: "shop / production / db", detail: "pg_dump exited 1" } });
      expect(() => parseEventNotice(w.jobs[0]!.payload)).not.toThrow();
    });
    it("one notice per certificate date: a renewal may warn again, a later pass may not", async () => {
      const w = world();
      const expires = new Date(now.getTime() + 3 * 86_400_000);
      const row = { id: notice.id, hostname: "shop.example.com", tlsExpiresAt: expires, tlsWarnedFor: null as Date | null };
      const db = {
        ...(w.db as unknown as Record<string, unknown>),
        domain: { findMany: async () => [row], update: async ({ data }: { data: { tlsWarnedFor: Date } }) => Object.assign(row, data) },
      } as unknown as Db;
      expect(await announceExpiringCertificates(db, now)).toBe(1);
      expect(await announceExpiringCertificates(db, now)).toBe(0);
      expect(row.tlsWarnedFor).toEqual(expires);
      expect(w.jobs[0]).toMatchObject({ kind: "event_notify", payload: { event: "tlsExpiring", title: "Certificate expiring: shop.example.com", where: "shop.example.com" } });
      expect(String(w.jobs[0]!.payload.detail)).toContain("expires in 3 days");
      expect(() => parseEventNotice(w.jobs[0]!.payload)).not.toThrow();
      row.tlsExpiresAt = new Date(now.getTime() + 5 * 86_400_000);
      expect(await announceExpiringCertificates(db, now)).toBe(1);
    });
    it("queues a given notice once ever", async () => {
      const w = world();
      expect(await queueEventNotice(w.db, notice)).toBe(true);
      expect(await queueEventNotice(w.db, notice)).toBe(false);
    });
  });
});

describe("the data browser on a real Postgres", () => {
  it("reads the last result when node-postgres answers a list, as it does for several statements", () => {
    const one = { fields: [{ name: "a", dataTypeID: 25 }], rows: [["x"]] };
    expect(pgResult(one)).toEqual({ fields: [{ name: "a", dataTypeID: 25 }], rows: [["x"]] });
    expect(pgResult([{}, {}, one])).toEqual({ fields: [{ name: "a", dataTypeID: 25 }], rows: [["x"]] });
    expect(pgResult([])).toEqual({ fields: [], rows: [] });
    expect(pgResult({})).toEqual({ fields: [], rows: [] });
  });
  it("calls only a connection failure unreachable", () => {
    expect(isConnectionError(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isConnectionError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isConnectionError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
  });
});

describe("Traefik's default certificate is not the domain's", () => {
  it("shows no issuer and no expiry while the real one is on its way", async () => {
    const probe: TlsProbe = async () => ({ cert: { issuer: { CN: "TRAEFIK DEFAULT CERT" }, subject: { CN: "TRAEFIK DEFAULT CERT" }, valid_to: "Nov  6 00:00:00 2027 GMT", subjectaltname: "DNS:x.traefik.default" } as never, authorized: false, authorizationError: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    expect(await checkTls(probe, "shop.example.com", ["8.8.8.8"], null, new Date("2026-11-06T00:00:00Z"))).toMatchObject({ status: "pending", issuer: null, expiresAt: null });
  });
});

describe("a preview's image goes with it", () => {
  const IMG = "sha256:aaa";
  const fake = (others: Array<{ imageId: string; previewId: string | null; envStatus?: string }>) => {
    const removed: string[] = [];
    const db = {
      deployment: {
        findMany: async ({ where }: { where: { id: { in?: string[]; notIn?: string[] }; OR?: unknown } }) => {
          if (where.id.in) return [{ imageId: IMG }];
          // What the query asks for: the app's own rows, or a preview that still holds containers.
          return others.filter((o) => o.previewId === null || ["building", "ready", "failed", "asleep", "closing", "blocked"].includes(o.envStatus ?? "")).map((o) => ({ imageId: o.imageId }));
        },
      },
    } as unknown as Db;
    const docker = { removeImage: async (id: string) => void removed.push(id) } as never;
    return { db, docker, removed };
  };
  it("an identical build in a preview closed long ago does not keep it", async () => {
    const f = fake([{ imageId: IMG, previewId: "old", envStatus: "closed" }]);
    expect(await prunePreviewImages(f.db, f.docker, ["d1"], "s1")).toBe(1);
    expect(f.removed).toEqual([IMG]);
  });
  it("the app's own deployment or a live preview does", async () => {
    for (const other of [{ imageId: IMG, previewId: null }, { imageId: IMG, previewId: "p", envStatus: "ready" }]) {
      const f = fake([other]);
      expect(await prunePreviewImages(f.db, f.docker, ["d1"], "s1")).toBe(0);
    }
  });
});

describe("a sleeping preview says so", () => {
  const ID = "pv-11111111-1111-4111-8111-111111111111";
  const app = { id: ID, port: 3000, hosts: ["pr-1-web.preview.example.com"] };
  const direct = { ingress: "direct_tls", certResolver: "le" } as const;
  it("keeps host and certificate, sends every path to one page, and the idle counter does not read it", () => {
    const f = JSON.parse(renderAsleepRouteFile(app, direct, new Set())!) as { http: { routers: Record<string, { rule: string; service: string; tls?: unknown; middlewares: string[] }>; services: Record<string, { loadBalancer: { servers: Array<{ url: string }> } }>; middlewares: Record<string, { replacePath?: { path: string } }> } };
    const r = f.http.routers[ID]!;
    expect(r.rule).toContain("pr-1-web.preview.example.com");
    expect(r.tls).toEqual({ certResolver: "le" });
    expect(r.service).toBe(`${ID}-asleep`);
    expect(Object.keys(f.http.services)).toEqual([`${ID}-asleep`]);
    expect(f.http.services[`${ID}-asleep`]!.loadBalancer.servers[0]!.url).toBe(API_UPSTREAM);
    for (const router of Object.values(f.http.routers)) expect(router.middlewares).toContain(`${ID}-asleep-page`);
    expect(f.http.middlewares[`${ID}-asleep-page`]).toEqual({ replacePath: { path: "/.well-known/dockify-preview-asleep" } });
    const metrics = `traefik_service_requests_total{code="503",method="GET",protocol="https",service="${ID}-asleep@file"} 40\n`;
    expect(parseRequestCounters(metrics).size).toBe(0);
  });
  it("renders in tunnel mode, and not at all with nothing to route", () => {
    expect(renderAsleepRouteFile(app, { ingress: "cloudflare_tunnel" }, new Set())).toContain("replacePath");
    expect(renderAsleepRouteFile({ ...app, port: null }, direct, new Set())).toBeNull();
  });
});

describe("a browser-facing variable marked secret", () => {
  it("the build log says why it will not be there", () => {
    const lines = planLogLines({ secretKeys: ["NEXT_PUBLIC_URL", "API_KEY"], buildArgKeys: [] });
    expect(lines.join("\n")).toContain("not passed as a build ARG, and a bundler will not see them: NEXT_PUBLIC_URL.");
    expect(lines.join("\n")).not.toContain("bundler will not see them: NEXT_PUBLIC_URL, API_KEY");
  });
});
