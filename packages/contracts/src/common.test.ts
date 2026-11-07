import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AppStatus, DisplayName, EmptyBody, isReservedSlug, isSafeText, NewPassword, RESERVED_SLUGS, RepoUrl, SafeLabel, UNSAFE_TEXT_MESSAGE } from "./common.ts";
import { NewProjectBody } from "./projects.ts";

describe("the repository URL rule the web carries", () => {
  // apps/web is not a workspace member, so New app holds its own copy of this one regular expression.
  it("is the same text in apps/web, and takes https only", () => {
    const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
    const rule = /\.regex\((\/\^https:[^\n]*\/i), "Use an https repository URL"\)/.exec(read("./common.ts"))?.[1];
    const copy = /REPO_URL = (\/\^https:[^\n]*\/i);/.exec(read("../../../apps/web/components/new-app/spec.ts"))?.[1];
    expect(rule).toBeTruthy();
    expect(copy).toBe(rule);
    expect(RepoUrl.safeParse("https://github.com/owner/repo").success).toBe(true);
    expect(RepoUrl.safeParse("https://github.com/owner/repo.git").success).toBe(true);
    for (const bad of ["git@github.com:owner/repo", "git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo", "http://github.com/owner/repo"]) {
      expect(RepoUrl.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("the password policy", () => {
  it("takes 12 characters and refuses 11", () => {
    const short = NewPassword.safeParse("a".repeat(11));
    expect(short.success).toBe(false);
    expect(short.error?.issues[0]?.message).toBe("Use at least 12 characters");
    expect(NewPassword.safeParse("a".repeat(12)).success).toBe(true);
    expect(NewPassword.safeParse("a".repeat(257)).success).toBe(false);
  });
});

describe("reserved project slugs", () => {
  it("reserves new, the web's New project address", () => {
    expect(RESERVED_SLUGS).toContain("new");
    expect(isReservedSlug("new")).toBe(true);
    expect(isReservedSlug(" NEW ")).toBe(true);
    expect(isReservedSlug("newer")).toBe(false);
  });

  it("refuses a project named new", () => {
    const body = (name: string) => ({ repoUrl: "", name, defaultBranch: "main", environments: ["production"] });
    const refused = NewProjectBody.safeParse(body("New"));
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toBe("That name is reserved");
    expect(NewProjectBody.safeParse(body("shop")).success).toBe(true);
  });
});

describe("names: one visible line", () => {
  const ch = (code: number) => String.fromCharCode(code);
  it("refuses controls, direction marks and overrides, and invisible characters", () => {
    for (const code of [0x00, 0x0a, 0x1f, 0x7f, 0x9f, 0x061c, 0x180e, 0x200b, 0x200f, 0x2029, 0x202e, 0x2060, 0x2069, 0xfeff]) {
      expect(isSafeText(`a${ch(code)}b`), code.toString(16)).toBe(false);
      expect(DisplayName.safeParse(`a${ch(code)}b`).error?.issues[0]?.message, code.toString(16)).toBe(UNSAFE_TEXT_MESSAGE);
    }
  });
  it("keeps letters of every script, punctuation and emoji, and labels keep their own length", () => {
    for (const s of ["Acme", "Café Zürich", "東京", "A & B, Ltd.", "Rocket 🚀"]) expect(isSafeText(s), s).toBe(true);
    expect(SafeLabel(60, 1).safeParse("").success).toBe(false);
    expect(SafeLabel(60, 1).safeParse("x".repeat(61)).success).toBe(false);
    expect(SafeLabel(60, 1).safeParse(" API ").data).toBe("API");
  });
});

describe("app status: what the daemon reports", () => {
  it("names every state the worker's observe pass writes, the old values first", () => {
    expect(AppStatus.options).toEqual(["running", "stopped", "deploying", "degraded", "unknown", "restarting", "exited", "missing", "failed"]);
  });
});

describe("EmptyBody", () => {
  it("takes every way a request can have no body, and nothing else", () => {
    // Fastify hands over null for a POST with no content: every Recheck was a 400 on it.
    for (const none of [undefined, null, {}]) expect(EmptyBody.safeParse(none).success, String(none)).toBe(true);
    for (const some of [{ a: 1 }, [], "x", 0]) expect(EmptyBody.safeParse(some).success, JSON.stringify(some)).toBe(false);
  });
});
