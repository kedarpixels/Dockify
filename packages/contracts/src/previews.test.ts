import { describe, expect, it } from "vitest";
import { defaultPreviewDomain as sslipPreviewDefault } from "./projects.ts";

describe("the default preview domain of an install on its sslip.io name", () => {
  it("goes under the name itself, where sslip.io still answers with the address", () => {
    expect(sslipPreviewDefault("https://203-0-113-4.sslip.io")).toBe("preview.203-0-113-4.sslip.io");
    expect(sslipPreviewDefault("https://dash.example.com")).toBe("preview.example.com");
  });
});
import { CacheRequest } from "./link.ts";
import { defaultPreviewDomain, effectivePreviewDomain, isProductionEnvironment, PreviewSettings, PREVIEW_DEFAULTS, previewCeiling, previewIsolation, previewWildcard } from "./projects.ts";

describe("preview domain", () => {
  it("derives preview.<parent of the dashboard host>", () => {
    expect(defaultPreviewDomain("https://dash.example.com")).toBe("preview.example.com");
    expect(defaultPreviewDomain("https://dockify.ops.acme.io/")).toBe("preview.ops.acme.io");
    expect(defaultPreviewDomain("https://Example.com")).toBe("preview.example.com");
    expect(defaultPreviewDomain("https://203.0.113.7")).toBeNull();
    expect(defaultPreviewDomain("http://localhost:3000")).toBeNull();
    expect(defaultPreviewDomain("not a url")).toBeNull();
  });
  it("the project override wins, then the instance setting, then the derived default", () => {
    const url = "https://dash.example.com";
    expect(effectivePreviewDomain("preview.horseai.com", "preview.other.com", url)).toEqual({ domain: "preview.horseai.com", source: "project" });
    expect(effectivePreviewDomain(null, "preview.other.com", url)).toEqual({ domain: "preview.other.com", source: "instance" });
    expect(effectivePreviewDomain(null, null, url)).toEqual({ domain: "preview.example.com", source: "derived" });
    expect(previewWildcard("preview.example.com")).toBe("*.preview.example.com");
  });
});

describe("preview settings", () => {
  it("defaults to the cheap guardrails", () => {
    expect(PREVIEW_DEFAULTS).toMatchObject({ baseEnvironment: "development", maxConcurrent: 2, serverMaxConcurrent: 4, cpuLimit: 0.5, memoryMb: 512, pidsLimit: 128, idleMinutes: 30, ttlHours: 72, fromForks: false, isolatedDb: false });
    const ok = PreviewSettings.safeParse({ enabled: true, appIds: [], domain: null, ...PREVIEW_DEFAULTS });
    expect(ok.success).toBe(true);
    expect(PreviewSettings.safeParse({ enabled: true, appIds: [], domain: null, ...PREVIEW_DEFAULTS, maxConcurrent: 0 }).success).toBe(false);
  });
  it("estimates the resource ceiling", () => {
    expect(previewCeiling({ maxConcurrent: 2, cpuLimit: 0.5, memoryMb: 512, isolatedDb: false }, 1)).toEqual({ previews: 2, cpu: 1, memoryMb: 1024 });
    expect(previewCeiling({ maxConcurrent: 2, cpuLimit: 0.5, memoryMb: 512, isolatedDb: true }, 2)).toEqual({ previews: 2, cpu: 2, memoryMb: 2560 });
  });
});

describe("what a preview shares with production", () => {
  const of = (fromFork: boolean, name: string, envs: number, allowed: boolean) =>
    previewIsolation({ fromFork, baseEnvironment: { name }, project: { previewProductionAccess: allowed, environments: Array.from({ length: envs }) } });

  it("a production base takes the owner's explicit setting", () => {
    expect(of(false, "production", 2, false)).toBe("own");
    expect(of(false, "production", 2, true)).toBe("base");
  });
  it("the only environment counts as production, whatever it is called", () => {
    expect(of(false, "production", 1, false)).toBe("own");
    expect(of(false, "main", 1, false)).toBe("own");
    expect(of(false, "main", 1, true)).toBe("base");
  });
  it("a development base keeps its secrets and network, setting or not", () => {
    expect(of(false, "development", 2, false)).toBe("base");
    expect(of(false, "development", 2, true)).toBe("base");
    expect(of(false, "staging", 3, false)).toBe("base");
  });
  it("names that plainly mean production count", () => {
    expect(isProductionEnvironment("prod", 2)).toBe(true);
    expect(isProductionEnvironment("live", 2)).toBe(true);
  });
  it("a fork never gets them", () => {
    for (const [name, envs] of [["production", 2], ["development", 2], ["main", 1]] as const) {
      for (const allowed of [false, true]) expect(of(true, name, envs, allowed)).toBe("fork");
    }
  });
  it("the setting is off by default and a saved body must carry it", () => {
    expect(PREVIEW_DEFAULTS.productionAccess).toBe(false);
  });
  it("a scope to prune is one word, so it cannot add a filter of its own", () => {
    expect(CacheRequest.safeParse({ op: "pruneScope", scope: "dockify-preview-0f0f0f0f-0000-4000-8000-0000000000e1", timeoutMs: 1000 }).success).toBe(true);
    for (const scope of ["a,type==regular", "", ".*", "a b"]) expect(CacheRequest.safeParse({ op: "pruneScope", scope, timeoutMs: 1000 }).success, scope).toBe(false);
  });
});
