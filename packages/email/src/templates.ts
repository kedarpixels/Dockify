/**
 * The transactional templates. Each takes plain data and returns { subject, html, text }; none of
 * them reads a clock, the network or the environment, so the same input always renders the same
 * bytes (the preview fixture and its drift test rely on that).
 */
import { EmailInputError, maskEmail, oneLine, plural, utcTime } from "./html.ts";
import { render, whereText, type AppRef, type Brand, type EmailMessage, type FactRow, type Theme } from "./layout.ts";

export const CODE_MINUTES = 10;
export const RESET_MINUTES = 30;

const SIX_DIGITS = /^\d{6}$/;

function assertCode(code: string): string {
  if (!SIX_DIGITS.test(code)) throw new Error("A code in an email must be 6 digits");
  return code;
}

/** A place as the dashboard shows it, every name flattened to one clipped line; a plain string stays as it is. */
const placeOf = (where: AppRef | string): AppRef | string =>
  typeof where === "string"
    ? oneLine(where, 120)
    : {
        projectName: oneLine(where.projectName, 60),
        projectSlug: oneLine(where.projectSlug, 40),
        env: oneLine(where.env, 32),
        appName: oneLine(where.appName, 32),
        appKind: where.appKind,
        projectIcon: where.projectIcon ?? null,
        appIcon: where.appIcon ?? null,
      };

/** Where a request came from, as its own fact rows: the device and the IP address, each when known. */
const whereRows = (device?: string | null, ip?: string | null): FactRow[] => {
  const rows: FactRow[] = [];
  if (device) rows.push(["Device", oneLine(String(device), 80)]);
  if (ip) rows.push(["IP address", oneLine(String(ip), 80)]);
  return rows;
};

export interface CodeInput extends Brand {
  code: string;
  minutes?: number;
}

export function verifyEmail(input: CodeInput, theme: Theme = "auto"): EmailMessage {
  const code = assertCode(input.code);
  const minutes = input.minutes ?? CODE_MINUTES;
  return render(
    {
      subject: `${code} is your ${oneLine(input.instanceName, 60)} verification code`,
      preheader: `Enter this code to confirm your email. It expires in ${plural(minutes, "minute")}.`,
      heading: "Confirm your email",
      blocks: [
        { kind: "p", text: "Enter this code in Dockify to confirm that this address is yours." },
        { kind: "code", code, label: "Verification code" },
        { kind: "note", text: `The code expires in ${plural(minutes, "minute")} and works once.` },
      ],
      reason: "You are getting this because someone asked to verify this address on this Dockify server.",
      ignore: "If that was not you, ignore this email. Nothing changes until the code is entered.",
    },
    input,
    theme,
  );
}

/** A code sent to confirm something the account asked for, with where the request came from. */
export interface DeviceCodeInput extends CodeInput {
  /** "Chrome on macOS", from the user agent. */
  device?: string | null;
  ip?: string | null;
}

export function passwordChangeCode(input: DeviceCodeInput, theme: Theme = "auto"): EmailMessage {
  const code = assertCode(input.code);
  const minutes = input.minutes ?? CODE_MINUTES;
  const where = whereRows(input.device, input.ip);
  return render(
    {
      subject: `${code} is your ${oneLine(input.instanceName, 60)} password change code`,
      preheader: `Enter this code to confirm your new password. It expires in ${plural(minutes, "minute")}.`,
      heading: "Confirm your password change",
      blocks: [
        { kind: "p", text: "Enter this code in Dockify to finish changing your password. Never share it: Dockify will never ask you for it." },
        { kind: "code", code, label: "Password change code" },
        ...(where.length ? [{ kind: "facts" as const, rows: where }] : []),
        { kind: "note", text: `The code expires in ${plural(minutes, "minute")} and works once. Your password stays as it is until the code is entered.` },
      ],
      reason: "You are getting this because someone asked to change the password on your account.",
      ignore: "If that was not you, someone knows your password. Change it in Settings, Security, and turn on two-factor.",
    },
    input,
    theme,
  );
}

export interface PasswordResetInput extends Brand {
  url: string;
  minutes?: number;
  device?: string | null;
  ip?: string | null;
}

export function passwordReset(input: PasswordResetInput, theme: Theme = "auto"): EmailMessage {
  const minutes = input.minutes ?? RESET_MINUTES;
  const where = whereRows(input.device, input.ip);
  return render(
    {
      subject: `Reset your ${oneLine(input.instanceName, 60)} password`,
      preheader: `Choose a new password. The link expires in ${plural(minutes, "minute")}.`,
      heading: "Reset your password",
      blocks: [
        { kind: "p", text: `Someone asked to reset the password for your account on ${oneLine(input.instanceName, 60)}. Choose a new one with the button below.` },
        { kind: "button", label: "Choose a new password", url: input.url },
        ...(where.length ? [{ kind: "facts" as const, rows: where }] : []),
        { kind: "note", text: `The link expires in ${plural(minutes, "minute")} and works once. Resetting signs you out everywhere.` },
      ],
      reason: "You are getting this because a password reset was requested for this address.",
      ignore: "If you did not ask for this, ignore this email. Your password stays as it is.",
    },
    input,
    theme,
  );
}

export interface InviteInput extends Brand {
  invitedBy: string;
  role: string;
  url: string;
  /** Days the link stays valid. */
  days: number;
}

export function invite(input: InviteInput, theme: Theme = "auto"): EmailMessage {
  const by = oneLine(input.invitedBy, 80);
  const instance = oneLine(input.instanceName, 60);
  const raw = oneLine(input.role, 20);
  const role = raw.charAt(0).toUpperCase() + raw.slice(1);
  return render(
    {
      subject: `${by} invited you to ${instance} on Dockify`,
      preheader: `Join as ${role}. The invite expires in ${plural(input.days, "day")}.`,
      heading: `Join ${instance}`,
      blocks: [
        { kind: "p", text: `${by} invited you to the team that runs ${instance}, a Dockify server.` },
        { kind: "facts", rows: [["Role", role], ["Invited by", by], ["Expires", `In ${plural(input.days, "day")}`]] },
        { kind: "button", label: "Accept invite", url: input.url },
        { kind: "note", text: "The link works once. You choose your name and password when you accept." },
      ],
      reason: "You are getting this because a team member entered this address in an invite.",
      ignore: "If you were not expecting it, ignore this email. Nothing happens until the link is used.",
    },
    input,
    theme,
  );
}

export interface EmailChangedInput extends Brand {
  /** The new address. Shown masked. */
  newEmail: string;
  at: Date;
  device?: string | null;
  ip?: string | null;
}

export function emailChanged(input: EmailChangedInput, theme: Theme = "auto"): EmailMessage {
  const where = whereRows(input.device, input.ip);
  return render(
    {
      subject: `The email on your ${oneLine(input.instanceName, 60)} account changed`,
      preheader: "Your sign-in email is now a different address.",
      heading: "Your email was changed",
      tone: "warning",
      blocks: [
        { kind: "p", text: "The email address you sign in with was changed. This address no longer receives account email." },
        {
          kind: "facts",
          rows: [["New address", maskEmail(input.newEmail)], ["When", utcTime(input.at)], ...where],
        },
        { kind: "note", text: "If you made this change, you can ignore this email." },
      ],
      reason: "You are getting this because this address was on the account until now.",
      ignore: "If you did not make this change, ask whoever runs this server to reset your account, then turn on two-factor.",
    },
    input,
    theme,
  );
}

export type SecurityEvent = "signIn" | "password" | "passwordReset" | "mfaOn" | "mfaOff";

export interface SecurityNoticeInput extends Brand {
  event: SecurityEvent;
  at: Date;
  device?: string | null;
  ip?: string | null;
  /** Settings, Security on this dashboard. */
  url: string;
}

const SECURITY: Record<SecurityEvent, { subject: string; heading: string; lead: string }> = {
  signIn: { subject: "New sign-in to your", heading: "New sign-in", lead: "Someone signed in to your account from a device it has not used recently." },
  password: { subject: "Your password changed on your", heading: "Your password was changed", lead: "The password for your account was changed. Other sessions were signed out. API tokens keep working: if this was not you, revoke them in Settings, API tokens." },
  passwordReset: { subject: "Your password was reset on your", heading: "Your password was reset", lead: "The password for your account was reset. Every session was signed out and your API tokens were revoked, so make new ones for anything that used them." },
  mfaOn: { subject: "Two-factor sign-in is on for your", heading: "Two-factor sign-in turned on", lead: "Signing in now also asks for a code from your authenticator app." },
  mfaOff: { subject: "Two-factor sign-in is off for your", heading: "Two-factor sign-in turned off", lead: "Signing in now asks only for your password. Other sessions were signed out." },
};

/** A sign-in from a new device, or a password or two-factor change, sent to the account itself. */
export function securityNotice(input: SecurityNoticeInput, theme: Theme = "auto"): EmailMessage {
  const t = SECURITY[input.event];
  const where = whereRows(input.device, input.ip);
  return render(
    {
      subject: `${t.subject} ${oneLine(input.instanceName, 60)} account`,
      preheader: t.lead,
      heading: t.heading,
      tone: "warning",
      blocks: [
        { kind: "p", text: t.lead },
        { kind: "facts", rows: [["When", utcTime(input.at)], ...where] },
        { kind: "button", label: "Review sessions", url: input.url },
      ],
      reason: "You are getting this because it is about your account on this server.",
      ignore: "If this was you, you can ignore this email. If not, change your password and sign out every other session.",
    },
    input,
    theme,
  );
}

export interface DeployFailedInput extends Brand {
  /** The app whose deploy failed: project, environment and app, with their icons when they have one. */
  where: AppRef;
  /** One line, already redacted by the caller. */
  error: string;
  /** Short commit, branch or both, when known. */
  source: string | null;
  /** True when the source repository is on GitHub, so its row shows the GitHub mark. */
  github?: boolean;
  at: Date;
  url: string;
}

/** A deploy the reader started failed. */
export function deployFailed(input: DeployFailedInput, theme: Theme = "auto"): EmailMessage {
  const where = placeOf(input.where);
  const rows: FactRow[] = [["App", where]];
  if (input.source) rows.push(["Source", oneLine(input.source, 120), input.github ? "github" : "source"]);
  rows.push(["Why", oneLine(input.error, 300)], ["Failed", utcTime(input.at)]);
  return render(
    {
      subject: `Deploy failed: ${whereText(where)}`,
      preheader: oneLine(input.error, 140),
      heading: "Your deploy failed",
      tone: "critical",
      blocks: [
        { kind: "p", text: "A deploy you started did not go live. Whatever was serving before still serves." },
        { kind: "facts", rows },
        { kind: "button", label: "Open the deployment", url: input.url },
      ],
      reason: "You are getting this because you started this deploy.",
      ignore: "To stop these, turn off Deploys I started that fail in Settings, Preferences.",
    },
    input,
    theme,
  );
}

export interface PreviewNoticeInput extends Brand {
  state: "ready" | "failed";
  /** "acme/web". */
  repo: string;
  prNumber: number;
  /** The pull request's title. A stranger may have written it: the caller strips links from it. */
  title: string;
  branch: string;
  commit: string | null;
  /** The GitHub login of the pull request's author, when known. */
  author: string | null;
  fromFork: boolean;
  /** True when the preview runs on its own temporary database. */
  isolatedDb: boolean;
  /** What it shares with its base environment: both its secrets and network, or neither. */
  isolation: "base" | "own" | "fork";
  baseEnvironment: string;
  /** Its public address: live when ready, the build still serving when failed, or null. */
  previewUrl: string | null;
  dashboardUrl: string;
  /** One line, redacted and stripped of links by the caller. */
  reason: string | null;
  /** The last build lines, redacted and stripped of links by the caller. */
  lines: readonly string[];
  /** Why this reader got it: they opened the pull request, or they are an admin and its author is not a member. */
  recipient: "author" | "admin";
}

const PREVIEW_LOG_LINES = 12;

/** A preview is ready, or failed. Sent once per state change, never per push. */
export function previewNotice(input: PreviewNoticeInput, theme: Theme = "auto"): EmailMessage {
  const ready = input.state === "ready";
  const pr = `${oneLine(input.repo, 120)} #${input.prNumber}`;
  const prTitle = oneLine(input.title, 120);
  const rows: FactRow[] = [["Pull request", `${pr} ${prTitle}`, "github"], ["Branch", oneLine(input.branch, 120), "source"]];
  if (input.commit) rows.push(["Commit", oneLine(input.commit, 40).slice(0, 7), "commit"]);
  if (input.author) rows.push(["Author", oneLine(input.author, 60), "user"]);
  rows.push(["Status", ready ? "Ready" : "Failed", "status"]);
  rows.push(["Database", input.isolatedDb ? "Its own temporary database, separate from your real data" : input.isolation === "base" ? `The ${oneLine(input.baseEnvironment, 32)} environment's services` : "None", "database"]);
  if (input.isolation === "own") rows.push(["Production", "No secrets or services, so an app that needs them fails here"]);
  if (input.fromFork) rows.push(["Fork", "Built from a fork, without any secret", "source"]);
  const lines = input.lines.slice(-PREVIEW_LOG_LINES).map((l) => oneLine(l, 240)).filter(Boolean);
  if (!ready && input.reason) rows.push(["Why", oneLine(input.reason, 300)]);
  const lead = ready ? "The preview for this pull request is live." : "The preview for this pull request did not build.";
  return render(
    {
      subject: `Preview ${ready ? "ready" : "failed"}: ${pr} ${prTitle}`,
      preheader: ready ? `${pr} is live.` : oneLine(input.reason ?? "See the deploy log.", 140),
      heading: ready ? "Preview ready" : "Preview failed",
      tone: ready ? "success" : "critical",
      blocks: [
        { kind: "p", text: lead },
        { kind: "facts", rows },
        ...(!ready && lines.length ? [{ kind: "log" as const, label: "Last build lines", lines }] : []),
        ...(ready && input.previewUrl
          ? [{ kind: "button" as const, label: "Open preview", url: input.previewUrl }, { kind: "link" as const, label: "Open in Dockify", url: input.dashboardUrl }]
          : [{ kind: "button" as const, label: "Open in Dockify", url: input.dashboardUrl }, ...(input.previewUrl ? [{ kind: "link" as const, label: "Open the build still serving", url: input.previewUrl }] : [])]),
      ],
      reason: input.recipient === "author" ? "You are getting this because you opened this pull request." : "You are getting this because you are an admin of this Dockify server and the pull request's author is not a member.",
      ignore: "An admin can turn these off in Settings, Notifications, Events.",
    },
    input,
    theme,
  );
}

export type AlertKind = "appDown" | "deployFailed" | "backupFailed" | "tlsExpiring" | "jobFailed" | "alert";

export interface AlertInput extends Brand {
  kind: AlertKind;
  state: "firing" | "resolved";
  /** "App down". */
  title: string;
  /** One line, already redacted by the caller. */
  detail: string;
  /** The app the alert is about, or for a host or service alert a plain place ("host", "service proxy"). */
  where: AppRef | string;
  at: Date;
  url: string;
  /** What sent it: an alert rule (the default), or an event switched on in Settings, Notifications. */
  source?: "rule" | "event";
}

const ALERT_LEAD: Record<AlertKind, string> = {
  appDown: "An app stopped answering its health check.",
  deployFailed: "A deployment failed. The previous version is still serving.",
  backupFailed: "A backup did not finish. The last good backup is unchanged.",
  alert: "An alert rule fired.",
  tlsExpiring: "A certificate is close to expiring, and renewal has not replaced it.",
  jobFailed: "A scheduled job failed. The app itself keeps serving, and the next run goes ahead as planned.",
};

export function alert(input: AlertInput, theme: Theme = "auto"): EmailMessage {
  const title = oneLine(input.title, 80);
  const where = placeOf(input.where);
  const resolved = input.state === "resolved";
  const fromEvent = input.source === "event";
  return render(
    {
      subject: `${resolved ? "Resolved: " : fromEvent ? "" : "Firing: "}${title}, ${whereText(where)}`,
      preheader: oneLine(input.detail, 140),
      heading: resolved ? `Resolved: ${title}` : title,
      tone: resolved ? "success" : "critical",
      blocks: [
        { kind: "p", text: resolved ? "This alert is no longer firing." : ALERT_LEAD[input.kind] },
        { kind: "facts", rows: [["Where", where], ["What", oneLine(input.detail, 300)], [resolved ? "Resolved" : "Started", utcTime(input.at)]] },
        { kind: "button", label: fromEvent ? "Open in Dockify" : "Open alerts", url: input.url },
      ],
      reason: fromEvent ? "You are getting this because you are an admin and this event is on in Settings, Notifications." : "You are getting this because email is a channel on an alert rule on this server.",
      ignore: fromEvent ? "To stop these, turn the event off there." : "To stop these, change the rule’s channels in Alerts, or mute the app.",
    },
    input,
    theme,
  );
}

export interface TestEmailInput extends Brand {
  /** Who pressed Send test email. */
  sentBy: string;
  /** "Dockify <alerts@example.com>". */
  from: string;
}

export function testEmail(input: TestEmailInput, theme: Theme = "auto"): EmailMessage {
  return render(
    {
      subject: `Test email from ${oneLine(input.instanceName, 60)}`,
      preheader: "Email from this Dockify server works.",
      heading: "Email works",
      tone: "success",
      blocks: [
        { kind: "p", text: "This is a test from Settings, Integrations. Invites, password resets, codes and alerts will arrive like this one." },
        { kind: "facts", rows: [["Sent by", oneLine(input.sentBy, 80)], ["From", oneLine(input.from, 160)]] },
        { kind: "note", text: "If this landed in spam, check that your sending domain is verified with your mail provider." },
      ],
      reason: "You are getting this because someone pressed Send test email.",
      ignore: null,
    },
    input,
    theme,
  );
}

/** A security release's block from the signed release feed, as the security notice shows it. */
export interface SecurityReleaseInfo {
  level: "critical" | "important";
  /** Plain text: what the fix closes. */
  summary: string;
  /** The advisory, an https URL. */
  advisory?: string | null;
  cves?: readonly string[];
}

export interface UpdateNoticeInput extends Brand {
  /** "security": a newly seen security release, sent to every admin once. */
  event: "available" | "updated" | "failed" | "rolled_back" | "security";
  /** The release the event is about. */
  version: string;
  /** The version that was running before; for "security", the version this server runs. */
  from: string | null;
  /** One line, for failures. */
  error: string | null;
  /** The Server page of this dashboard. */
  url: string;
  /** For "security": the release's signed security block. */
  security?: SecurityReleaseInfo | null;
}

type UpdateEvent = Exclude<UpdateNoticeInput["event"], "security">;

const UPDATE_SUBJECT: Record<UpdateEvent, (i: UpdateNoticeInput) => string> = {
  available: (i) => `Update available: Dockify v${oneLine(i.version, 40)}`,
  updated: (i) => `Updated to Dockify v${oneLine(i.version, 40)}`,
  failed: (i) => `Update to Dockify v${oneLine(i.version, 40)} failed`,
  rolled_back: (i) => `Update failed, rolled back to ${i.from ? `v${oneLine(i.from, 40)}` : "the previous version"}`,
};
const UPDATE_LEAD: Record<UpdateEvent, string> = {
  available: "A new signed Dockify release is available for this server.",
  updated: "Dockify updated itself. It backed up its own database first, and every health check passed.",
  failed: "A Dockify update failed and could not roll back on its own. Your apps keep running; check the Server page.",
  rolled_back: "A Dockify update failed, so Dockify rolled back on its own to the previous version and its database.",
};

const SEVERITY: Record<SecurityReleaseInfo["level"], { name: string; urge: string }> = {
  critical: { name: "Critical", urge: "It is rated critical: update this server as soon as you can." },
  important: { name: "Important", urge: "It is rated important: update this server soon." },
};

/**
 * The security variant: the red tile, the release's own summary, the advisory as a secondary link,
 * the severity, versions and CVE ids as facts, and one button to the Server page, where Update now
 * runs the usual signed update.
 */
function securityReleaseNotice(input: UpdateNoticeInput, theme: Theme): EmailMessage {
  const s = input.security;
  if (!s || !SEVERITY[s.level]) throw new EmailInputError("A security release email needs the release's security block");
  const level = SEVERITY[s.level];
  const version = `v${oneLine(input.version, 40)}`;
  const lead = `Dockify ${version} fixes a security issue. ${level.urge}`;
  const rows: FactRow[] = [["Severity", level.name, "why"], ["Version", version]];
  if (input.from) rows.push(["This server runs", `v${oneLine(input.from, 40)}`, "version"]);
  const cves = (s.cves ?? []).map((c) => oneLine(c, 32)).filter(Boolean).slice(0, 20);
  if (cves.length) rows.push([cves.length === 1 ? "CVE" : "CVEs", cves.join(", "), "role"]);
  return render(
    {
      subject: `Important security release: Dockify ${version}, ${oneLine(input.instanceName, 60)}`,
      preheader: lead,
      heading: "Important security release",
      tone: "critical",
      blocks: [
        { kind: "p", text: lead },
        { kind: "p", text: oneLine(s.summary, 600) },
        ...(s.advisory ? [{ kind: "link" as const, label: "Read the advisory", url: s.advisory }] : []),
        { kind: "facts", rows },
        { kind: "button", label: "Update on the Server page", url: input.url },
        { kind: "note", text: "Updating backs up Dockify’s own database first and rolls back on its own if a step fails." },
      ],
      reason: "You are getting this because you are an admin of this Dockify server. Each security release is emailed once.",
      ignore: "The button opens this server’s own dashboard. Dockify never asks for a password or a code by email.",
    },
    input,
    theme,
  );
}

/** Self-update notices: available, updated, failed, rolled back, and a security release. */
export function updateNotice(input: UpdateNoticeInput, theme: Theme = "auto"): EmailMessage {
  if (input.event === "security") return securityReleaseNotice(input, theme);
  const rows: FactRow[] = [["Version", `v${oneLine(input.version, 40)}`]];
  if (input.from) rows.push(["Before", `v${oneLine(input.from, 40)}`]);
  if (input.error) rows.push(["Why", oneLine(input.error, 300)]);
  return render(
    {
      subject: `${UPDATE_SUBJECT[input.event](input)}, ${oneLine(input.instanceName, 60)}`,
      preheader: UPDATE_LEAD[input.event],
      heading: UPDATE_SUBJECT[input.event](input),
      tone: input.event === "failed" ? "critical" : input.event === "rolled_back" ? "warning" : input.event === "updated" ? "success" : "info",
      blocks: [
        { kind: "p", text: UPDATE_LEAD[input.event] },
        { kind: "facts", rows },
        { kind: "button", label: "Open the Server page", url: input.url },
      ],
      reason: "You are getting this because you are an admin of this Dockify server.",
      ignore: "Update emails follow the policy in Settings, Updates. With manual updates you still get an email when a release is available.",
    },
    input,
    theme,
  );
}
