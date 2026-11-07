/**
 * Fixed sample data for every template: the dashboard's "Preview emails" dialog and the preview
 * script render these. Deterministic on purpose (no clock, no randomness), so a rendered preview
 * only changes when a template does.
 */
import type { AppRef, EmailMessage, Theme } from "./layout.ts";
import { alert, deployFailed, emailChanged, invite, passwordChangeCode, passwordReset, previewNotice, securityNotice, testEmail, updateNotice, verifyEmail } from "./templates.ts";

/** Every email Dockify actually sends, in the order the preview dialog lists them. */
export const TEMPLATE_NAMES = ["verify-email", "password-reset", "password-change-code", "invite", "email-changed", "security-notice", "alert", "deploy-failed", "preview-ready", "preview-failed", "update-notice", "test-email"] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export const TEMPLATE_LABELS: Record<TemplateName, string> = {
  "verify-email": "Verify email",
  "password-reset": "Password reset",
  "password-change-code": "Password change code",
  invite: "Team invite",
  "email-changed": "Email changed",
  "security-notice": "Security notice",
  alert: "Alert",
  "deploy-failed": "Deploy failed",
  "preview-ready": "Preview ready",
  "preview-failed": "Preview failed",
  "update-notice": "Update",
  "test-email": "Test email",
};

/**
 * Variants of a template that the preview script writes beside the list above, for review. They
 * stay out of TEMPLATE_NAMES, which the api's preview endpoint and the contract mirror.
 */
export const SAMPLE_VARIANTS = ["update-notice-security"] as const;
export type SampleVariant = (typeof SAMPLE_VARIANTS)[number];

export const VARIANT_LABELS: Record<SampleVariant, string> = {
  "update-notice-security": "Update, security release",
};

const AT = new Date("2026-10-30T14:05:00Z");
const URL_BASE = "https://dockify.example.com";

/** The sample place: a project with its own uploaded icon (the sample avatar) and a frontend on its kind tile. */
const horseai = (origin: string): AppRef => ({
  projectName: "horseai", projectSlug: "horseai", env: "production", appName: "web", appKind: "frontend", projectIcon: `${origin}/dk-sample-avatar.png`, appIcon: null,
});

const PREVIEW_SAMPLE = { repo: "horseai/web", prNumber: 42, title: "Fix the header on mobile", branch: "fix/header", commit: "4f2a9c1", author: "lena", fromFork: false, isolatedDb: true, isolation: "base" as const, baseEnvironment: "production", recipient: "author" } as const;

/** Renders one template, or one variant, with sample data, for the given instance name and origin. */
export function renderSample(name: TemplateName | SampleVariant, theme: Theme, instanceName = "Acme Cloud", origin = URL_BASE): EmailMessage {
  const brand = { instanceName, origin };
  switch (name) {
    case "update-notice-security":
      // Sample text only; the zeros in the CVE id mark it as a placeholder, never a real advisory.
      return updateNotice(
        {
          ...brand,
          event: "security",
          version: "1.4.1",
          from: "1.4.0",
          error: null,
          url: `${origin}/server#updates`,
          security: {
            level: "critical",
            summary: "A crafted log viewer request could read files outside the log folder. Every install from 1.2.0 to 1.4.0 is affected.",
            advisory: "https://example.com/dockify/security/advisories/1.4.1",
            cves: ["CVE-2026-0000"],
          },
        },
        theme,
      );
    case "verify-email":
      return verifyEmail({ ...brand, code: "482913" }, theme);
    case "password-reset":
      return passwordReset({ ...brand, url: `${origin}/reset/sample-token`, device: "Safari on iOS", ip: "198.51.100.24" }, theme);
    case "password-change-code":
      return passwordChangeCode({ ...brand, code: "615048", device: "Edge on Windows", ip: "203.0.113.9" }, theme);
    case "invite":
      return invite({ ...brand, invitedBy: "Suvak", role: "admin", url: `${origin}/invite/sample-token`, days: 7 }, theme);
    case "email-changed":
      return emailChanged({ ...brand, newEmail: "lena@example.com", at: AT, device: "Firefox on Windows", ip: "203.0.113.9" }, theme);
    case "security-notice":
      return securityNotice({ ...brand, event: "signIn", at: AT, device: "Firefox on Windows", ip: "203.0.113.9", url: `${origin}/settings?section=security` }, theme);
    case "deploy-failed":
      return deployFailed(
        {
          ...brand,
          where: horseai(origin),
          error: "build failed: npm run build exited with code 1",
          source: "main, 4f2a9c1",
          github: true,
          at: AT,
          url: `${origin}/deployments/sample`,
        },
        theme,
      );
    case "preview-ready":
      return previewNotice({ ...brand, ...PREVIEW_SAMPLE, state: "ready", previewUrl: "https://pr-42-web.preview.example.com", dashboardUrl: `${origin}/projects/horseai?tab=previews`, reason: null, lines: [] }, theme);
    case "preview-failed":
      return previewNotice(
        {
          ...brand,
          ...PREVIEW_SAMPLE,
          state: "failed",
          previewUrl: null,
          dashboardUrl: `${origin}/projects/horseai?tab=previews`,
          reason: "The build failed (buildctl exit 1)",
          lines: ["#9 12.40 npm error Missing script: \"build\"", "#9 ERROR: process \"/bin/sh -c npm run build\" did not complete successfully: exit code: 1", "ERROR: failed to solve: process \"/bin/sh -c npm run build\" did not complete successfully: exit code: 1"],
        },
        theme,
      );
    case "alert":
      return alert(
        {
          ...brand,
          kind: "appDown",
          state: "firing",
          title: "App down",
          detail: "web failed 3 health checks in a row (GET /healthz timed out after 5s)",
          where: horseai(origin),
          at: AT,
          url: `${origin}/alerts`,
        },
        theme,
      );
    case "update-notice":
      return updateNotice({ ...brand, event: "updated", version: "1.4.0", from: "1.3.2", error: null, url: `${origin}/server` }, theme);
    case "test-email":
      return testEmail({ ...brand, sentBy: "Suvak", from: "Dockify <dockify@mail.example.com>" }, theme);
  }
}

