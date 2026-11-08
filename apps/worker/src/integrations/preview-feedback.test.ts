import type { Db, SecretVault } from "@dockify/db";
import type { HttpClient } from "@dockify/net-guard";
import { describe, expect, it, vi } from "vitest";
import { commentFor, firstCommentNow, type FeedbackView, runPreviewFeedback, statusFor } from "./preview-feedback.ts";

vi.mock("../deploy/github.ts", () => ({ installationCredential: async () => ({ secret: "ghs_token" }) }));

const base: FeedbackView = {
  prNumber: 42,
  status: "failed",
  reason: null,
  error: null,
  lines: [],
  updatedAt: new Date("2026-11-06T14:05:00Z"),
  fromFork: true,
  isolatedDb: true,
  isolation: "fork",
  baseEnvironment: "production",
  apps: [{ name: "web", url: null }],
  dashboardUrl: "https://dockify.test/previews/42",
  idleMinutes: 30,
  ttlHours: 72,
};

// A PR author controls the build error (HEALTHCHECK output, buildctl stderr). It is rendered under
// the Dockify App's identity, so it must not be able to forge a link, an @mention or HTML.
const EVIL = "fail `](http://evil.tld) @maintainer <img src=x onerror=alert(1)> ![x](y)";

describe("preview feedback neutralises tenant-controlled error text", () => {
  it("fences the error and its lines with no linkifying, mention or breakout characters (comment)", () => {
    const body = commentFor({ ...base, status: "failed", error: EVIL, lines: [EVIL, "```", "</details>", "see www.evil.tld/x"] });
    const open = body.indexOf("```text\n");
    const close = body.indexOf("\n```\n", open);
    expect(open).toBeGreaterThan(0);
    const block = body.slice(open + 8, close);
    expect(block).not.toContain("](");
    expect(block).not.toContain("@maintainer");
    expect(block).not.toContain("<img");
    expect(block).not.toContain("</details");
    expect(block).not.toContain("http://evil.tld");
    expect(block).not.toContain("www.evil.tld");
    // The fence is balanced: the only backticks are the two fences, none from the payload.
    expect((body.slice(open).match(/```/g) ?? []).length).toBe(2);
    expect(block).not.toContain("`");
  });

  it("names the base environment only in a project with several", () => {
    const shared = { ...base, status: "ready" as const, fromFork: false, isolatedDb: false, isolation: "base" as const };
    expect(commentFor({ ...shared, baseEnvironment: "development" })).toContain("Uses the development environment's services.");
    expect(commentFor({ ...shared, baseEnvironment: "" })).toContain("Uses the project's services.");
    expect(commentFor({ ...shared, baseEnvironment: "" })).not.toContain("environment's");
  });

  it("sanitizes the app name in its row", () => {
    const body = commentFor({ ...base, status: "ready", apps: [{ name: "a|[x](y)@z", url: "https://a.example.com" }, { name: "b", url: null }] });
    expect(body).toContain("| ax(y)z | 🟢 [Ready](https://dockify.test/previews/42) | [Preview](https://a.example.com) |");
    expect(body).toContain("| b | 🟢 [Ready](https://dockify.test/previews/42) | No public URL |");
  });

  it("strips links and mentions from the commit status description (plain text)", () => {
    const s = statusFor({ ...base, status: "failed", error: EVIL });
    expect(s.state).toBe("failure");
    expect(s.description).not.toContain("http://evil.tld");
    expect(s.description).not.toContain("@maintainer");
    expect(s.description).not.toContain("](");
    expect(s.description.length).toBeLessThanOrEqual(140);
  });

  it("keeps a normal error readable, parentheses and all", () => {
    const body = commentFor({ ...base, status: "failed", error: "npm exited (code 1)." });
    expect(body).toContain("npm exited (code 1).");
    expect(statusFor({ ...base, status: "failed", error: "npm exited (code 1)." }).description).toBe("Failed: npm exited (code 1).");
  });

  it("never says buildctl, in the comment or the status", () => {
    const failed = { ...base, status: "failed" as const, error: "The build failed (buildctl exit 1)." };
    expect(commentFor(failed)).not.toContain("buildctl");
    expect(statusFor(failed).description).toBe("Failed: Build failed.");
  });
});

describe("the comment reads like a deploy bot's", () => {
  it("is one line and one table, with no image and no repeated status", () => {
    const body = commentFor({ ...base, status: "ready", fromFork: false, isolation: "base", apps: [{ name: "web", url: "https://pr-42-web.preview.example.com" }] });
    expect(body).toContain("The latest preview of this pull request.\n\n| Project | Deployment | Actions | Updated (UTC) |\n| :--- | :--- | :--- | :--- |\n| web | 🟢 [Ready](https://dockify.test/previews/42) | [Preview](https://pr-42-web.preview.example.com) | 6 Nov 2026, 14:05 |");
    expect(body).not.toContain("<details");
    expect(body).not.toContain("<img");
    expect(body).not.toContain("Open in Dockify");
    expect(body.match(/Ready/g)).toHaveLength(1);
    expect(commentFor({ ...base, status: "building" }).match(/Building/g)).toHaveLength(1);
  });

  it("says why a preview was removed, and nothing else about one that is gone", () => {
    const body = commentFor({ ...base, status: "closed", reason: "disabled" });
    expect(body).toContain("| web | ⚪ [Removed](https://dockify.test/previews/42) |  | 6 Nov 2026, 14:05 |");
    expect(body.endsWith("Removed: previews were turned off for this project.")).toBe(true);
    expect(body).not.toContain("database");
    expect(body).not.toContain("fork");
  });

  it("shows a row's icon beside its name, and only the name with none", () => {
    const body = commentFor({ ...base, status: "ready", apps: [{ name: "web", url: null, icon: "https://d.example.com/api/icons/mail/t" }, { name: "api", url: null }] });
    expect(body).toContain('| <img src="https://d.example.com/api/icons/mail/t" alt="" width="16" height="16"> web | 🟢');
    expect(body).toContain("| api | 🟢");
  });

  it("works with no dashboard link and no apps left", () => {
    expect(commentFor({ ...base, status: "closed", dashboardUrl: null, apps: [] })).toContain("| pr-42 | ⚪ Removed |  |");
  });

  it("keeps a name in the table from breaking it", () => {
    const body = commentFor({ ...base, status: "ready", apps: [{ name: "a|b", url: "https://a.example.com" }] });
    expect(body).toContain("| ab | 🟢");
  });

  it("posts the first comment only once there is a result", () => {
    expect(["building", "asleep", "closing", "closed"].filter((s) => firstCommentNow(s as never))).toEqual([]);
    expect(["ready", "failed", "blocked"].every((s) => firstCommentNow(s as never))).toBe(true);
  });

  it("names the Dockerfile line and keeps only the useful lines of the seen failure", () => {
    const lines = ["Dockerfile:9", "7 |     EXPOSE 3000", '8 |     CMD ["node", "server.js"]', '9 |  RUN echo "simulated compile error" && exit 1', "10 |", 'error: failed to solve: process "/bin/sh -c echo \\"simulated compile error\\" && exit 1" did not complete successfully: exit code: 1'];
    const body = commentFor({ ...base, status: "failed", error: "The build failed (buildctl exit 1). Its last lines:", lines });
    expect(body).toContain("Build failed at Dockerfile line 9.\n\n```text\n7 |     EXPOSE 3000\n8 |     CMD");
    expect(body).toContain('exit 1\nThe command exited with code 1\n```');
    expect(body).not.toContain("buildctl");
    expect(body).not.toContain("failed to solve");
    expect(body).not.toContain("Dockerfile:9");
    expect(body).not.toContain("10 |");
  });

  it("uses the new database wording", () => {
    expect(commentFor({ ...base, status: "building" })).toContain("Uses its own temporary database, separate from your real data.");
  });

  it("quotes the build's last lines in a fence, after one sentence", () => {
    const body = commentFor({ ...base, status: "failed", error: "The build failed (buildctl exit 1).", lines: ["#9 npm error Missing script", "exit code: 1"] });
    expect(body).toContain("| web | 🔴 [Failed](https://dockify.test/previews/42) |  |");
    expect(body).toContain("Build failed.\n\n```text\n#9 npm error Missing script\nexit code: 1\n```");
    expect(body).not.toContain("Its last lines");
  });

  it("caps the quoted lines to the last few", () => {
    const body = commentFor({ ...base, status: "failed", error: "x", lines: Array.from({ length: 40 }, (_, i) => `line ${i}`) });
    expect(body).toContain("line 39");
    expect(body).not.toContain("line 27\n");
  });

  it("marks a link that opens the older build while one fails", () => {
    expect(commentFor({ ...base, status: "failed", error: "x", apps: [{ name: "web", url: "https://a.example.com" }] })).toContain("[Previous build](https://a.example.com)");
  });
});

describe("runPreviewFeedback carries the build's last lines to the comment (seen live: none after 'Its last lines:')", () => {
  it("reads them from the failed deployment, and links nothing when nothing serves", async () => {
    const posted: string[] = [];
    const env = {
      prNumber: 42, status: "failed", reason: null, error: "The build failed (buildctl exit 1).", commitSha: "a".repeat(40), fromFork: false, isolatedDb: false, repo: "acme/web", commentId: null,
      updatedAt: new Date("2026-11-06T14:05:00Z"), baseEnvironment: { name: "production" },
      project: { id: "p", iconChoice: "auto", icons: [], slug: "acme", previewIdleMinutes: 30, previewTtlHours: 72, previewProductionAccess: false, environments: [{ id: "only", name: "production", apps: [] }], gitInstallation: { installationId: 7 } },
      apps: [{
        hostname: "pr-42-web.preview.example.com", currentDeploymentId: null, app: { id: "a", iconChoice: "auto", icons: [], name: "web", port: 3000, gitInstallation: null },
        deployments: [{ status: "failed", error: 'The build failed (buildctl exit 1). Its last lines:\n#9 npm error Missing script: "build"\nERROR: exit code: 1' }],
      }],
    };
    const db = { previewEnv: { findUnique: async () => env, update: async () => env } };
    const http = (async (r: { url: string; body?: string }) => {
      if (r.url.endsWith("/comments")) posted.push((JSON.parse(r.body ?? "{}") as { body: string }).body);
      return { status: 201, headers: {}, body: Buffer.from('{"id":1}') };
    }) as unknown as HttpClient;
    await runPreviewFeedback({ db: db as unknown as Db, vault: {} as SecretVault, http, apiBase: "https://api.github.com", publicUrl: "https://d.example.com" }, { previewId: "p1" });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('Build failed.\n\n```text\n#9 npm error Missing script: "build"\nERROR: exit code: 1\n');
    expect(posted[0]).not.toContain("Its last lines");
    expect(posted[0]).not.toContain("pr-42-web.preview.example.com");
    expect(posted[0]).toContain("🔴 [Failed](https://d.example.com/projects/acme?tab=previews)");
    // No icon of its own: the row falls back to the Dockify mark.
    expect(posted[0]).toContain('<img src="https://d.example.com/dockify-github-app-logo.png" alt="" width="16" height="16"> web');
  });
});

describe("a renamed app in the comment", () => {
  const run = async (displayName: string | null) => {
    const posted: string[] = [];
    const env = {
      prNumber: 42, status: "ready", reason: null, error: null, commitSha: "a".repeat(40), fromFork: false, isolatedDb: false, repo: "acme/web", commentId: null,
      updatedAt: new Date("2026-11-06T14:05:00Z"), baseEnvironment: { name: "production" },
      project: { id: "p", iconChoice: "auto", icons: [], slug: "acme", previewIdleMinutes: 30, previewTtlHours: 72, previewProductionAccess: false, environments: [{ id: "only", name: "production", apps: [] }], gitInstallation: { installationId: 7 } },
      apps: [{
        hostname: "pr-42-web.preview.example.com", currentDeploymentId: "d1", app: { id: "a", iconChoice: "auto", icons: [], name: "web", displayName, port: 3000, gitInstallation: null },
        deployments: [{ status: "ready", error: null }],
      }],
    };
    const db = { previewEnv: { findUnique: async () => env, update: async () => env } };
    const http = (async (r: { url: string; body?: string }) => {
      if (r.url.endsWith("/comments")) posted.push((JSON.parse(r.body ?? "{}") as { body: string }).body);
      return { status: 201, headers: {}, body: Buffer.from('{"id":1}') };
    }) as unknown as HttpClient;
    await runPreviewFeedback({ db: db as unknown as Db, vault: {} as SecretVault, http, apiBase: "https://api.github.com", publicUrl: "https://d.example.com" }, { previewId: "p1" });
    return posted[0]!;
  };

  it("names its row by the display name, while its preview address keeps the app's name", async () => {
    const body = await run("Storefront");
    expect(body).toContain('width="16" height="16"> Storefront |');
    expect(body).toContain("https://pr-42-web.preview.example.com");
    expect(body).not.toContain("> web |");
  });

  it("keeps a display name out of link, mention, HTML and table syntax", async () => {
    const body = await run("Shop | [x](https://evil.example) @team <b>");
    const row = body.split("\n").find((l) => l.includes("Shop"))!;
    expect(row).not.toContain("https://evil.example");
    expect(row).not.toMatch(/@team|<b>|\[x\]/);
    expect(row.split("|")).toHaveLength(6);
  });
});
