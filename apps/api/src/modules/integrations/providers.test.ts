import { describe, expect, it } from "vitest";
import type { HttpClient, HttpRequest, HttpResponse } from "@dockify/net-guard";
import { checkRegistry, parseChallenge, resolveHost } from "./registries.ts";
import { signV4 } from "./sigv4.ts";
import { bucketUrl, testS3 } from "./storage.ts";
import { importableDomains, importableEnv, normaliseTargets, VercelApi } from "./vercel.ts";

const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}): HttpResponse => ({
  status, headers, body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
});
const fake = (fn: (r: HttpRequest) => HttpResponse) => {
  const calls: HttpRequest[] = [];
  const http: HttpClient = async (r) => {
    calls.push(r);
    return fn(r);
  };
  return { http, calls };
};

describe("SigV4", () => {
  it("matches the AWS get-vanilla test vector", () => {
    const h = signV4({
      method: "GET", url: new URL("https://example.amazonaws.com/"), region: "us-east-1", service: "service",
      accessKey: "AKIDEXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", now: new Date("2015-08-30T12:36:00Z"),
    });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });
});

describe("storage test", () => {
  const t = { endpoint: "https://abc.r2.cloudflarestorage.com", bucket: "backups", region: "auto", accessKey: "AK", secretKey: "SK" };
  it("lists one key path style", async () => {
    const { http, calls } = fake(() => res(200, "<ListBucketResult/>"));
    await testS3(http, t);
    expect(calls[0]?.url).toBe("https://abc.r2.cloudflarestorage.com/backups?list-type=2&max-keys=1");
    expect(calls[0]?.headers?.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\//);
  });
  it("names the failure", async () => {
    await expect(testS3(fake(() => res(403)).http, t)).rejects.toMatchObject({ code: "STORAGE_AUTH" });
    await expect(testS3(fake(() => res(404)).http, t)).rejects.toMatchObject({ code: "STORAGE_BUCKET" });
    await expect(testS3(fake(() => res(301)).http, t)).rejects.toMatchObject({ code: "STORAGE_REDIRECT" });
    await expect(testS3(fake(() => res(200)).http, { ...t, endpoint: "https://10.0.0.1" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
  it("keeps the endpoint path", () => {
    expect(bucketUrl("https://minio.example.com/s3/", "b").toString()).toBe("https://minio.example.com/s3/b");
  });
});

describe("registries", () => {
  it("defaults hosts and checks custom ones", () => {
    expect(resolveHost("ghcr", "ignored.example.com")).toBe("ghcr.io");
    expect(resolveHost("dockerhub", undefined)).toBe("docker.io");
    expect(resolveHost("custom", "Reg.Example.com")).toBe("reg.example.com");
    expect(() => resolveHost("custom", undefined)).toThrow(/host/);
    expect(() => resolveHost("custom", "registry.local")).toThrow(/public/);
  });
  it("parses a bearer challenge", () => {
    expect(parseChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="x"')).toEqual({ realm: "https://ghcr.io/token", service: "ghcr.io" });
    expect(parseChallenge("Basic realm=x")).toBeNull();
  });
  it("runs the v2 token handshake", async () => {
    const ok = fake((r) => (r.url.endsWith("/v2/") ? res(401, {}, { "www-authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"' }) : res(200, { token: "t" })));
    expect(await checkRegistry(ok.http, "docker.io", "me", "pat")).toEqual({ ok: true });
    expect(ok.calls[0]?.url).toBe("https://registry-1.docker.io/v2/");
    expect(ok.calls[1]?.url).toBe("https://auth.docker.io/token?service=registry.docker.io");
    const bad = fake((r) => (r.url.endsWith("/v2/") ? res(401, {}, { "www-authenticate": 'Bearer realm="https://ghcr.io/token"' }) : res(401)));
    expect(await checkRegistry(bad.http, "ghcr.io", "me", "nope")).toMatchObject({ ok: false, reason: "auth" });
  });
});

describe("vercel", () => {
  it("imports only readable, valid, chosen-target vars", () => {
    const envs = [
      { id: "1", key: "DATABASE_URL", target: normaliseTargets(["production"]), type: "encrypted" },
      { id: "2", key: "SECRET", target: normaliseTargets("production"), type: "sensitive" },
      { id: "3", key: "PREVIEW_ONLY", target: normaliseTargets(["preview"]), type: "plain" },
      { id: "4", key: "VERCEL_URL", target: normaliseTargets(["production"]), type: "system" },
      { id: "5", key: "bad-key", target: normaliseTargets(["production"]), type: "plain" },
      { id: "6", key: "DATABASE_URL", target: normaliseTargets(["production", "preview"]), type: "plain" },
    ];
    expect(importableEnv(envs, "production").map((e) => e.id)).toEqual(["1"]);
  });
  it("skips vercel.app and redirect domains", () => {
    expect(importableDomains([{ name: "Shop.com" }, { name: "x.vercel.app" }, { name: "www.shop.com", redirect: "shop.com" }])).toEqual(["shop.com"]);
  });
  it("adds the team to team-scoped calls only", async () => {
    const { http, calls } = fake(() => res(200, { projects: [], user: { username: "u" } }));
    const api = new VercelApi(http, "tok", "team_1");
    await api.projects();
    await api.account();
    expect(calls[0]?.url).toBe("https://api.vercel.com/v9/projects?limit=50&teamId=team_1");
    expect(calls[1]?.url).toBe("https://api.vercel.com/v2/user");
    expect(calls[0]?.headers?.Authorization).toBe("Bearer tok");
  });
  it("turns a refused token into a 400", async () => {
    await expect(new VercelApi(fake(() => res(403)).http, "t", null).account()).rejects.toMatchObject({ code: "VERCEL_TOKEN" });
  });
});
