import { loadKeyring, type Keyring } from "@dockify/crypto";
import type { Db } from "@dockify/db";
import type { ApiConfig } from "./config.ts";

/** A random-looking but fixed test key. Never a real secret. */
export const TEST_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 13 + 7) % 251)).toString("base64");

export const testRing = (): Keyring => loadKeyring({ DOCKIFY_MASTER_KEY: TEST_KEY } as NodeJS.ProcessEnv);

export const testConfig = (over: Partial<ApiConfig> = {}): ApiConfig => ({
  port: 0,
  bind: "127.0.0.1",
  publicUrl: new URL("https://dockify.test"),
  ingress: "cloudflare_tunnel",
  trustedProxies: [],
  logLevel: "silent",
  setupToken: undefined,
  serverIpv4: null,
  reservedHosts: [],
  tunnelTarget: null,
  cfTunnelId: null,
  internalPeers: [],
  ...over,
});

/** A database that fails the test the moment anything touches it. */
export const noDb = (): Db =>
  new Proxy({} as Db, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      throw new Error(`database touched in a test that must not reach it (${String(prop)})`);
    },
  });
