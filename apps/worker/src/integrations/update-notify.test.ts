import { describe, expect, it } from "vitest";
import { fakeMailer } from "../test-mailer.ts";
import type { Db, SecretVault } from "@dockify/db";
import { discordBody, parseNotifyMessage } from "@dockify/notify";
import { PermanentJobError } from "../errors.ts";
import { deliverUpdateNotice, parseUpdateNotify, updateMessage } from "./update-notify.ts";
import { parseWebhookSend, runWebhookSend } from "./webhooks.ts";

const vault = {
  open: async (_tx: unknown, ids: string[]) => new Map(ids.map((id: string) => [id, id === "s-discord" ? "https://discord.com/api/webhooks/1/x" : null])),
  seal: async () => { throw new Error("no seal"); },
  escrow: async () => { throw new Error("no escrow"); },
} as unknown as SecretVault;

const JOB = "0f0e0d0c-0000-4000-8000-0000000000b1";
const HOOK = "0f0e0d0c-0000-4000-8000-0000000000c1";

/** Webhooks that take update notices, and a jobs table that records what was queued. */
function db(hooks: Array<{ id: string }>) {
  const jobs: Array<{ kind: string; payload: unknown; dedupeKey: string | null }> = [];
  const tx = {
    $executeRaw: async () => 0,
    job: {
      findFirst: async ({ where }: { where: { dedupeKey: string } }) => jobs.find((j) => j.dedupeKey === where.dedupeKey) ?? null,
      create: async ({ data }: { data: { kind: string; payload: unknown; dedupeKey: string | null } }) => (jobs.push(data), { id: `j${jobs.length}` }),
    },
  };
  const d = {
    instance: { findUnique: async () => ({ name: "Acme" }) },
    member: { findMany: async () => [] },
    secret: { findMany: async () => [] },
    integration: { findFirst: async () => null, findUnique: async () => null },
    notificationWebhook: { findMany: async ({ where }: { where: { enabled: boolean; updates: boolean } }) => (where.enabled && where.updates ? hooks : []) },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return { db: d as unknown as Db, jobs };
}

describe("update_notify", () => {
  it("parses only well-formed payloads", () => {
    expect(parseUpdateNotify({ event: "rolled_back", version: "v1.2.0", from: "1.1.3", error: "health", updateId: "u" })).toEqual({ event: "rolled_back", version: "1.2.0", from: "1.1.3", error: "health", updateId: "u" });
    expect(() => parseUpdateNotify({ event: "pwn", version: "1.2.0", from: null })).toThrow(PermanentJobError);
    expect(() => parseUpdateNotify({ event: "updated", version: "latest", from: null })).toThrow(PermanentJobError);
  });

  it("writes the update messages", () => {
    const t = (event: "available" | "updated" | "failed" | "rolled_back") => updateMessage({ event, version: "1.2.0", from: "1.1.3", error: null, updateId: null }, "Acme", null, JOB);
    expect(t("available")).toMatchObject({ title: "Update available: Dockify v1.2.0", event: "update.available", severity: "info" });
    expect(t("updated")).toMatchObject({ title: "Updated to Dockify v1.2.0", severity: "success" });
    expect(t("rolled_back")).toMatchObject({ title: "Update failed, rolled back to v1.1.3", severity: "critical" });
    expect(t("updated").fields).toEqual([{ name: "Version", value: "v1.2.0" }, { name: "Before", value: "v1.1.3" }]);
    expect(t("updated").data).toEqual({ update: { event: "updated", version: "1.2.0", from: "1.1.3", error: null } });
  });

  it("never lets an error text ping anyone once it is formatted for Discord", () => {
    const m = updateMessage({ event: "failed", version: "1.2.0", from: null, error: "@everyone `x`", updateId: null }, "Acme", null, JOB);
    const body = discordBody(m) as { allowed_mentions: unknown; embeds: Array<{ description: string }> };
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.embeds[0]!.description).toBe("\\@everyone \\`x\\`");
  });

  it("queues one webhook_send per webhook that takes update notices, once per update job", async () => {
    const d = db([{ id: HOOK }, { id: "0f0e0d0c-0000-4000-8000-0000000000c2" }]);
    const n = { event: "updated", version: "1.2.0", from: "1.1.3", error: null, updateId: "u" };
    const deps = { db: d.db, vault, mail: fakeMailer().mail, publicUrl: "https://dash.example.com" };
    expect(await deliverUpdateNotice(deps, n, JOB)).toEqual([`webhook:${HOOK}`, "webhook:0f0e0d0c-0000-4000-8000-0000000000c2"]);
    expect(d.jobs.map((j) => [j.kind, j.dedupeKey])).toEqual([["webhook_send", `update:${JOB}:${HOOK}`], ["webhook_send", `update:${JOB}:0f0e0d0c-0000-4000-8000-0000000000c2`]]);
    // Each job carries a message the webhook_send job reads back as it is.
    expect(parseWebhookSend(d.jobs[0]!.payload)).toMatchObject({ webhookId: HOOK, message: { event: "update.updated", url: "https://dash.example.com/server#updates" } });
    // A retry of the same update job queues nothing new.
    await deliverUpdateNotice(deps, n, JOB);
    expect(d.jobs).toHaveLength(2);
  });

  it("does nothing when no webhook takes update notices and email is off", async () => {
    const d = db([]);
    expect(await deliverUpdateNotice({ db: d.db, vault, mail: fakeMailer().mail, publicUrl: null }, { event: "available", version: "1.2.0", from: null, error: null, updateId: null }, JOB)).toEqual([]);
    expect(d.jobs).toEqual([]);
  });
});

describe("webhook_send", () => {
  const message = updateMessage({ event: "updated", version: "1.2.0", from: null, error: null, updateId: null }, "Acme", "https://dash.example.com/server#updates", JOB);
  const one = (status: number) => {
    const recorded: unknown[] = [];
    const sent: string[] = [];
    const d = {
      notificationWebhook: {
        findUnique: async () => ({ provider: "discord", enabled: true, chatId: null, secretId: "s-discord", secondSecretId: null }),
        update: async ({ data }: { data: unknown }) => recorded.push(data),
      },
    } as unknown as Db;
    const http = async (r: { url: string }) => (sent.push(r.url), { status, headers: {}, body: Buffer.alloc(0) });
    return { deps: { db: d, vault, http: http as never }, recorded, sent };
  };

  it("sends the prepared message and records the success", async () => {
    const w = one(204);
    expect(await runWebhookSend(w.deps, { webhookId: HOOK, message })).toBe("sent");
    expect(w.sent).toEqual(["https://discord.com/api/webhooks/1/x"]);
    expect(w.recorded[0]).toMatchObject({ error: null });
  });

  it("retries a 5xx and stops on a 4xx", async () => {
    await expect(runWebhookSend(one(502).deps, { webhookId: HOOK, message })).rejects.not.toBeInstanceOf(PermanentJobError);
    await expect(runWebhookSend(one(404).deps, { webhookId: HOOK, message })).rejects.toBeInstanceOf(PermanentJobError);
  });

  it("refuses a malformed payload for good", () => {
    expect(() => parseWebhookSend({ webhookId: "x", message })).toThrow(PermanentJobError);
    expect(() => parseWebhookSend({ webhookId: HOOK, message: { ...message, url: "javascript:alert(1)" } })).toThrow(PermanentJobError);
    expect(parseNotifyMessage(message)).toEqual(message);
  });
});
