/** Cloudflare token, zones and the per-zone opt-in. The domains module only ever touches zones in managedZoneIds. */
import type { Keyring } from "@dockify/crypto";
import type { Tx } from "@dockify/db";
import type { Handlers } from "../../app.ts";
import { audit } from "../../audit.ts";
import { HttpError } from "../../errors.ts";
import { who, type IntegrationDeps } from "./deps.ts";
import { jsonOf, type HttpClient } from "@dockify/net-guard";
import { cloudflareDomainHandlers } from "./cloudflare-domains.ts";
import { asJson, configOf, dropIntegration, findIntegration, hintOfSecret, openSecret, replaceSecret, requireIntegration } from "./store.ts";

export const CF_API = "https://api.cloudflare.com/client/v4";

interface CfConfig {
  account: { id: string; name: string };
  /** Flat ids the worker's edge jobs read (worker/src/edge/integration.ts). */
  accountId: string;
  tunnelId: string | null;
  zones: number;
  managedZoneIds: string[];
  [k: string]: unknown;
}

interface CfEnvelope<T> {
  success: boolean;
  result: T;
  result_info?: { page: number; total_pages: number; total_count: number };
}

export class CloudflareApi {
  private readonly http: HttpClient;
  private readonly token: string;
  constructor(http: HttpClient, token: string) {
    this.http = http;
    this.token = token;
  }

  /** A refusal names the missing permission; the token never appears in what is thrown. */
  async send<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    const res = await this.http({
      method,
      url: `${CF_API}${path}`,
      headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 401 || res.status === 403) throw new HttpError(400, "This Cloudflare token cannot edit DNS here. Give it Zone, DNS, Edit on this zone", "CLOUDFLARE_PERMISSION");
    const out = jsonOf<CfEnvelope<T> & { errors?: Array<{ message?: string }> }>(res);
    if (res.status < 200 || res.status >= 300 || !out?.success) {
      const why = out?.errors?.[0]?.message?.slice(0, 200);
      throw new HttpError(502, why ? `Cloudflare refused it: ${why}` : `Cloudflare returned ${res.status}`, "UPSTREAM");
    }
    return out.result;
  }

  async call<T>(path: string): Promise<CfEnvelope<T>> {
    const res = await this.http({ method: "GET", url: `${CF_API}${path}`, headers: { Authorization: `Bearer ${this.token}` } });
    if (res.status === 401 || res.status === 403) throw new HttpError(400, "Cloudflare refused this token", "CLOUDFLARE_TOKEN");
    const body = jsonOf<CfEnvelope<T>>(res);
    if (res.status < 200 || res.status >= 300 || !body?.success) throw new HttpError(502, `Cloudflare returned ${res.status}`, "UPSTREAM");
    return body;
  }

  /** A user token verifies at /user/tokens/verify; an account token at its account. */
  async verify(): Promise<{ id: string; name: string }> {
    const accounts = await this.call<Array<{ id: string; name: string }>>("/accounts?per_page=5");
    // A token with only zone permissions lists no account, but each zone names the one it is in.
    const first = accounts.result[0]
      ?? (await this.call<Array<{ account?: { id: string; name: string } }>>("/zones?per_page=1")).result[0]?.account;
    if (!first) throw new HttpError(400, "This token cannot see any Cloudflare zone. Give it Zone, DNS, Edit on the zones Dockify should manage", "CLOUDFLARE_TOKEN");
    const status = await this.call<{ status: string }>("/user/tokens/verify")
      .catch(() => this.call<{ status: string }>(`/accounts/${encodeURIComponent(first.id)}/tokens/verify`));
    if (status.result.status !== "active") throw new HttpError(400, `This token is ${status.result.status}`, "CLOUDFLARE_TOKEN");
    return { id: first.id, name: first.name };
  }

  async zones(): Promise<Array<{ id: string; name: string; status: string }>> {
    const out: Array<{ id: string; name: string; status: string }> = [];
    for (let page = 1; page <= 20; page++) {
      const r = await this.call<Array<{ id: string; name: string; status: string }>>(`/zones?per_page=50&page=${page}`);
      out.push(...r.result);
      if (!r.result_info || page >= r.result_info.total_pages) break;
    }
    return out;
  }
}

export async function cloudflareApiFor(db: Tx, ring: Keyring, http: HttpClient): Promise<{ api: CloudflareApi; config: CfConfig; id: string }> {
  const row = await requireIntegration(db, "cloudflare", "default", "Cloudflare");
  const token = await openSecret(db, ring, row);
  if (!token) throw new HttpError(409, "Cloudflare is not connected", "NOT_CONNECTED");
  return { api: new CloudflareApi(http, token), config: configOf<CfConfig>(row), id: row.id };
}

/** Zone ids Dockify may create records in. Empty when Cloudflare is not connected. */
export async function managedZoneIds(db: Tx): Promise<string[]> {
  const row = await findIntegration(db, "cloudflare");
  return row && row.status !== "disconnected" ? (configOf<CfConfig>(row).managedZoneIds ?? []) : [];
}

export async function cloudflareView(db: Tx) {
  const row = await findIntegration(db, "cloudflare");
  if (!row || row.status === "disconnected") return null;
  const c = configOf<CfConfig>(row);
  return {
    account: c.account ?? { id: "", name: "" },
    tokenHint: await hintOfSecret(db, row.secretId),
    connectedAt: row.createdAt.toISOString(),
    error: row.error,
    zones: c.zones ?? 0,
    managed: (c.managedZoneIds ?? []).length,
  };
}

const zoneStatus = (s: string): "active" | "pending" => (s === "active" ? "active" : "pending");

export function cloudflareHandlers(deps: IntegrationDeps): Handlers {
  return {
    ...cloudflareDomainHandlers(deps),
    "integrations.cloudflare.connect": async ({ body, actor, req, ctx }) => {
      const api = new CloudflareApi(deps.http, body.token);
      const account = await api.verify();
      const zones = await api.zones();
      await ctx.db.$transaction(async (tx) => {
        const existing = await findIntegration(tx, "cloudflare");
        const prev = existing ? configOf<CfConfig>(existing).managedZoneIds ?? [] : [];
        const ids = new Set(zones.map((z) => z.id));
        const config = asJson({ account, accountId: account.id, tunnelId: ctx.config.cfTunnelId, zones: zones.length, managedZoneIds: prev.filter((z) => ids.has(z)) });
        const row = existing
          ? await tx.integration.update({ where: { id: existing.id }, data: { config, status: "connected", error: null, lastCheckedAt: new Date() } })
          : await tx.integration.create({ data: { kind: "cloudflare", name: "default", config, lastCheckedAt: new Date() } });
        await replaceSecret(tx, ctx.ring, row, "primary", "integration_token", body.token);
        await audit(tx, { category: "config", action: "integration.cloudflare.connect", verb: "connected Cloudflare", targetType: "integration", targetLabel: account.name, ...who(actor, req) });
      });
      const view = await cloudflareView(ctx.db);
      if (!view) throw new HttpError(500, "Cloudflare row vanished", "INTERNAL");
      return view;
    },

    "integrations.cloudflare.delete": async ({ actor, req, ctx }) => {
      await ctx.db.$transaction(async (tx) => {
        const row = await findIntegration(tx, "cloudflare");
        if (!row) return;
        await dropIntegration(tx, row);
        await audit(tx, { category: "config", action: "integration.cloudflare.delete", verb: "disconnected Cloudflare", targetType: "integration", ...who(actor, req) });
      });
      return undefined;
    },

    "integrations.cloudflare.zones": async ({ ctx }) => {
      const { api, config, id } = await cloudflareApiFor(ctx.db, ctx.ring, deps.http);
      const zones = await api.zones();
      const managed = new Set(config.managedZoneIds ?? []);
      if (zones.length !== config.zones) {
        await ctx.db.integration.update({ where: { id }, data: { config: asJson({ ...config, zones: zones.length }), lastCheckedAt: new Date() } });
      }
      return zones.map((z) => ({ id: z.id, name: z.name, status: zoneStatus(z.status), managed: managed.has(z.id) }));
    },

    "integrations.cloudflare.zone": async ({ params, body, actor, req, ctx }) => {
      const { api } = await cloudflareApiFor(ctx.db, ctx.ring, deps.http);
      const zone = (await api.zones()).find((z) => z.id === params.id);
      if (!zone) throw new HttpError(404, "This token cannot see that zone", "NOT_FOUND");
      await ctx.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dockify.integration.cloudflare'))`;
        const row = await requireIntegration(tx, "cloudflare", "default", "Cloudflare");
        const c = configOf<CfConfig>(row);
        const set = new Set(c.managedZoneIds ?? []);
        if (body.managed) set.add(zone.id);
        else set.delete(zone.id);
        await tx.integration.update({ where: { id: row.id }, data: { config: asJson({ ...c, managedZoneIds: [...set] }) } });
        await audit(tx, {
          category: "config", action: "integration.cloudflare.zone", verb: body.managed ? "let Dockify manage DNS for" : "stopped Dockify managing DNS for",
          targetType: "cloudflare_zone", targetId: zone.id, targetLabel: zone.name, ...who(actor, req),
        });
      });
      return { id: zone.id, name: zone.name, status: zoneStatus(zone.status), managed: body.managed };
    },
  };
}
