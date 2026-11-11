import { z } from "zod";
import { DisplayName, Email, Hostname, Iso, isTimeZone, NewPassword, Password, Role, Slug, TokenGrant, TokenScope, TotpCode, Uuid } from "./common.ts";

export const LoginBody = z.strictObject({ email: Email, password: Password });
export const LoginResponse = z.object({ next: z.enum(["done", "verify"]) });

/**
 * The second factor after a correct password: a code from the authenticator app, nothing else. A
 * lost authenticator is turned off by the server owner on the host (apps/api/src/admin.ts).
 */
export const VerifyBody = z.strictObject({
  code: TotpCode,
  remember: z.boolean().default(false),
});

/** `emailEnabled`: an email integration is set, so forgot password and email codes work. */
export const SetupStatus = z.object({ needsSetup: z.boolean(), instanceName: z.string().optional(), emailEnabled: z.boolean() });

/**
 * Forgot password, only while email is set. The answer is the same 202 whether or not the address
 * has an account, and the lookup runs after the answer, so neither the body nor the timing tells.
 */
export const ForgotBody = z.strictObject({ email: Email });
export const ResetToken = z.string().regex(/^[A-Za-z0-9_-]{20,200}$/);
export const ResetParams = z.strictObject({ token: ResetToken });
export const ResetPreview = z.object({ email: z.string(), expiresAt: Iso });
export const PasswordResetBody = z.strictObject({ password: NewPassword });

/**
 * 6 digits, hashed at rest, 10 minutes, 5 tries. With `email` the code goes to that new address and confirming
 * it moves the account (step-up required); without it, confirming marks the current address verified.
 */
export const EmailCodeBody = z.strictObject({ email: Email.optional() });
export const EmailCodeResponse = z.object({ email: z.string(), purpose: z.enum(["verify", "change"]), expiresAt: Iso });
export const EmailConfirmBody = z.strictObject({ code: TotpCode });
export const SetupBody = z.strictObject({
  instanceName: DisplayName,
  name: DisplayName,
  email: Email,
  password: NewPassword,
  /** Required only when the installer set DOCKIFY_SETUP_TOKEN, so a stranger cannot claim a fresh box. */
  setupToken: z.string().max(200).optional(),
});

export const InviteToken = z.string().regex(/^[A-Za-z0-9_-]{6,200}$/);
export const InviteParams = z.strictObject({ token: InviteToken });
export const InvitePreview = z.object({
  email: z.string(),
  role: z.string(),
  invitedBy: z.string(),
  instanceName: z.string(),
  expiresAt: Iso,
});
export const AcceptInviteBody = z.strictObject({ name: DisplayName, password: NewPassword });

/**
 * Step-up. With MFA on, a current TOTP code is required (the password alone never elevates);
 * without MFA the password is required. Opens a short window on this session only.
 */
export const StepUpBody = z.strictObject({ code: TotpCode.optional(), password: Password.optional() });
export const StepUpResponse = z.object({ expiresAt: Iso });

export const OkEmpty = z.object({});

export const TwoFactor = z.object({ enabled: z.boolean() });
export const Me = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: Role,
  avatarUrl: z.string().nullable(),
  twoFactor: TwoFactor,
  /** Confirmed by an emailed code. Always false on an instance without email. */
  emailVerified: z.boolean(),
  /** Lowercased; pushes whose head commit author is this login show as this user. */
  githubLogin: z.string().nullable(),
  /**
   * Nobody can prove a login is theirs here, so a viewer's link waits for an admin (team.change).
   * Until then pushes by it are not shown as this user and its deploy emails do not come here.
   */
  githubVerified: z.boolean(),
  /** IANA zone for dashboard times; null follows the browser. */
  timeZone: z.string().nullable(),
  hour12: z.boolean(),
  /** Which emails this user gets. `security` is always true for admins. */
  notify: z.object({ deployFailed: z.boolean(), security: z.boolean() }),
});
export type Me = z.infer<typeof Me>;

/** GitHub's username rules. Stored lowercased, since GitHub logins ignore case. */
export const GitHubLogin = z
  .string()
  .trim()
  .regex(/^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/, "Use a GitHub username: letters, digits and single hyphens, up to 39")
  .transform((v) => v.toLowerCase());
export const GitHubLoginBody = z.strictObject({ login: GitHubLogin.nullable() });

export const TimeZone = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_+\-/]+$/)
  .refine(isTimeZone, "Unknown time zone");
export const PreferencesBody = z
  .strictObject({
    timeZone: TimeZone.nullable().optional(),
    hour12: z.boolean().optional(),
    notify: z.strictObject({ deployFailed: z.boolean().optional(), security: z.boolean().optional() }).optional(),
  })
  .refine((b) => b.timeZone !== undefined || b.hour12 !== undefined || (b.notify && Object.keys(b.notify).length > 0), "Nothing to change");

const AvatarDataUrl = z
  .string()
  .max(300_000)
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/, "Use a PNG, JPEG or WebP image");
export const PatchMeBody = z.strictObject({ name: DisplayName.optional(), email: Email.optional(), avatar: AvatarDataUrl.nullable().optional() });
/** `code` is the emailed 6-digit code from me.password.code; required while email is on. */
export const ChangePasswordBody = z.strictObject({ current: Password, next: NewPassword, code: TotpCode.optional() });
/** Asks for a password change code: the current password is checked first, so a wrong one fails before any email. */
export const PasswordCodeBody = z.strictObject({ current: Password });
/** Where the code went, masked ("a***@example.com"), and until when it works. */
export const PasswordCodeResponse = z.object({ email: z.string(), expiresAt: Iso });

export const TotpSetup = z.object({ secret: z.string(), otpauthUrl: z.string(), qrDataUrl: z.string().nullable().optional() });
export const CodeBody = z.strictObject({ code: TotpCode });

export const SessionRow = z.object({
  id: z.string(),
  device: z.string(),
  kind: z.enum(["desktop", "mobile", "tablet", "unknown"]),
  ip: z.string(),
  location: z.string().nullable(),
  lastSeenAt: Iso,
  createdAt: Iso,
  current: z.boolean(),
});

export const TeamMember = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: Role,
  avatarUrl: z.string().nullable(),
  joinedAt: Iso,
  githubLogin: z.string().nullable(),
  githubVerified: z.boolean(),
});
export const InviteRole = z.enum(["admin", "viewer"]);
export const InviteEmailStatus = z.enum(["queued", "sent", "failed"]);
export const TeamInvite = z.object({
  id: z.string(), email: z.string(), role: InviteRole, createdAt: Iso, expiresAt: Iso,
  /** Null when no email was asked for. */
  emailStatus: InviteEmailStatus.nullable(),
  /** Why the send failed, with every address taken out. */
  emailError: z.string().nullable(),
});
export const Team = z.object({ members: z.array(TeamMember), invites: z.array(TeamInvite) });
export const TeamChangesBody = z.strictObject({
  changes: z
    .array(z.union([
      z.strictObject({ id: Uuid, role: Role }),
      z.strictObject({ id: Uuid, remove: z.literal(true) }),
      /** Approves (true) or withdraws (false) the member's linked GitHub login. */
      z.strictObject({ id: Uuid, githubVerified: z.boolean() }),
      /** Removes the member's linked GitHub login, verified or not. */
      z.strictObject({ id: Uuid, githubLogin: z.null() }),
    ]))
    .min(1)
    .max(50),
});
/** `send`: also email the link (only while email is set; the copy link is always returned). */
export const CreateInviteBody = z.strictObject({ email: Email, role: InviteRole, send: z.boolean().optional() });
export const CreateInviteResponse = z.object({ url: z.string(), invite: TeamInvite, emailed: z.boolean() });
export const IdParams = z.strictObject({ id: Uuid });

export const NotifyEvent = z.enum(["deployFailed", "appDown", "backupFailed", "tlsExpiring", "previewDeployments", "jobFailed"]);
export type NotifyEventName = z.infer<typeof NotifyEvent>;
/** Every event notifies until the owner turns it off. */
export const DEFAULT_NOTIFY: Record<NotifyEventName, boolean> = { deployFailed: true, appDown: true, backupFailed: true, tlsExpiring: true, previewDeployments: true, jobFailed: true };
/** The stored switches as a full set: anything missing or not a boolean reads as its default. */
export function notifyEvents(raw: unknown): Record<NotifyEventName, boolean> {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_NOTIFY };
  for (const k of NotifyEvent.options) if (typeof src[k] === "boolean") out[k] = src[k];
  return out;
}
export const InstanceSettings = z.object({
  instanceName: z.string(),
  publicUrl: z.string(),
  defaultBranch: z.string(),
  /** Stored, not applied: deploys run one at a time on the worker's deploy lane. */
  buildConcurrency: z.number().int(),
  /** Days the worker keeps runtime logs (its prune pass reads this); a build log stays with its deployment. */
  logRetentionDays: z.number().int(),
  notifications: z.object({ events: z.record(NotifyEvent, z.boolean()) }),
  /** Where previews answer: pr-<n>-<app>.<previewDomain>. Projects may override it. */
  previewDomain: z.string().nullable(),
  /** preview.<parent of the dashboard host>, used while previewDomain is not set by hand. */
  previewDomainDefault: z.string().nullable(),
  previewDomainCustom: z.boolean(),
  terminalEnabled: z.boolean(),
});
export const PatchSettingsBody = z.strictObject({
  instanceName: DisplayName.optional(),
  publicUrl: z.url({ protocol: /^https?$/ }).max(300).optional(),
  defaultBranch: z.string().regex(/^[A-Za-z0-9._/-]{1,100}$/).optional(),
  buildConcurrency: z.number().int().min(1).max(8).optional(),
  logRetentionDays: z.number().int().min(1).max(365).optional(),
  notifications: z.strictObject({ events: z.partialRecord(NotifyEvent, z.boolean()) }).optional(),
  /** null goes back to the derived default. */
  previewDomain: Hostname.nullable().optional(),
  terminalEnabled: z.boolean().optional(),
});

export const ApiTokenRow = z.object({
  id: z.string(),
  name: z.string(),
  scope: TokenScope,
  prefix: z.string(),
  createdAt: Iso,
  expiresAt: Iso.nullable(),
  lastUsedAt: Iso.nullable(),
  /** Chosen at creation: every project, or only the slugs listed. Never implied by an empty list. */
  allProjects: z.boolean(),
  projects: z.array(z.string()),
  grants: z.array(TokenGrant),
});
export const TokenProjects = z.union([z.literal("all"), z.array(Slug).min(1).max(50)]);
export const CreateTokenBody = z.strictObject({
  name: DisplayName,
  scope: TokenScope,
  expiresInDays: z.number().int().min(1).max(365).nullable(),
  /** Required: there is no default. A token reaches only the projects named here. */
  projects: TokenProjects,
  grants: z.array(TokenGrant).max(5).optional(),
});
export const CreateTokenResponse = z.object({ token: ApiTokenRow, secret: z.string() });
