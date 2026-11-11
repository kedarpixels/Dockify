/** Registry credentials for private images. The worker opens one at pull time (apps/worker/src/integrations/registry-auth.ts). */
import type { Integration, Tx } from "@dockify/db";
import type { Handlers } from "../../app.ts";
import { audit } from "../../audit.ts";
import { HttpError } from "../../errors.ts";
import { who, type IntegrationDeps } from "./deps.ts";
import { isPublicHostname, jsonOf, OutboundError, type HttpClient } from "@dockify/net-guard";
import { asJson, configOf, dropIntegration, hintOfSecret, replaceSecret } from "./store.ts";

export type RegistryKind = "ghcr" | "dockerhub" | "custom";

interface RegistryConfig {
  kind: RegistryKind;
  host: string;
  username: string;
  [k: string]: unknown;
}

export const DEFAULT_HOST: Record<Exclude<RegistryKind, "custom">, string> = { ghcr: "ghcr.io", dockerhub: "docker.io" };
/** Docker Hub's registry API host differs from its image prefix. */
export const apiHost = (host: string) => (host === "docker.io" ? "registry-1.docker.io" : host);

export function resolveHost(kind: RegistryKind, host: string | undefined): string {
  if (kind !== "custom") return DEFAULT_HOST[kind];
  if (!host) throw new HttpError(400, "A custom registry needs its host", "INVALID_REQUEST", { field: "host" });
  if (!isPublicHostname(host)) throw new HttpError(400, "The registry host must be a public address", "INVALID_REQUEST", { field: "host" });
  return host.toLowerCase();
}

/** Parses `Bearer realm="...",service="...",scope="..."`. */
export function parseChallenge(header: string | string[] | undefined): { realm: string; service?: string } | null {
  const h = Array.isArray(header) ? header[0] : header;
  if (!h || !/^bearer\s/i.test(h)) return null;
  const params: Record<string, string> = {};
  for (const m of h.slice(7).matchAll(/(\w+)="([^"]*)"/g)) params[m[1] ?? ""] = m[2] ?? "";
  return params.realm ? { realm: params.realm, ...(params.service ? { service: params.service } : {}) } : null;
}

export type CheckResult = { ok: true } | { ok: false; reason: "auth" | "unreachable"; message: string };

/** The registry v2 handshake: /v2/, then the token realm when it asks. */
export async function checkRegistry(http: HttpClient, host: string, username: string, token: string): Promise<CheckResult> {
  const basic = `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
  try {
    const first = await http({ method: "GET", url: `https://${apiHost(host)}/v2/`, headers: { Authorization: basic } });
    if (first.status === 200) return { ok: true };
    const challenge = first.status === 401 ? parseChallenge(first.headers["www-authenticate"]) : null;
    if (!challenge) return first.status === 401 ? { ok: false, reason: "auth", message: "The registry refused these credentials" } : { ok: false, reason: "unreachable", message: `The registry answered ${first.status}` };
    const realm = new URL(challenge.realm);
    if (challenge.service) realm.searchParams.set("service", challenge.service);
    const tok = await http({ method: "GET", url: realm.toString(), headers: { Authorization: basic } });
    if (tok.status === 200 && jsonOf<{ token?: string; access_token?: string }>(tok)) return { ok: true };
    if (tok.status === 401 || tok.status === 403) return { ok: false, reason: "auth", message: "The registry refused these credentials" };
    return { ok: false, reason: "unreachable", message: `The registry token service answered ${tok.status}` };
  } catch (e) {
    return { ok: false, reason: "unreachable", message: e instanceof OutboundError ? e.message : "The registry could not be reached" };
  }
}

export async function registryView(db: Tx, row: Integration) {
  const c = configOf<RegistryConfig>(row);
  return {
    id: row.id,
    kind: c.kind,
    host: c.host,
    username: c.username,
    tokenHint: await hintOfSecret(db, row.secretId),
    addedAt: row.createdAt.toISOString(),
    error: row.error,
  };
}

const notFound = () => new HttpError(404, "Unknown registry", "NOT_FOUND");

export function registryHandlers(deps: IntegrationDeps): Handlers {
  return {
    "integrations.registries.list": async ({ ctx }) => {
      const rows = await ctx.db.integration.findMany({ where: { kind: "registry" }, orderBy: { createdAt: "asc" } });
      return Promise.all(rows.map((r) => registryView(ctx.db, r)));
    },

    "integrations.registries.create": async ({ body, actor, req, ctx }) => {
      const host = resolveHost(body.kind, body.host);
      const check = await checkRegistry(deps.http, host, body.username, body.token);
      if (!check.ok && check.reason === "auth") throw new HttpError(400, check.message, "REGISTRY_AUTH", { field: "token" });
      const row = await ctx.db.$transaction(async (tx) => {
        const r = await tx.integration.create({
          data: {
            kind: "registry",
            name: `${host}/${body.username}`.slice(0, 200),
            config: asJson({ kind: body.kind, host, username: body.username }),
            status: check.ok ? "connected" : "error",
            error: check.ok ? null : check.message,
            lastCheckedAt: new Date(),
          },
        }).catch((e: unknown) => {
          if ((e as { code?: string }).code === "P2002") throw new HttpError(409, "These credentials are already stored", "DUPLICATE");
          throw e;
        });
        await replaceSecret(tx, ctx.ring, r, "primary", "integration_token", body.token);
        await audit(tx, { category: "config", action: "integration.registry.create", verb: "added registry credentials for", targetType: "registry", targetId: r.id, targetLabel: host, ...who(actor, req) });
        return tx.integration.findUniqueOrThrow({ where: { id: r.id } });
      });
      return registryView(ctx.db, row);
    },

    "integrations.registries.patch": async ({ params, body, actor, req, ctx }) => {
      const row = await ctx.db.integration.findFirst({ where: { id: params.id, kind: "registry" } });
      if (!row) throw notFound();
      const c = configOf<RegistryConfig>(row);
      const kind = body.kind ?? c.kind;
      const host = body.kind || body.host ? resolveHost(kind, body.host ?? (kind === "custom" ? c.host : undefined)) : c.host;
      const username = body.username ?? c.username;
      const token = body.token ? body.token : null;
      let status = row.status;
      let error = row.error;
      // A stored token only goes to the host and username it was saved for. Re-pointing the row would otherwise
      // hand it to any host, on this check and on every later pull.
      if (!token && (host !== c.host || username !== c.username)) {
        throw new HttpError(400, "Enter the token again: a stored token only goes to the registry and username it was saved for.", "INVALID_REQUEST", { field: "token" });
      }
      if (token) {
        const check = await checkRegistry(deps.http, host, username, token);
        if (!check.ok && check.reason === "auth") throw new HttpError(400, check.message, "REGISTRY_AUTH", { field: "token" });
        status = check.ok ? "connected" : "error";
        error = check.ok ? null : check.message;
      }
      const updated = await ctx.db.$transaction(async (tx) => {
        await tx.integration.update({
          where: { id: row.id },
          data: { name: `${host}/${username}`.slice(0, 200), config: asJson({ kind, host, username }), status, error, lastCheckedAt: new Date() },
        });
        if (token) await replaceSecret(tx, ctx.ring, row, "primary", "integration_token", token);
        await audit(tx, { category: "config", action: "integration.registry.patch", verb: "changed registry credentials for", targetType: "registry", targetId: row.id, targetLabel: host, ...who(actor, req) });
        return tx.integration.findUniqueOrThrow({ where: { id: row.id } });
      });
      return registryView(ctx.db, updated);
    },

    "integrations.registries.delete": async ({ params, actor, req, ctx }) => {
      await ctx.db.$transaction(async (tx) => {
        const row = await tx.integration.findFirst({ where: { id: params.id, kind: "registry" } });
        if (!row) throw notFound();
        const users = await tx.app.count({ where: { registryId: row.id } });
        if (users) throw new HttpError(409, `${users} app(s) pull with these credentials`, "IN_USE");
        await dropIntegration(tx, row);
        await audit(tx, { category: "config", action: "integration.registry.delete", verb: "removed registry credentials for", targetType: "registry", targetId: row.id, targetLabel: configOf<RegistryConfig>(row).host, ...who(actor, req) });
      });
      return undefined;
    },
  };
}
