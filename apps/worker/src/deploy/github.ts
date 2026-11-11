/** GitHub App installation tokens: cached in memory until five minutes before expiry, never stored or logged. */
import { githubAppJwt } from "@dockify/crypto";
import { readSecretValue, type Db, type SecretVault } from "@dockify/db";
import type { CloneCredential } from "./git.ts";

const RENEW_BEFORE_MS = 5 * 60_000;
const cache = new Map<string, { token: string; expiresAt: number }>();

export interface GitHubDeps {
  db: Db;
  vault: SecretVault;
  apiBase: string;
  fetch?: typeof fetch;
}

export async function installationCredential(deps: GitHubDeps, installationId: bigint | null, repoHost: string | null): Promise<CloneCredential | null> {
  if (installationId === null || repoHost !== "github.com") return null;
  const key = installationId.toString();
  const hit = cache.get(key);
  if (hit && hit.expiresAt - RENEW_BEFORE_MS > Date.now()) return { username: "x-access-token", secret: hit.token };

  const app = await deps.db.integration.findUnique({ where: { kind_name: { kind: "github_app", name: "default" } } });
  if (!app?.secretId) throw new Error("The GitHub App is not connected, so the private repository cannot be cloned");
  const appId = String((app.config as { appId?: unknown }).appId ?? "");
  if (!/^\d{1,12}$/.test(appId)) throw new Error("The GitHub App integration has no valid appId");
  const pem = await readSecretValue(deps.db, deps.vault, app.secretId);
  if (!pem) throw new Error("The GitHub App private key is missing");

  const res = await (deps.fetch ?? fetch)(`${deps.apiBase}/app/installations/${encodeURIComponent(key)}/access_tokens`, {
    method: "POST",
    redirect: "error",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Dockify",
      Authorization: `Bearer ${githubAppJwt(pem, appId)}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  // Status only: the body may quote the JWT back.
  if (!res.ok) throw new Error(`GitHub declined an installation token (status ${res.status})`);
  const body = (await res.json()) as { token: string; expires_at: string };
  cache.set(key, { token: body.token, expiresAt: new Date(body.expires_at).getTime() });
  return { username: "x-access-token", secret: body.token };
}
