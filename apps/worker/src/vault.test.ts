/**
 * The worker holds no master key. Three checks: the source tree never
 * loads a keyring, the production compose mounts no key into the worker, and the remote vault
 * sends exactly the row ids it needs with the running job attached, over the internal token.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKeyring, open } from "@dockify/crypto";
import { describe, expect, it } from "vitest";
import { createRemoteVault, jobContext, readApiUrl, readInternalToken, VaultError } from "./vault.ts";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const COMPOSE = new URL("../../../deploy/docker-compose.yml", import.meta.url);
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 251)).toString("base64");

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sources(p)));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("the worker holds no master key", () => {
  it("never loads a keyring or reads DOCKIFY_MASTER_KEY, and never seals or opens with crypto directly", async () => {
    for (const file of await sources(SRC)) {
      const text = await readFile(file, "utf8");
      expect(text, file).not.toMatch(/loadKeyring|DOCKIFY_MASTER_KEY|\bKeyring\b/);
      // seal/open are the keyring primitives; the worker only ever goes through a SecretVault.
      expect(text, file).not.toMatch(/import \{[^}]*\b(seal|open|rewrap)\b[^}]*\} from "@dockify\/crypto"/);
    }
  });

  it("gets no master key from the production compose file, and the api gets the pinned peer", async () => {
    const compose = await readFile(COMPOSE, "utf8");
    const service = (name: string) => new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}\\S|^\\S)`, "m").exec(compose)?.[1] ?? "";
    const worker = service("worker");
    expect(worker).toBeTruthy();
    expect(worker).not.toMatch(/master_key|MASTER_KEY/);
    expect(worker).toContain("DOCKIFY_API_INTERNAL_URL: http://172.30.2.10:3001");
    expect(worker).toContain("DOCKIFY_INTERNAL_TOKEN_FILE");
    const api = service("api");
    expect(api).toContain("DOCKIFY_MASTER_KEY_FILE: /run/secrets/master_key");
    expect(api).toContain("DOCKIFY_INTERNAL_PEERS: 172.30.2.20");
    expect(service("updater")).not.toMatch(/master_key/);
    expect(service("web")).not.toMatch(/master_key/);
  });

  it("refuses to start without the internal token or the api address", () => {
    expect(() => readInternalToken({} as NodeJS.ProcessEnv)).toThrow(/DOCKIFY_INTERNAL_TOKEN/);
    expect(readInternalToken({ DOCKIFY_INTERNAL_TOKEN: "t" } as NodeJS.ProcessEnv)).toBe("t");
    expect(() => readApiUrl({} as NodeJS.ProcessEnv)).toThrow(/DOCKIFY_API_INTERNAL_URL/);
    expect(() => readApiUrl({ DOCKIFY_API_INTERNAL_URL: "ftp://api" } as NodeJS.ProcessEnv)).toThrow(/http/);
    expect(readApiUrl({ DOCKIFY_API_INTERNAL_URL: "http://api:3001/" } as NodeJS.ProcessEnv)).toBe("http://api:3001");
  });
});

describe("remote vault", () => {
  const ring = loadKeyring({ DOCKIFY_MASTER_KEY: KEY } as NodeJS.ProcessEnv);
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const fakeFetch = (answer: (path: string, body: Record<string, unknown>) => { status: number; json: unknown }): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(url), init: init ?? {}, body });
      const a = answer(new URL(String(url)).pathname, body);
      return new Response(JSON.stringify(a.json), { status: a.status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

  it("names the rows, attaches the running job, and sends the internal token as a bearer", async () => {
    calls.length = 0;
    const vault = createRemoteVault({ apiUrl: "http://api:3001", token: "tok", fetch: fakeFetch(() => ({ status: 200, json: { values: { a: "x", b: null } } })) });
    const values = await jobContext.run({ jobId: "job-1", purpose: "deploy" }, () => vault.open({} as never, ["a", "b", "a"]));
    expect(values).toEqual(new Map([["a", "x"], ["b", null]]));
    expect(calls[0]?.url).toBe("http://api:3001/internal/secrets/open");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(calls[0]?.init.redirect).toBe("error");
    expect(calls[0]?.body).toEqual({ ids: ["a", "b", "a"], context: { jobId: "job-1", purpose: "deploy" } });
  });

  it("says 'worker' when no job or timer context is set, and passes a timer context through", async () => {
    calls.length = 0;
    const vault = createRemoteVault({ apiUrl: "http://api:3001", token: "tok", fetch: fakeFetch(() => ({ status: 200, json: { values: {} } })) });
    await vault.open({} as never, ["a"]);
    expect(calls[0]?.body.context).toEqual({ jobId: null, purpose: "worker" });
    await jobContext.run({ jobId: null, purpose: "timer:observe" }, () => vault.open({} as never, ["a"]));
    expect(calls[1]?.body.context).toEqual({ jobId: null, purpose: "timer:observe" });
  });

  it("decodes what the api sealed into the same Sealed shape the api can open", async () => {
    const wire = { kekId: ring.active, wrappedDek: "AA==", dekNonce: "AQ==", ciphertext: "Ag==", ctNonce: "Aw==" };
    const vault = createRemoteVault({ apiUrl: "http://api:3001", token: "tok", fetch: fakeFetch(() => ({ status: 200, json: wire })) });
    const s = await vault.seal({ id: "r1", kind: "env_snapshot", ownerType: "deployment", ownerId: "d1" }, "{}");
    expect(s.kekId).toBe(ring.active);
    expect([...s.wrappedDek]).toEqual([0]);
    expect([...s.ctNonce]).toEqual([3]);
    expect(() => open(ring, { id: "r1", kind: "env_snapshot", scope: "deployment:d1" }, s)).toThrow();
  });

  it("returns the escrow text and surfaces the api's refusal with its code", async () => {
    const vault = createRemoteVault({
      apiUrl: "http://api:3001", token: "tok",
      fetch: fakeFetch((path) => (path.endsWith("/escrow") ? { status: 200, json: { text: "{\"format\":\"dockify-backup-key\"}" } } : { status: 403, json: { error: "no", code: "SECRET_KIND_REFUSED" } })),
    });
    expect(await vault.escrow({} as never, "b1")).toContain("dockify-backup-key");
    const e = await vault.open({} as never, ["t1"]).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(VaultError);
    expect((e as VaultError).code).toBe("SECRET_KIND_REFUSED");
    expect((e as VaultError).status).toBe(403);
  });

  it("maps an unreachable api to a retryable error", async () => {
    const vault = createRemoteVault({ apiUrl: "http://api:3001", token: "tok", fetch: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch });
    const e = await vault.open({} as never, ["a"]).catch((x: unknown) => x);
    expect((e as VaultError).code).toBe("VAULT_UNREACHABLE");
  });
});
