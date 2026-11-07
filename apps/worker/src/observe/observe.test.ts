import { describe, expect, it } from "vitest";
import { CLEAR_MS, DEFAULT_THRESHOLD, evaluate, read, step, subjectOfEvent, type AppView, type Rule, type Track, type World } from "./alerts.ts";
import { workerIssueMessages } from "./alert-runner.ts";
import { PermanentJobError } from "../errors.ts";
import { alertMessage, deliverAlert, parseNotifyPayload, type AlertView } from "./channels.ts";
import { loadObserveConfig } from "./config.ts";
import { parseDockerHost } from "@dockify/engine";
import { pickAppContainers, type ContainerSummary } from "./docker.ts";
import { clean, Demuxer, guessLevel, LineSplitter, splitTimestamp } from "./logparse.ts";
import { droppedMarker, LogBudget, MAX_BYTES_PER_SEC, MAX_LINES_PER_SEC, planShed, rowsToShed } from "./logs.ts";
import { MARK, Redactor } from "@dockify/redact";
import { server } from "@dockify/contracts";
import { floorTo, planWindow } from "./rollup.ts";
import { newSamplerState, noteRestarts, type AppLatest } from "./sampler.ts";
import { isPublicAddress, outboundUrlProblem } from "@dockify/net-guard";
import { containerCpuPct, containerMemBytes, containerNetTotals, cpuBusyPct, parseMeminfo, parseNetDev, parseProcStat } from "./stats.ts";
import { minuteState, utcDay } from "./uptime.ts";
import { serviceInput, type ServiceApp, type ServiceKind } from "../data/services.ts";

describe("ssrf (alert channels use the shared rule)", () => {
  it("refuses internal literals and allows global unicast", () => {
    for (const a of ["10.1.2.3", "169.254.169.254", "::1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2002:0a00:0001::1"]) expect(isPublicAddress(a), a).toBe(false);
    for (const a of ["1.1.1.1", "162.159.135.232", "2606:4700::1111"]) expect(isPublicAddress(a), a).toBe(true);
  });
  it("checks the stored URL shape", () => {
    expect(outboundUrlProblem("http://discord.com/api/webhooks/1/x")).toMatch(/https/);
    expect(outboundUrlProblem("https://user:pw@example.com/x")).toMatch(/credentials/);
    expect(outboundUrlProblem("https://127.0.0.1/x")).toMatch(/public/);
    expect(outboundUrlProblem("https://[::1]/x")).toMatch(/public/);
    expect(outboundUrlProblem("https://intranet/x")).toMatch(/public/);
    expect(outboundUrlProblem("https://discord.com/api/webhooks/1/x")).toBeNull();
  });
});

describe("redact", () => {
  it("hides literal secrets and self-naming credentials", () => {
    const r = new Redactor().conceal(["s3cr3t-value", "true"]);
    expect(r.line("connecting with s3cr3t-value now")).toBe(`connecting with ${MARK} now`);
    expect(r.line("flag is true")).toBe("flag is true");
    expect(r.line("postgres://app:hunter22@db:5432/x")).toBe(`postgres://${MARK}@db:5432/x`);
    expect(r.line("API_KEY=abcdef123")).toBe(`API_KEY=${MARK}`);
    expect(r.line("Authorization: Bearer abcdefghijklmnop")).toContain(MARK);
  });
  it("swallows a PEM body", () => {
    const r = new Redactor();
    expect(r.line("-----BEGIN PRIVATE KEY-----")).toBe(MARK);
    expect(r.line("MIIEvQIBADANBg")).toBe(MARK);
    expect(r.line("-----END PRIVATE KEY-----")).toBe(MARK);
    expect(r.line("after")).toBe("after");
  });
});

describe("stats", () => {
  it("computes docker cpu and working set", () => {
    const s = {
      cpu_stats: { cpu_usage: { total_usage: 2_000 }, system_cpu_usage: 20_000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 1_000 }, system_cpu_usage: 10_000 },
      memory_stats: { usage: 1_000, stats: { inactive_file: 300 } },
      networks: { eth0: { rx_bytes: 5, tx_bytes: 7 }, eth1: { rx_bytes: 1, tx_bytes: 1 } },
    };
    expect(containerCpuPct(s)).toBe(40);
    expect(containerMemBytes(s)).toBe(700);
    expect(containerNetTotals(s)).toEqual({ rx: 6, tx: 8 });
    expect(containerCpuPct({})).toBe(0);
  });
  it("parses /proc", () => {
    const a = parseProcStat("cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 1 1 1\n");
    const b = parseProcStat("cpu  150 0 150 900 0 0 0 0 0 0\n");
    expect(a && b && cpuBusyPct(a, b)).toBe(50);
    expect(parseMeminfo("MemTotal:  1000 kB\nMemFree: 100 kB\nMemAvailable:  400 kB\n")).toEqual({ totalBytes: 1_024_000, availableBytes: 409_600 });
    const net = "h1\nh2\n  lo: 100 0 0 0 0 0 0 0 100 0\n eth0: 10 0 0 0 0 0 0 0 20 0\nveth1: 99 0 0 0 0 0 0 0 99 0\n";
    expect(parseNetDev(net)).toEqual({ rx: 10, tx: 20 });
  });
});

describe("rollup windows", () => {
  const FIVE = 300_000;
  it("rolls only closed buckets and resumes after the newest", () => {
    const now = Date.UTC(2026, 9, 30, 12, 7, 30);
    const w = planWindow(null, new Date(Date.UTC(2026, 9, 30, 11, 52, 10)), now, "five_min");
    expect(w?.from.toISOString()).toBe("2026-10-30T11:50:00.000Z");
    expect(w?.to.toISOString()).toBe("2026-10-30T12:05:00.000Z");
    const next = planWindow(new Date(Date.UTC(2026, 9, 30, 12, 0)), null, now, "five_min");
    expect(next).toBeNull();
    const later = planWindow(new Date(Date.UTC(2026, 9, 30, 12, 0)), null, now + FIVE, "five_min");
    expect(later?.from.toISOString()).toBe("2026-10-30T12:05:00.000Z");
  });
  it("caps how far back one pass goes", () => {
    const now = Date.UTC(2026, 9, 30, 12, 0);
    const w = planWindow(null, new Date(now - 10 * 86_400_000), now, "five_min");
    expect(w && now - w.from.getTime()).toBe(24 * 3_600_000);
    expect(floorTo(FIVE + 1, FIVE)).toBe(FIVE);
  });
});

const app = (over: Partial<AppView> = {}): AppView => ({
  id: "a1", name: "web", expectRunning: true,
  container: { state: "running", health: null, memBytes: 100, memLimitBytes: 1000 }, restarts: [], ...over,
});
const world = (over: Partial<World> = {}): World => ({
  now: 1_000_000_000, disk: { usedBytes: 50, totalBytes: 100 },
  services: { api: true, worker: true, proxy: null, database: true },
  apps: new Map([["a1", app()]]), dockerSeen: true, ...over,
});
const rule = (over: Partial<Rule> = {}): Rule => ({
  id: "r1", metric: "down", appId: null, service: null, threshold: null, durationMin: 2, channels: ["bell", "email"], webhooks: [], enabled: true, ...over,
});

describe("alert engine", () => {
  it("fires the host disk rule at 85 percent, the documented default, unless the rule sets its own", () => {
    expect(DEFAULT_THRESHOLD.disk).toBe(server.DISK_ALERT_DEFAULT_PCT);
    expect(DEFAULT_THRESHOLD.disk).toBe(85);
  });

  it("fires only after the condition held for durationMin, once", () => {
    const tracks = new Map<string, Track>();
    const r = rule();
    const down = (now: number) => world({ now, apps: new Map([["a1", app({ container: null })]]) });
    expect(evaluate([r], down(0), [], new Set(), tracks).open).toHaveLength(0);
    expect(evaluate([r], down(60_000), [], new Set(), tracks).open).toHaveLength(0);
    const d = evaluate([r], down(120_000), [], new Set(), tracks);
    expect(d.open).toHaveLength(1);
    expect(d.open[0]?.detail).toBe("web has no container");
    expect(d.open[0]?.href).toBe("/apps/a1");
    // With the event open, the same breach opens nothing more: that is the dedupe.
    const again = evaluate([r], down(180_000), [{ id: "e1", ruleId: "r1", subject: "app:a1" }], new Set(), tracks);
    expect(again.open).toHaveLength(0);
  });
  it("resolves after the condition is clear for a minute", () => {
    const tracks = new Map<string, Track>();
    const open = [{ id: "e1", ruleId: "r1", subject: "app:a1" }];
    expect(evaluate([rule()], world({ now: 0 }), open, new Set(), tracks).resolve).toHaveLength(0);
    expect(evaluate([rule()], world({ now: CLEAR_MS }), open, new Set(), tracks).resolve).toEqual([{ eventId: "e1", reason: "cleared" }]);
  });
  it("holds state on missing data and resolves events of removed rules", () => {
    const tracks = new Map<string, Track>();
    const blind = world({ dockerSeen: false, apps: new Map([["a1", app({ container: null })]]) });
    expect(evaluate([rule({ durationMin: 1 })], { ...blind, now: 10 ** 9 }, [], new Set(), tracks).open).toHaveLength(0);
    const gone = evaluate([], world(), [{ id: "e9", ruleId: "dead", subject: "app:a1" }], new Set(), tracks);
    expect(gone.resolve).toEqual([{ eventId: "e9", reason: "rule or app removed" }]);
  });
  it("marks events of muted apps", () => {
    const d = evaluate([rule({ durationMin: 1 })], world({ now: 0, apps: new Map([["a1", app({ container: null })]]) }), [], new Set(["a1"]), new Map([["r1|app:a1", { breachSince: -60_000 }]]));
    expect(d.open[0]?.muted).toBe(true);
  });
  it("applies hysteresis to disk", () => {
    const r = rule({ metric: "disk", threshold: 90 });
    const s = { key: "host", appId: null, service: null };
    expect(read(r, s, world({ disk: { usedBytes: 88, totalBytes: 100 } }), false).breached).toBe(false);
    expect(read(r, s, world({ disk: { usedBytes: 88, totalBytes: 100 } }), true).breached).toBe(true);
    expect(read(r, s, world({ disk: { usedBytes: 84, totalBytes: 100 } }), true).breached).toBe(false);
  });
  it("counts crash loop restarts inside the window and fires at once", () => {
    const now = 10_000_000;
    const r = rule({ metric: "crash_loop", threshold: 3, durationMin: 5 });
    const w = world({ now, apps: new Map([["a1", app({ restarts: [now - 400_000, now - 200_000, now - 100_000, now - 10_000] })]]) });
    const d = evaluate([r], w, [], new Set(), new Map());
    expect(d.open[0]?.detail).toBe("web restarted 3 times in 5 min");
  });
  it("expands service any into one subject per service", () => {
    const r = rule({ metric: "service", service: "any", durationMin: 1 });
    const tracks = new Map<string, Track>([["r1|service:database", { breachSince: 0 }]]);
    const d = evaluate([r], world({ now: 60_000, services: { api: true, worker: true, proxy: null, database: false } }), [], new Set(), tracks);
    expect(d.open.map((o) => o.service)).toEqual(["database"]);
  });
  it("judges memory against the container limit", () => {
    const s = { key: "app:a1", appId: "a1", service: null };
    const hot = world({ apps: new Map([["a1", app({ container: { state: "running", health: null, memBytes: 950, memLimitBytes: 1000 } })]]) });
    expect(read(rule({ metric: "memory" }), s, hot, false).breached).toBe(true);
  });
  it("counts a worker that reports an issue as failing, with the issue as the detail", () => {
    const r = rule({ metric: "service", service: "worker" });
    const s = { key: "service:worker", appId: null, service: "worker" as const };
    const why = "The worker cannot write its work folder /var/lib/dockify/work/tmp (EACCES: permission denied), where backups and restores stage their files.";
    expect(read(r, s, world({ services: { api: true, worker: false, proxy: null, database: true }, serviceDetail: { worker: why } }), false)).toEqual({ breached: true, detail: why });
    expect(read(r, s, world({ services: { api: true, worker: false, proxy: null, database: true } }), false).detail).toBe("The worker service is not responding");
    expect(workerIssueMessages([{ key: "work_folder", summary: "s", message: why, since: "2026-11-06T12:00:00.000Z" }, { key: "x" }, null])).toEqual([why]);
    expect(workerIssueMessages(null)).toEqual([]);
    expect(workerIssueMessages([])).toEqual([]);
  });
  it("step is a small state machine", () => {
    expect(step({}, null, 5, 0, false)).toEqual({ track: {}, action: null });
    expect(step({}, true, 5, 0, false).action).toBe("open");
    expect(step({ clearSince: 0 }, false, CLEAR_MS, 0, true).action).toBe("resolve");
    expect(subjectOfEvent({ metric: "service", appId: null, service: "proxy" })).toBe("service:proxy");
  });
});

describe("alert delivery to webhooks", () => {
  const view: AlertView = {
    id: "0f0e0d0c-0000-4000-8000-0000000000e1", metric: "down", service: null, detail: "web @everyone is *down*", href: "/apps/a1",
    startedAt: new Date("2026-10-30T10:00:00Z"), resolvedAt: null, app: { name: "web", projectSlug: "shop", environment: "prod" },
  };
  const EVENT = view.id;
  const HOOK = "0f0e0d0c-0000-4000-8000-0000000000f1";
  const SLACK = ["https://hooks.slack.com/services", "T0ABCDEF12", "B0ABCDEF34", "abcdEFGHijklMNOPqrstUVWX"].join("/");

  it("builds one message per alert, critical when an app is down and a warning when a resource runs high", () => {
    const m = alertMessage(view, "firing", "https://dockify.example.com", "Acme");
    expect(m).toMatchObject({
      id: `${EVENT}-firing`, event: "alert.firing", severity: "critical", title: "Firing: App down", url: "https://dockify.example.com/apps/a1",
      fields: [{ name: "Where", value: "shop / prod / web" }], instance: { name: "Acme", url: "https://dockify.example.com" },
    });
    expect(alertMessage({ ...view, metric: "disk", app: null }, "firing", null, "Acme")).toMatchObject({ severity: "warning", url: null, fields: [{ value: "host" }] });
    expect(alertMessage({ ...view, resolvedAt: new Date("2026-10-30T10:05:00Z") }, "resolved", null, "Acme")).toMatchObject({ event: "alert.resolved", severity: "success", title: "Resolved: App down", at: "2026-10-30T10:05:00.000Z" });
  });

  it("keeps the generic webhook's alert shape of earlier versions", () => {
    const m = alertMessage({ ...view, metric: "crash_loop" }, "resolved", null, "Acme");
    expect(m.data).toEqual({
      alert: { id: EVENT, metric: "crashLoop", detail: view.detail, startedAt: "2026-10-30T10:00:00.000Z", resolvedAt: null, url: "/apps/a1" },
      app: { name: "web", projectSlug: "shop", environment: "prod" }, service: null,
    });
  });

  it("reads the new payloads and the ones an earlier version queued", () => {
    expect(parseNotifyPayload({ eventId: EVENT, channel: "webhook", webhookId: HOOK, transition: "firing" }).to).toEqual({ kind: "webhook", webhookId: HOOK });
    expect(parseNotifyPayload({ eventId: EVENT, channel: "email", transition: "resolved" }).to).toEqual({ kind: "email" });
    expect(parseNotifyPayload({ eventId: EVENT, channel: "discord", transition: "firing" }).to).toEqual({ kind: "legacy", provider: "discord" });
    expect(parseNotifyPayload({ eventId: EVENT, channel: "webhook", transition: "firing" }).to).toEqual({ kind: "legacy", provider: "generic" });
    expect(() => parseNotifyPayload({ eventId: "x", channel: "email", transition: "firing" })).toThrow(PermanentJobError);
    expect(() => parseNotifyPayload({ eventId: EVENT, channel: "webhook", webhookId: "nope", transition: "firing" })).toThrow(PermanentJobError);
    expect(() => parseNotifyPayload({ eventId: EVENT, channel: "sms", transition: "firing" })).toThrow(PermanentJobError);
  });

  /** An event, its rule's webhook links and one Slack webhook, in memory; the vault opens the sealed URL. */
  function world(opts: { muted?: boolean; enabled?: boolean } = {}) {
    const updates: Array<{ table: string; data: unknown }> = [];
    const db = {
      alertEvent: {
        findUnique: async () => ({
          ...view, ruleId: "r1", appId: "a1", state: "firing", muted: opts.muted ?? false, notifiedAt: null,
          app: { id: "a1", name: "web", kind: "frontend", iconChoice: "auto", icons: [], environment: { name: "prod", project: { id: "p1", slug: "shop", name: "Shop", iconChoice: "auto", icons: [], environments: [] } } },
        }),
        update: async (a: { data: unknown }) => updates.push({ table: "alertEvent", data: a.data }),
      },
      alertRuleWebhook: { findMany: async ({ where }: { where: { webhook: { provider: string } } }) => (where.webhook.provider === "slack" ? [{ webhookId: HOOK }] : []) },
      notificationWebhook: {
        findUnique: async () => ({ provider: "slack", enabled: opts.enabled ?? true, chatId: null, secretId: "s1", secondSecretId: null }),
        update: async (a: { data: unknown }) => updates.push({ table: "webhook", data: a.data }),
      },
      instance: { findUnique: async () => ({ name: "Acme" }) },
    };
    const vault = { open: async (_tx: unknown, ids: string[]) => new Map(ids.map((id) => [id, id === "s1" ? SLACK : null])), seal: async () => { throw new Error("no"); }, escrow: async () => { throw new Error("no"); } };
    return { db: db as never, vault: vault as never, updates };
  }
  const answering = (status: number, body = "") => {
    const sent: Array<{ url: string; body: string }> = [];
    const http = async (r: { url: string; body?: string | Buffer }) => {
      sent.push({ url: r.url, body: String(r.body) });
      return { status, headers: {}, body: Buffer.from(body) };
    };
    return { http: http as never, sent };
  };
  const payload = { eventId: EVENT, channel: "webhook", webhookId: HOOK, transition: "firing" };

  it("sends the alert in the webhook's own format and records notifiedAt and the webhook's success", async () => {
    const w = world();
    const { http, sent } = answering(200, "ok");
    expect(await deliverAlert({ db: w.db, vault: w.vault, publicUrl: "https://dockify.example.com", http }, payload)).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(SLACK);
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ blocks: expect.any(Array), text: expect.stringContaining("Firing: App down") });
    expect(w.updates.map((u) => u.table).sort()).toEqual(["alertEvent", "webhook"]);
  });

  it("retries a 5xx, stops for good on a 4xx, and records why on the webhook", async () => {
    const retry = world();
    await expect(deliverAlert({ db: retry.db, vault: retry.vault, publicUrl: null, http: answering(503).http }, payload)).rejects.not.toBeInstanceOf(PermanentJobError);
    const stop = world();
    await expect(deliverAlert({ db: stop.db, vault: stop.vault, publicUrl: null, http: answering(404, "no_service").http }, payload)).rejects.toBeInstanceOf(PermanentJobError);
    expect(stop.updates.find((u) => u.table === "webhook")?.data).toMatchObject({ error: "Slack answered 404 (no_service)" });
  });

  it("sends nothing for a muted event or a switched off webhook", async () => {
    const { http, sent } = answering(200);
    const muted = world({ muted: true });
    expect(await deliverAlert({ db: muted.db, vault: muted.vault, publicUrl: null, http }, payload)).toBe("skipped");
    const off = world({ enabled: false });
    expect(await deliverAlert({ db: off.db, vault: off.vault, publicUrl: null, http }, payload)).toBe("skipped");
    expect(sent).toEqual([]);
  });

  it("delivers a job an earlier version queued to the rule's webhooks of that provider", async () => {
    const w = world();
    const { http, sent } = answering(204);
    // The world links only a Slack webhook: an old discord job has nothing to go to.
    expect(await deliverAlert({ db: w.db, vault: w.vault, publicUrl: null, http }, { eventId: EVENT, channel: "discord", transition: "firing" })).toBe("skipped");
    expect(sent).toEqual([]);
  });
});

describe("logs parsing", () => {
  const frame = (kind: number, text: string): Buffer => {
    const p = Buffer.from(text);
    const h = Buffer.alloc(8);
    h[0] = kind;
    h.writeUInt32BE(p.length, 4);
    return Buffer.concat([h, p]);
  };
  it("demuxes frames split across chunks and splits lines per stream", () => {
    const all = Buffer.concat([frame(1, "2026-10-30T10:00:00.123456789Z hello\n2026-10-30T10:00:01Z par"), frame(2, "oops\n"), frame(1, "tial\n")]);
    const d = new Demuxer();
    const frames = [...d.push(all.subarray(0, 10)), ...d.push(all.subarray(10))];
    expect(frames.map((f) => f.stream)).toEqual(["stdout", "stderr", "stdout"]);
    const s = new LineSplitter();
    const lines = frames.flatMap((f) => s.push(f));
    expect(lines.map((l) => l.raw)).toEqual(["2026-10-30T10:00:00.123456789Z hello", "oops", "2026-10-30T10:00:01Z partial"]);
  });
  it("reads docker timestamps to the millisecond", () => {
    expect(splitTimestamp("2026-10-30T10:00:00.123456789Z hello", 0)).toEqual({ ms: Date.UTC(2026, 9, 30, 10, 0, 0, 123), text: "hello" });
    expect(splitTimestamp("no stamp", 42)).toEqual({ ms: 42, text: "no stamp" });
  });
  it("guesses levels and strips control characters", () => {
    expect(guessLevel('{"level":50,"msg":"x"}')).toBe("error");
    expect(guessLevel('{"level":"warn"}')).toBe("warn");
    expect(guessLevel("[INFO] started")).toBe("info");
    expect(guessLevel("plain text")).toBeNull();
    expect(clean("\u001b[31mred\u001b[0m\u0007")).toBe("red");
  });
});

describe("runtime log budget", () => {
  const T = Date.UTC(2026, 9, 30, 10, 0, 0, 0);
  it("a flush (taking the dropped count) never resets what an app already spent this second", () => {
    const b = new LogBudget();
    for (let i = 0; i < MAX_LINES_PER_SEC; i++) expect(b.admit("a", 10, T + 1)).toBe(true);
    expect(b.admit("a", 10, T + 2)).toBe(false);
    // The size-triggered flush path: only the dropped counters reset.
    expect(b.takeDropped()).toEqual([{ appId: "a", dropped: 1, reason: "lines" }]);
    expect(b.admit("a", 10, T + 3)).toBe(false);
    // The next wall-clock second opens a fresh window.
    expect(b.admit("a", 10, T + 1000)).toBe(true);
  });
  it("caps bytes per second, not just lines, and shares the budget across an app's containers", () => {
    const b = new LogBudget();
    const line = 4096;
    const fit = Math.floor(MAX_BYTES_PER_SEC / line);
    for (let i = 0; i < fit; i++) expect(b.admit("a", line, T)).toBe(true);
    expect(b.admit("a", line, T + 5)).toBe(false);
    expect(b.takeDropped()[0]?.reason).toBe("bytes");
    expect(b.admit("other", line, T)).toBe(true);
  });
  it("caps bytes per day and resets at the UTC day boundary", () => {
    const b = new LogBudget({ linesPerSec: 1_000, bytesPerSec: 1_000_000, bytesPerDay: 2_500 });
    expect(b.admit("a", 1_000, T)).toBe(true);
    expect(b.admit("a", 1_000, T + 1_000)).toBe(true);
    expect(b.admit("a", 1_000, T + 2_000)).toBe(false);
    expect(droppedMarker(b.takeDropped()[0]!)).toMatch(/1 lines dropped: over \d+ MiB today/);
    expect(b.admit("a", 1_000, Date.UTC(2026, 9, 31, 0, 0, 1))).toBe(true);
  });
  it("sheds by live size, not the relation size Postgres never gives back", () => {
    expect(rowsToShed({ totalBytes: 100, liveRows: 10, deadRows: 0 }, 1_000)).toBe(0);
    // 10 GB relation, half of it dead rows: 5 GB live against a 4 GB budget.
    const shed = rowsToShed({ totalBytes: 10e9, liveRows: 1e6, deadRows: 1e6 }, 4e9);
    expect(shed).toBe(Math.ceil((5e9 - 3.6e9) / 5_000));
    expect(rowsToShed({ totalBytes: 10e9, liveRows: 0, deadRows: 1e6 }, 1)).toBe(0);
  });
  it("takes the per-app ceiling first, then the noisiest app first", () => {
    const plan = planShed([{ appId: "quiet", rows: 100 }, { appId: "loud", rows: 900 }, { appId: "huge", rows: 2_000 }], { maxRowsPerApp: 1_500 }, 800);
    expect(plan.get("huge")).toBe(800);
    expect(plan.has("quiet")).toBe(false);
    const more = planShed([{ appId: "quiet", rows: 100 }, { appId: "loud", rows: 900 }], { maxRowsPerApp: 1_500 }, 1_000);
    expect(more.get("loud")).toBe(900);
    expect(more.get("quiet")).toBe(100);
  });
  it("loads the table caps with safe defaults", () => {
    const cfg = loadObserveConfig({});
    expect(cfg.logCaps.maxTableBytes).toBe(4096 * 1024 ** 2);
    expect(cfg.logCaps.maxRowsPerApp).toBe(500_000);
  });
});

describe("sampler helpers", () => {
  const c = (over: Partial<ContainerSummary>): ContainerSummary => ({ Id: "x", Names: ["/web"], Labels: {}, State: "running", Status: "", Created: 1, ...over });
  it("picks one container per app, skips parked, and ignores preview and release containers", () => {
    const m = pickAppContainers([
      c({ Id: "old", Labels: { "dockify.app": "a1", "dockify.role": "app" }, Created: 1 }),
      c({ Id: "new", Labels: { "dockify.app": "a1", "dockify.role": "app" }, Created: 2 }),
      c({ Id: "park", Names: ["/web-prev-k3j2"], Labels: { "dockify.app": "a1", "dockify.role": "app" }, Created: 3 }),
      // a preview inherits dockify.app=<base app id> from its image label but is role=preview; a
      // release one-off is role=release. Both are newer than "new" and must not shadow the app.
      c({ Id: "prev", Labels: { "dockify.app": "a1", "dockify.role": "preview" }, Created: 4 }),
      c({ Id: "rel", Labels: { "dockify.app": "a1", "dockify.role": "release" }, Created: 5 }),
      c({ Id: "oneoff", Labels: {} }),
    ]);
    expect([...m.entries()].map(([k, v]) => [k, v.Id])).toEqual([["a1", "new"]]);
  });
  it("keeps managed service containers, and never lets a backup or restore helper stand in for one", () => {
    // Labels as data/services.ts really writes them, so a renamed role breaks this test too.
    const creds = { user: "dockify", password: "p".repeat(24) };
    const service = (id: string, kind: ServiceKind, over?: Parameters<typeof serviceInput>[2]): Record<string, string> => {
      const app: ServiceApp = { id, name: `${kind}-db`, kind, environmentId: "e1", projectId: "p1", ...(kind === "s3" ? { image: `minio/minio@sha256:${"0".repeat(64)}` } : {}) };
      return { ...serviceInput(app, creds, over).labels, "dockify.managed": "true" };
    };
    expect(service("s1", "postgres")["dockify.role"]).toBe("service-postgres");
    const m = pickAppContainers([
      c({ Id: "pg", Names: ["/dk-s1"], Labels: service("s1", "postgres"), Created: 1 }),
      c({ Id: "redis", Names: ["/dk-s2"], Labels: service("s2", "redis"), Created: 1 }),
      c({ Id: "minio", Names: ["/dk-s3"], Labels: service("s3", "s3"), Created: 1 }),
      // Newer one-offs that carry the service's own dockify.app label: the volume backup and restore
      // helpers (data/pipeline.ts helper()) and the restore-test scratch Postgres.
      c({ Id: "bk", Names: ["/dockify-bk-b1"], Labels: { "dockify.app": "s1", "dockify.role": "backup-helper", "dockify.managed": "true" }, Created: 5 }),
      c({ Id: "rs", Names: ["/dockify-rs-b2"], Labels: { "dockify.app": "s1", "dockify.role": "restore-helper", "dockify.managed": "true" }, Created: 6 }),
      c({ Id: "rt", Names: ["/dockify-rt-b3"], Labels: service("s1", "postgres", { name: "dockify-rt-b3", volume: null, role: "restore-test", network: "dockify-helpers" }), Created: 7 }),
      // a helper whose service has no container of its own is dropped, not picked in its place
      c({ Id: "orphan", Names: ["/dockify-bk-b4"], Labels: { "dockify.app": "s9", "dockify.role": "backup-helper", "dockify.managed": "true" }, Created: 8 }),
    ]);
    expect(Object.fromEntries([...m].map(([k, v]) => [k, v.Id]))).toEqual({ s1: "pg", s2: "redis", s3: "minio" });
  });
  it("counts restarts of the same container only", () => {
    const st = newSamplerState();
    const base: AppLatest = { at: new Date(), containerId: "c1", state: "running", health: null, startedAt: null, restartCount: 1, cpuPct: 0, memBytes: 0, memLimitBytes: 0 };
    noteRestarts(st, "a1", base, { ...base, restartCount: 3 }, 1000);
    noteRestarts(st, "a1", { ...base, restartCount: 3 }, { ...base, containerId: "c2", restartCount: 0 }, 2000);
    expect(st.restarts.get("a1")).toEqual([1000, 1000]);
  });
  it("classifies uptime minutes", () => {
    expect(minuteState(undefined)).toBe("down");
    expect(minuteState({ state: "running", health: "unhealthy" })).toBe("degraded");
    expect(minuteState({ state: "running", health: null })).toBe("up");
    expect(utcDay(Date.UTC(2026, 9, 30, 23, 59)).toISOString()).toBe("2026-10-30T00:00:00.000Z");
  });
  it("reads config defaults and DOCKER_HOST", () => {
    expect(parseDockerHost(undefined)).toEqual({ socketPath: "/var/run/docker.sock" });
    expect(parseDockerHost("tcp://socket-proxy:2375")).toEqual({ host: "socket-proxy", port: 2375 });
    expect(loadObserveConfig({ DOCKIFY_METRICS_SAMPLE_MS: "1" }).sampleMs).toBe(5_000);
  });
});
