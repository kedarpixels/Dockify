import { enqueuePreviewTx, type Instance, type Prisma } from "@dockify/db";
import { audit } from "../../audit.ts";
import { HttpError } from "../../errors.ts";
import { auth as A, projects as P, type BodyOf } from "@dockify/contracts";
import type { Ctx, Handlers } from "../../app.ts";
import { actorAudit, reqMeta, requireActor } from "./shared.ts";

const { NotifyEvent, notifyEvents } = A;

type SettingsRow = Pick<Instance, "name" | "publicUrl" | "defaultBranch" | "buildConcurrency" | "logRetentionDays" | "notifyEvents" | "previewDomain" | "terminalEnabled">;

export const toSettings = (r: SettingsRow) => ({
  instanceName: r.name,
  publicUrl: r.publicUrl,
  defaultBranch: r.defaultBranch,
  buildConcurrency: r.buildConcurrency,
  logRetentionDays: r.logRetentionDays,
  notifications: { events: notifyEvents(r.notifyEvents) },
  previewDomain: r.previewDomain ?? P.defaultPreviewDomain(r.publicUrl),
  previewDomainDefault: P.defaultPreviewDomain(r.publicUrl),
  previewDomainCustom: r.previewDomain !== null,
  terminalEnabled: r.terminalEnabled,
});

export interface SettingsChange {
  data: Prisma.InstanceUpdateInput;
  changes: Array<{ key: string; before: string | null; after: string | null }>;
}

/**
 * The public URL is owned by DOCKIFY_PUBLIC_URL (cookies and CSRF derive from it at boot), so a
 * different value is refused here. It changes only through the Dashboard domain flow.
 */
export function planSettings(row: SettingsRow, body: BodyOf<"settings.patch">, configuredOrigin: string): SettingsChange {
  const data: Prisma.InstanceUpdateInput = {};
  const changes: SettingsChange["changes"] = [];
  const set = <K extends keyof SettingsRow>(key: string, col: K, before: SettingsRow[K], after: SettingsRow[K] | undefined) => {
    if (after === undefined || after === before) return;
    (data as Record<string, unknown>)[col] = after;
    changes.push({ key, before: String(before), after: String(after) });
  };
  if (body.publicUrl !== undefined && new URL(body.publicUrl).origin !== configuredOrigin) {
    throw new HttpError(409, "The dashboard's address changes through Settings, Instance, Dashboard domain, which checks the new domain first.", "PUBLIC_URL_FROM_ENV", { field: "publicUrl" });
  }
  set("instanceName", "name", row.name, body.instanceName);
  set("defaultBranch", "defaultBranch", row.defaultBranch, body.defaultBranch);
  set("buildConcurrency", "buildConcurrency", row.buildConcurrency, body.buildConcurrency);
  set("logRetentionDays", "logRetentionDays", row.logRetentionDays, body.logRetentionDays);
  set("terminalEnabled", "terminalEnabled", row.terminalEnabled, body.terminalEnabled);
  if (body.previewDomain !== undefined) {
    const after = body.previewDomain === null ? null : body.previewDomain.toLowerCase();
    if (after !== null && new URL(configuredOrigin).hostname.toLowerCase() === after) {
      throw new HttpError(400, "The preview domain cannot be the dashboard host", "INVALID_REQUEST", { field: "previewDomain" });
    }
    if (after !== row.previewDomain) {
      data.previewDomain = after;
      changes.push({ key: "previewDomain", before: row.previewDomain, after });
    }
  }
  if (body.notifications) {
    const before = notifyEvents(row.notifyEvents);
    const after = { ...before };
    for (const [k, v] of Object.entries(body.notifications.events)) if (typeof v === "boolean") after[k as A.NotifyEventName] = v;
    for (const k of NotifyEvent.options) if (before[k] !== after[k]) changes.push({ key: `notify.${k}`, before: String(before[k]), after: String(after[k]) });
    if (NotifyEvent.options.some((k) => before[k] !== after[k])) data.notifyEvents = after;
  }
  return { data, changes };
}

async function instance(ctx: Pick<Ctx, "db">) {
  const row = await ctx.db.instance.findUnique({ where: { id: 1 } });
  if (!row) throw new HttpError(503, "The instance is not initialised yet", "NOT_READY");
  return row;
}

export const settingsHandlers: Handlers = {
  "settings.get": async ({ ctx }) => toSettings(await instance(ctx)),

  "settings.patch": async ({ body, actor, req, ctx }) => {
    const a = requireActor(actor);
    const row = await instance(ctx);
    const plan = planSettings(row, body, ctx.config.publicUrl.origin);
    if (!plan.changes.length) return toSettings(row);
    const next = await ctx.db.$transaction(async (tx) => {
      const r = await tx.instance.update({ where: { id: 1 }, data: plan.data });
      if (plan.data.name !== undefined) await tx.team.updateMany({ data: { name: r.name } });
      // Both domains: the new one needs its wildcard record and the old one is dropped once unused.
      if (plan.data.previewDomain !== undefined) {
        for (const d of [row.previewDomain ?? P.defaultPreviewDomain(row.publicUrl), r.previewDomain ?? P.defaultPreviewDomain(r.publicUrl)]) if (d) await enqueuePreviewTx(tx, "preview_dns", d);
      }
      await audit(tx, {
        category: "config", action: "settings.update", verb: "changed instance settings", targetType: "instance",
        targetLabel: r.name, changes: plan.changes, ...actorAudit(a), ...reqMeta(req),
      });
      return r;
    });
    return toSettings(next);
  },
};
