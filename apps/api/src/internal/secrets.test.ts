/**
 * The worker's secret-opening allowlist. internal/secrets.ts decides
 * which SecretKind rows the worker may ever ask the api to decrypt; a careless addition here would
 * hand the worker the console's own secrets (TOTP seeds, webhook secrets, historical env versions).
 * These assertions enumerate the live SecretKind enum, so adding a new kind fails this test until a
 * maintainer deliberately classifies it as worker-openable or api-only.
 */
import { describe, expect, it } from "vitest";
import { SecretKind } from "@dockify/db";
import { WORKER_OPEN_KINDS, WORKER_SEAL_KINDS } from "./secrets.ts";

const ALL_KINDS = Object.values(SecretKind) as string[];
const open = WORKER_OPEN_KINDS as ReadonlySet<string>;

/** Kinds that belong to the api alone and must never cross the control channel to the worker. */
const API_ONLY = ["totp", "env_version", "github_webhook_secret", "vercel_webhook_secret", "github_client_secret"];

describe("worker secret allowlist", () => {
  it("classifies every SecretKind as either worker-openable or api-only, with no overlap", () => {
    // A new enum value lands in neither set and trips this assertion by design.
    expect(new Set([...open, ...API_ONLY])).toEqual(new Set(ALL_KINDS));
    expect(open.size + API_ONLY.length).toBe(ALL_KINDS.length);
  });

  it("never lets the worker open the api-only kinds", () => {
    for (const k of API_ONLY) {
      expect(ALL_KINDS, `${k} is a real SecretKind`).toContain(k);
      expect(open.has(k), k).toBe(false);
    }
  });

  it("lists only real kinds as openable", () => {
    for (const k of open) expect(ALL_KINDS).toContain(k);
    expect([...open].sort()).toEqual(
      ["backup_key", "channel_secret", "channel_url", "database_password", "email_message", "env_snapshot", "env_var", "github_private_key", "integration_token", "storage_secret_key"],
    );
  });

  it("only ever seals kinds it is also allowed to open", () => {
    expect([...WORKER_SEAL_KINDS].sort()).toEqual(["backup_key", "env_snapshot"]);
    for (const k of WORKER_SEAL_KINDS) expect(open.has(k), k).toBe(true);
  });
});
