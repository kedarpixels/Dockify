"use server";

import {
  apiCall,
  buildPreviewSettings,
  dataSource,
  seededString,
  type ApiToken,
  type InstanceSettings,
  type Invite,
  type Me,
  type NotifyEvent,
  type Outcome,
  type Session,
  type SettingsData,
  type TokenGrant,
  type TokenScope,
  type TotpSetup,
} from "@/lib/pages/activity-settings";
import type { SettingsPatch } from "@/components/activity-settings/settings-patch";
import { newPasswordProblem } from "@/lib/password";
import { previewElevated } from "@/lib/preview-step-up";
import { stepUpRefusal } from "@/lib/step-up";
import { TIME_ZONE_RE } from "@/lib/time-zones";
import { BRANCH_NAME, isRecord } from "@/lib/validation";

// A server action is a public endpoint: check every input's shape and forward only the checked fields.
// Never log here: passwords, codes and secrets pass through.

const NONE: Outcome<never> = { ok: false, error: "No data source, set DOCKIFY_API_URL for this dashboard" };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE = /^\d{6}$/;
const AVATAR = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
const TEAM_ROLES = ["admin", "viewer"] as const;
const SCOPES: TokenScope[] = ["read", "deploy", "admin"];
const EXPIRY_DAYS = [7, 30, 90, 365];
const EVENTS: NotifyEvent[] = ["deployFailed", "appDown", "backupFailed", "tlsExpiring", "previewDeployments", "jobFailed"];

export type TeamRole = (typeof TEAM_ROLES)[number];

const bad = (error: string): Outcome<never> => ({ ok: false, error });
const done = <T,>(data: T): Outcome<T> => ({ ok: true, data });
/** The preview's answer to an elevated write: the API's step-up refusal outside the preview's window, else null. */
const previewStepUp = (): Outcome<never> | null => (previewElevated() ? null : stepUpRefusal());

const str = (v: unknown, max = 500): v is string => typeof v === "string" && v.length <= max;
/** A record id: a short non-empty string, so it can never empty a path segment. */
const isId = (v: unknown): v is string => str(v, 200) && v.trim().length > 0;
const isTeamRole = (v: unknown): v is TeamRole => TEAM_ROLES.includes(v as TeamRole);
/** A zone name this runtime knows, so the API is never sent one it would refuse. */
const isTimeZone = (v: string) => {
  if (!TIME_ZONE_RE.test(v)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v });
    return true;
  } catch {
    return false;
  }
};

export async function updateProfile(input: { name: string; email: string; avatar?: string | null }): Promise<Outcome<Me>> {
  if (!isRecord(input) || !str(input.name, 80) || !str(input.email, 200)) return bad("Name or email is not valid");
  const name = input.name.trim();
  const email = input.email.trim();
  if (!name) return bad("Name cannot be empty");
  if (!EMAIL.test(email)) return bad("Enter a valid email address");
  const avatar = input.avatar;
  if (avatar !== undefined && avatar !== null && (!str(avatar, 1_400_000) || !AVATAR.test(avatar))) return bad("Picture must be a PNG, JPG, WebP or GIF image under 1 MB");

  const source = dataSource();
  if (source === "api") return apiCall<Me>("PATCH", "/api/v1/me", { name, email, ...(avatar !== undefined ? { avatar } : {}) });
  if (source === "preview") {
    const me = buildPreviewSettings(new Date()).me;
    // A change of address is elevated on the API.
    if (email.toLowerCase() !== me.email.toLowerCase()) {
      const refused = previewStepUp();
      if (refused) return refused;
    }
    return done({ ...me, name, email, avatarUrl: avatar === undefined ? me.avatarUrl : avatar });
  }
  return NONE;
}

export type PreferencesPatch = { timeZone?: string | null; hour12?: boolean; notify?: { deployFailed?: boolean; security?: boolean } };

/** Only the keys present change. */
export async function updatePreferences(input: PreferencesPatch): Promise<Outcome<Me>> {
  if (!isRecord(input)) return bad("Nothing to save");
  const body: PreferencesPatch = {};
  if (input.timeZone !== undefined) {
    if (input.timeZone !== null && (typeof input.timeZone !== "string" || !isTimeZone(input.timeZone))) return bad("Pick a time zone from the list");
    body.timeZone = input.timeZone;
  }
  if (input.hour12 !== undefined) {
    if (typeof input.hour12 !== "boolean") return bad("Pick a clock");
    body.hour12 = input.hour12;
  }
  if (input.notify !== undefined) {
    if (!isRecord(input.notify)) return bad("Email choices are not valid");
    const notify: NonNullable<PreferencesPatch["notify"]> = {};
    for (const k of ["deployFailed", "security"] as const) {
      const v = input.notify[k];
      if (v === undefined) continue;
      if (typeof v !== "boolean") return bad("Email choices are not valid");
      notify[k] = v;
    }
    if (Object.keys(notify).length) body.notify = notify;
  }
  if (!Object.keys(body).length) return bad("Nothing to save");

  const source = dataSource();
  if (source === "api") return apiCall<Me>("PATCH", "/api/v1/me/preferences", body);
  if (source === "preview") {
    const me = buildPreviewSettings(new Date()).me;
    return done({
      ...me,
      timeZone: body.timeZone === undefined ? me.timeZone : body.timeZone,
      hour12: body.hour12 ?? me.hour12,
      notify: { deployFailed: body.notify?.deployFailed ?? me.notify.deployFailed, security: me.role === "admin" ? true : (body.notify?.security ?? me.notify.security) },
    });
  }
  return NONE;
}

export type EmailCodeSent = { email: string; purpose: "verify" | "change"; expiresAt: string };

/** Sends a 6-digit code: to `email` when it is a new address (a change), else to the current one. */
export async function sendEmailCode(input: { email?: string }): Promise<Outcome<EmailCodeSent>> {
  if (!isRecord(input)) return bad("Enter a valid email address");
  let email: string | undefined;
  if (input.email !== undefined) {
    if (!str(input.email, 200) || !EMAIL.test(input.email.trim())) return bad("Enter a valid email address");
    email = input.email.trim().toLowerCase();
  }
  const source = dataSource();
  if (source === "api") return apiCall<EmailCodeSent>("POST", "/api/v1/me/email/code", email ? { email } : {});
  if (source === "preview") {
    const me = buildPreviewSettings(new Date()).me;
    const change = email !== undefined && email !== me.email;
    // Sending a code to a new address is elevated on the API.
    if (change) {
      const refused = previewStepUp();
      if (refused) return refused;
    }
    return done({ email: change ? email! : me.email, purpose: change ? "change" : "verify", expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
  }
  return NONE;
}

/** Confirms the latest code. Preview: 123456 passes, and a change moves the account to `email`. */
export async function confirmEmailCode(code: string, email?: string): Promise<Outcome<Me>> {
  if (!str(code) || !CODE.test(code)) return bad("Enter all 6 digits");
  const source = dataSource();
  if (source === "api") return apiCall<Me>("POST", "/api/v1/me/email/confirm", { code });
  if (source === "preview") {
    if (code !== "123456") return bad("That code did not match. In the preview, use 123456");
    const me = buildPreviewSettings(new Date()).me;
    return done({ ...me, email: str(email, 200) && EMAIL.test(email) ? email.trim().toLowerCase() : me.email, emailVerified: true });
  }
  return NONE;
}

export type PasswordCodeSent = { email: string; expiresAt: string };

/** Step one of a password change while email is on: the API checks the current password, then mails a code. */
export async function requestPasswordCode(input: { current: string }): Promise<Outcome<PasswordCodeSent>> {
  if (!isRecord(input) || !str(input.current, 1024) || !input.current) return bad("Enter your current password");
  const source = dataSource();
  if (source === "api") return apiCall<PasswordCodeSent>("POST", "/api/v1/me/password/code", { current: input.current });
  if (source === "preview") {
    const [user, domain] = buildPreviewSettings(new Date()).me.email.split("@");
    return done({ email: `${user!.charAt(0)}***@${domain}`, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
  }
  return NONE;
}

/** `code` is the emailed code from requestPasswordCode; the API needs it while email is on. Preview: 123456. */
export async function changePassword(input: { current: string; next: string; code?: string }): Promise<Outcome> {
  if (!isRecord(input) || !str(input.current, 1024) || !str(input.next, 1024)) return bad("Password is not valid");
  if (!input.current) return bad("Enter your current password");
  const weak = newPasswordProblem(input.next);
  if (weak) return bad(weak);
  if (input.code !== undefined && (!str(input.code) || !CODE.test(input.code))) return bad("Enter all 6 digits");
  const source = dataSource();
  if (source === "api") return apiCall("POST", "/api/v1/me/password", { current: input.current, next: input.next, ...(input.code ? { code: input.code } : {}) });
  if (source === "preview") return input.code === undefined || input.code === "123456" ? done(null) : bad("That code did not match. In the preview, use 123456");
  return NONE;
}

export async function setupTwoFactor(): Promise<Outcome<TotpSetup>> {
  const source = dataSource();
  if (source === "api") return apiCall<TotpSetup>("POST", "/api/v1/me/2fa/setup");
  if (source === "preview") {
    const refused = previewStepUp();
    if (refused) return refused;
    const me = buildPreviewSettings(new Date()).me;
    const secret = seededString(`${me.id}:totp`, 32);
    return done({ secret, otpauthUrl: `otpauth://totp/Dockify:${encodeURIComponent(me.email)}?secret=${secret}&issuer=Dockify`, qrDataUrl: null });
  }
  return NONE;
}

/** Turns two-factor on with a first code from the app. The API holds the pending secret. */
export async function verifyTwoFactor(code: string): Promise<Outcome> {
  if (!str(code) || !CODE.test(code)) return bad("Enter all 6 digits");
  const source = dataSource();
  if (source === "api") return apiCall("POST", "/api/v1/me/2fa/verify", { code });
  if (source === "preview") return previewStepUp() ?? done(null);
  return NONE;
}

export async function disableTwoFactor(code: string): Promise<Outcome> {
  if (!str(code) || !CODE.test(code)) return bad("Enter all 6 digits");
  const source = dataSource();
  if (source === "api") return apiCall("POST", "/api/v1/me/2fa/disable", { code });
  if (source === "preview") return done(null);
  return NONE;
}

export async function revokeSession(id: string): Promise<Outcome> {
  if (!isId(id)) return bad("Unknown session");
  const source = dataSource();
  if (source === "api") return apiCall("DELETE", `/api/v1/me/sessions/${encodeURIComponent(id)}`);
  if (source === "preview") return done(null);
  return NONE;
}

export async function revokeOtherSessions(): Promise<Outcome> {
  const source = dataSource();
  if (source === "api") return apiCall("DELETE", "/api/v1/me/sessions");
  if (source === "preview") return done(null);
  return NONE;
}

/* Other writes change these lists: a password change ends the other sessions, a removed member's tokens
   go with the member. Each answers null in the preview, which stores nothing. */

async function readList<T>(path: string): Promise<Outcome<T | null>> {
  const source = dataSource();
  if (source === "api") return apiCall<T>("GET", path);
  if (source === "preview") return done(null);
  return NONE;
}

export async function readSessions(): Promise<Outcome<Session[] | null>> {
  return readList<Session[]>("/api/v1/me/sessions");
}

export async function readTeam(): Promise<Outcome<SettingsData["team"] | null>> {
  return readList<SettingsData["team"]>("/api/v1/team");
}

export async function readTokens(): Promise<Outcome<ApiToken[] | null>> {
  return readList<ApiToken[]>("/api/v1/tokens");
}

/** `githubVerified` approves (true) or withdraws (false) a member's GitHub login; `githubLogin: null` removes it. */
export type TeamChange =
  | { id: string; role: TeamRole }
  | { id: string; remove: true }
  | { id: string; githubVerified: boolean }
  | { id: string; githubLogin: null };

export async function saveTeam(changes: TeamChange[]): Promise<Outcome<SettingsData["team"]>> {
  if (!Array.isArray(changes) || changes.length > 500) return bad("Nothing to save");
  const clean: TeamChange[] = [];
  for (const c of changes as unknown[]) {
    if (!isRecord(c) || !isId(c.id)) return bad("Unknown member");
    if (c.remove === true) clean.push({ id: c.id, remove: true });
    else if (typeof c.githubVerified === "boolean") clean.push({ id: c.id, githubVerified: c.githubVerified });
    else if (c.githubLogin === null) clean.push({ id: c.id, githubLogin: null });
    else if (isTeamRole(c.role)) clean.push({ id: c.id, role: c.role });
    else return bad("Unknown role");
  }
  const source = dataSource();
  if (source === "api") return apiCall<SettingsData["team"]>("POST", "/api/v1/team", { changes: clean });
  if (source === "preview") {
    const refused = previewStepUp();
    if (refused) return refused;
    const team = buildPreviewSettings(new Date()).team;
    const members = team.members
      .filter((m) => !clean.some((c) => c.id === m.id && "remove" in c))
      .map((m) => {
        const c = clean.find((x) => x.id === m.id);
        if (c && "role" in c) return { ...m, role: c.role };
        if (c && "githubVerified" in c && m.githubLogin) return { ...m, githubVerified: c.githubVerified };
        if (c && "githubLogin" in c) return { ...m, githubLogin: null, githubVerified: false };
        return m;
      });
    return done({ ...team, members });
  }
  return NONE;
}

export async function createInvite(input: { email: string; role: TeamRole; send?: boolean }): Promise<Outcome<{ url: string; invite: Invite; emailed: boolean }>> {
  if (!isRecord(input) || !str(input.email, 200)) return bad("Enter a valid email address");
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) return bad("Enter a valid email address");
  if (!isTeamRole(input.role)) return bad("Unknown role");
  const role = input.role;
  const send = input.send === true;
  const source = dataSource();
  if (source === "api") {
    const r = await apiCall<{ url: string; invite: Invite; emailed?: boolean }>("POST", "/api/v1/team/invites", { email, role, ...(send ? { send } : {}) });
    return r.ok ? done({ ...r.data, emailed: r.data.emailed === true }) : r;
  }
  if (source === "preview") {
    const refused = previewStepUp();
    if (refused) return refused;
    const s = buildPreviewSettings(new Date());
    const now = Date.now();
    const token = seededString(`${email}:${now}`, 24, "abcdefghijkmnpqrstuvwxyz23456789");
    return done({
      url: `${s.settings.publicUrl}/invite/${token}`,
      invite: { id: `inv_${token.slice(0, 6)}`, email, role, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 7 * 86_400_000).toISOString() },
      emailed: send,
    });
  }
  return NONE;
}

export async function revokeInvite(id: string): Promise<Outcome> {
  if (!isId(id)) return bad("Unknown invite");
  const source = dataSource();
  if (source === "api") return apiCall("DELETE", `/api/v1/team/invites/${encodeURIComponent(id)}`);
  if (source === "preview") return done(null);
  return NONE;
}

const PREVIEW_HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const int = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** The patch rebuilt from checked fields only, or the first problem found. A field that was not sent stays unsent. */
function cleanPatch(s: unknown): SettingsPatch | string {
  if (!isRecord(s)) return "Settings are not valid";
  const { instanceName, defaultBranch, logRetentionDays, previewDomain, terminalEnabled, notifications } = s;
  const out: SettingsPatch = {};
  if (instanceName !== undefined) {
    if (!str(instanceName, 60) || !instanceName.trim()) return "Instance name cannot be empty";
    out.instanceName = instanceName.trim();
  }
  if (defaultBranch !== undefined) {
    if (!str(defaultBranch, 200) || !BRANCH_NAME.test(defaultBranch)) return "Use a branch name like main";
    out.defaultBranch = defaultBranch;
  }
  if (logRetentionDays !== undefined) {
    if (!int(logRetentionDays, 1, 365)) return "Log retention must be 1 to 365 days";
    out.logRetentionDays = logRetentionDays;
  }
  if (previewDomain !== undefined) {
    // null goes back to the derived default (preview.<parent of the dashboard host>).
    if (previewDomain !== null && (!str(previewDomain, 253) || !PREVIEW_HOST.test(previewDomain))) return "Use a preview domain like preview.example.com";
    out.previewDomain = previewDomain;
  }
  if (terminalEnabled !== undefined) {
    if (typeof terminalEnabled !== "boolean") return "Settings are not valid";
    out.terminalEnabled = terminalEnabled;
  }
  if (notifications !== undefined) {
    if (!isRecord(notifications) || !isRecord(notifications.events)) return "Notification events are not valid";
    const events: Partial<Record<NotifyEvent, boolean>> = {};
    for (const e of EVENTS) {
      const v = notifications.events[e];
      if (v === undefined) continue;
      if (typeof v !== "boolean") return "Notification events are not valid";
      events[e] = v;
    }
    out.notifications = { events };
  }
  return out;
}

/** Saves only the fields one section changed, so another admin's newer values stay put. Answers null in the preview. */
export async function saveSettings(patch: SettingsPatch): Promise<Outcome<InstanceSettings | null>> {
  const clean = cleanPatch(patch);
  if (typeof clean === "string") return bad(clean);
  const source = dataSource();
  if (source === "api") return apiCall<InstanceSettings>("PATCH", "/api/v1/settings", clean);
  if (source === "preview") return previewStepUp() ?? done(null);
  return NONE;
}

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

export async function createToken(input: {
  name: string;
  scope: TokenScope;
  expiresInDays: number | null;
  /** Required: "all" chosen deliberately, or at least one project slug. There is no default. */
  projects: "all" | string[];
  grants?: TokenGrant[];
}): Promise<Outcome<{ token: ApiToken; secret: string }>> {
  if (!isRecord(input) || !str(input.name)) return bad("Give the token a name");
  const name = input.name.trim();
  if (!name) return bad("Give the token a name");
  if (name.length > 64) return bad("Keep the name under 64 characters");
  if (!SCOPES.includes(input.scope)) return bad("Unknown scope");
  if (input.expiresInDays !== null && !EXPIRY_DAYS.includes(input.expiresInDays)) return bad("Unknown expiry");
  const projects = input.projects === "all" ? "all" : Array.isArray(input.projects) ? [...new Set(input.projects.filter((s): s is string => str(s)))] : null;
  if (projects === null || (projects !== "all" && (!projects.length || projects.length > 50 || !projects.every((s) => SLUG_RE.test(s))))) {
    return bad("Choose which projects the token may reach");
  }
  const grants = Array.isArray(input.grants) ? [...new Set(input.grants.filter((g): g is TokenGrant => g === "env:write"))] : [];
  if (grants.length && input.scope !== "admin") return bad("Variable changes need the Admin scope");
  const { scope, expiresInDays } = input;
  const source = dataSource();
  if (source === "api") return apiCall<{ token: ApiToken; secret: string }>("POST", "/api/v1/tokens", { name, scope, expiresInDays, projects, ...(grants.length ? { grants } : {}) });
  if (source === "preview") {
    const refused = previewStepUp();
    if (refused) return refused;
    const now = Date.now();
    const secret = `dk_${seededString(`${name}:${now}`, 40, "abcdefghijklmnopqrstuvwxyz0123456789")}`;
    return done({
      secret,
      token: {
        id: `tok_${secret.slice(3, 9)}`,
        name,
        scope,
        prefix: secret.slice(0, 7),
        createdAt: new Date(now).toISOString(),
        expiresAt: expiresInDays ? new Date(now + expiresInDays * 86_400_000).toISOString() : null,
        lastUsedAt: null,
        allProjects: projects === "all",
        projects: projects === "all" ? [] : projects,
        grants,
      },
    });
  }
  return NONE;
}

export async function revokeToken(id: string): Promise<Outcome> {
  if (!isId(id)) return bad("Unknown token");
  const source = dataSource();
  if (source === "api") return apiCall("DELETE", `/api/v1/tokens/${encodeURIComponent(id)}`);
  if (source === "preview") return done(null);
  return NONE;
}
