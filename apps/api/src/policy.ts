import type { EndpointId, Role, TokenGrant, TokenScope } from "@dockify/contracts";

/**
 * The route policy table. Every route declares who may call it, and one hook (app.ts) enforces it:
 *
 *   anonymous   no credential needed (the handler may still look for one)
 *   session     a signed-in browser session whose team role is at least `role`
 *   elevated    the same, inside a fresh step-up window (5 minutes, this session only)
 *   +token      an API token with at least that scope is accepted too. Tokens are never elevated,
 *               and a token's power is capped by its owner's role. An elevated route lists a token
 *               only together with a grant: the token cannot step up, so it must have been handed
 *               that exact power when it was minted (`+grant`).
 *   internal    the worker, on the control network, with the internal channel token. No actor.
 *
 * The privilege rule: anything that changes what code runs or with what privilege, or destroys
 * data or takes production down is elevated. One exception: reading a single env
 * value (env.reveal, for the eye and the copy button) needs only an Admin session, and is
 * audited and rate limited per session instead.
 */
export type Access = "anonymous" | "session" | "elevated" | "internal";

export interface Policy {
  access: Access;
  role: Role;
  token?: TokenScope;
  /** With `token`: the explicit grant a token must also carry. */
  grant?: TokenGrant;
}

const anonymous = (): Policy => ({ access: "anonymous", role: "viewer" });
const session = (role: Role, token?: TokenScope): Policy => ({ access: "session", role, ...(token ? { token } : {}) });
const elevated = (role: Role): Policy => ({ access: "elevated", role });
/** Elevated for a session; a token passes only with this scope and this explicit grant. */
const elevatedOrGrant = (role: Role, token: TokenScope, grant: TokenGrant): Policy => ({ access: "elevated", role, token, grant });
/** A session at `role`, no step-up; a token passes only with this scope and this explicit grant. */
const internal = (): Policy => ({ access: "internal", role: "admin" });

export const ROLE_RANK: Record<Role, number> = { viewer: 0, admin: 1 };
export const SCOPE_RANK: Record<TokenScope, number> = { read: 0, deploy: 1, admin: 2 };
/** The highest role a token scope can act as; the token holder's own role caps it further. */
export const SCOPE_ROLE: Record<TokenScope, Role> = { read: "viewer", deploy: "admin", admin: "admin" };

export const describePolicy = (p: Policy): string =>
  p.access === "anonymous" || p.access === "internal" ? p.access : `${p.access}:${p.role}${p.token ? `+token:${p.token}` : ""}${p.grant ? `+grant:${p.grant}` : ""}`;

export const POLICIES = {
  // auth: the handlers do their own credential checks
  "auth.setupStatus": anonymous(),
  "auth.setup": anonymous(),
  "auth.login": anonymous(),
  "auth.verify": anonymous(),
  "auth.logout": anonymous(),
  "auth.invite.get": anonymous(),
  "auth.invite.accept": anonymous(),
  "auth.stepUp": session("viewer"),
  /** Same 202 for every address; the work runs after the answer (routes/email-auth.ts). */
  "auth.forgot": anonymous(),
  /** The single-use emailed token is the credential. */
  "auth.reset.get": anonymous(),
  "auth.reset": anonymous(),

  // account: each re-verifies a password or code inside where it matters
  "me.get": session("viewer"),
  "me.patch": session("viewer"),
  /** Time display and own email choices; the handler keeps security mail on for admins. */
  "me.preferences": session("viewer"),
  /** Only labels pushes in deploy lists; unique per instance. */
  "me.github": session("viewer"),
  "me.password": session("viewer"),
  /** Checks the current password inside, then mails the code me.password needs while email is on. */
  "me.password.code": session("viewer"),
  /** A change of address checks the step-up window inside; verifying the current one does not need it. */
  "me.email.code": session("viewer"),
  "me.email.confirm": session("viewer"),
  /** Turning MFA on needs the password first (step-up), so a borrowed cookie cannot claim it. */
  "me.2fa.setup": elevated("viewer"),
  "me.2fa.verify": elevated("viewer"),
  "me.2fa.disable": session("viewer"),
  "me.sessions.list": session("viewer"),
  "me.sessions.revoke": session("viewer"),
  "me.sessions.revokeOthers": session("viewer"),

  "team.get": session("viewer"),
  "team.change": elevated("admin"),
  "team.invites.create": elevated("admin"),
  "team.invites.delete": session("admin"),
  "settings.get": session("viewer"),
  "settings.patch": elevated("admin"),
  /** The dashboard's own address: reading and checking need an Admin session, changing anything a step-up. */
  "settings.domain.get": session("admin"),
  "settings.domain.start": elevated("admin"),
  "settings.domain.check": session("admin"),
  "settings.domain.record": elevated("admin"),
  "settings.domain.switch": elevated("admin"),
  "settings.domain.cancel": session("admin"),
  "settings.domain.previous.delete": elevated("admin"),
  "tokens.list": session("viewer"),
  "tokens.create": elevated("viewer"),
  "tokens.delete": session("viewer"),

  "activity.list": session("admin"),
  "overview.get": session("viewer", "read"),
  /** Icons are cosmetic: viewers and read tokens see them, only an Admin session changes one. */
  "icons.list": session("viewer", "read"),
  /** The signed token in the path is the credential (an HMAC the handler checks); it names one icon and nothing else. */
  "icons.mail.get": anonymous(),

  // projects
  "projects.list": session("viewer", "read"),
  "projects.create": session("admin", "admin"),
  "projects.get": session("viewer", "read"),
  "projects.patch": elevated("admin"),
  "projects.delete": elevated("admin"),
  "projects.apps.create": elevated("admin"),
  "projects.apps.import": elevated("admin"),
  "projects.apps.template": elevated("admin"),
  "templates.list": session("viewer", "read"),
  /** Secret values are always masked in a listing; env.reveal opens one at a time. */
  "env.get": session("admin"),
  /**
   * Env writes change what code runs with (NODE_OPTIONS, LD_PRELOAD, a swapped DATABASE_URL), so
   * they are elevated like a code change. A token needs the admin scope plus the env:write grant,
   * and even then the handler refuses secret values and loader-hook keys to it.
   */
  "env.put": elevatedOrGrant("admin", "admin", "env:write"),
  "env.delete": elevatedOrGrant("admin", "admin", "env:write"),
  "env.state": session("admin"),
  "env.apply": elevatedOrGrant("admin", "admin", "env:write"),
  /**
   * A signed-in Admin reads one value without re-prompting. Viewers and
   * API tokens are refused: the create-token dialog promises an env:write token cannot read
   * secrets, so only a session reaches plaintext. The handler audits every call (never the value)
   * and rate limits it per session.
   */
  "env.reveal": session("admin"),
  "env.versions": session("admin"),
  "env.rollback": elevatedOrGrant("admin", "admin", "env:write"),
  "environments.create": session("admin", "admin"),
  "environments.patch": elevated("admin"),
  "environments.delete": elevated("admin"),
  "previews.get": session("viewer", "read"),
  // Enables fork-PR builds on the host and writes the instance-wide preview cap, so it is elevated
  // like previews.delete rather than a plain admin write.
  "previews.settings": elevated("admin"),
  "previews.delete": elevated("admin"),
  /** Hands out a password once and locks out every browser the old one let in. */
  "previews.password": elevated("admin"),
  "previews.detail": session("viewer", "read"),
  "previews.dns.check": session("admin"),
  "previews.wake": session("admin", "deploy"),
  "statusPage.get": session("viewer"),
  "statusPage.patch": session("admin"),
  "projects.icon.get": session("viewer", "read"),
  "projects.icon.put": session("admin"),

  // apps
  "apps.detect": session("admin"),
  "apps.jobs.list": session("viewer", "read"),
  /** A job's command runs with the app's secrets, so it changes what code runs. */
  "apps.jobs.create": elevated("admin"),
  "apps.jobs.update": elevated("admin"),
  "apps.jobs.delete": elevated("admin"),
  /** Runs only what was approved, like Start. */
  "apps.jobs.run": session("admin", "deploy"),
  "apps.jobs.runs": session("viewer", "read"),
  /** The same reader as a deploy log: its output is redacted before it is stored. */
  "apps.jobs.run.get": session("viewer", "read"),
  "apps.get": session("viewer", "read"),
  "apps.patch": elevated("admin"),
  "apps.delete": elevated("admin"),
  "apps.logs": session("viewer", "read"),
  "apps.deploy": session("admin", "deploy"),
  "apps.vercel.sync": session("admin", "deploy"),
  "apps.restart": elevated("admin"),
  "apps.stop": elevated("admin"),
  "apps.start": session("admin", "deploy"),
  "apps.metrics": session("viewer", "read"),
  "apps.domains": session("viewer", "read"),
  "apps.data.tables": session("admin"),
  /** Row contents are tenant data: the same step-up and audit as a query. */
  "apps.data.rows": elevated("admin"),
  "apps.data.keys": session("admin"),
  "apps.data.query": elevated("admin"),
  "apps.backups": session("viewer"),
  "apps.version.get": session("admin"),
  "apps.version.change": elevated("admin"),
  "apps.version.switch": elevated("admin"),
  "apps.version.back": elevated("admin"),
  "apps.config.get": session("viewer", "read"),
  "apps.config.patch": elevated("admin"),
  "apps.icon.get": session("viewer", "read"),
  "apps.icon.put": session("admin"),
  "apps.terminal.ticket": elevated("admin"),
  /** The single-use ticket minted under step-up is checked by the handler. */
  "apps.terminal": session("admin"),

  // deployments
  "deployments.list": session("viewer", "read"),
  "deployments.get": session("viewer", "read"),
  "deployments.logs": session("viewer", "read"),
  "deployments.logs.stream": session("viewer", "read"),
  "deployments.redeploy": session("admin", "deploy"),
  "deployments.rollback": session("admin", "deploy"),
  "deployments.cancel": session("admin", "deploy"),

  // git
  "git.installations": session("viewer"),
  "git.installUrl": session("admin"),
  // GitHub's redirect back: the signed, single-use state bound to a live session authenticates it
  "git.setup": anonymous(),
  /** Mints the single-use state the App creation round trip returns with; the App holds repository access once installed. */
  "git.app.manifest": elevated("admin"),
  // GitHub's redirect after it created the App: same as git.setup, the signed single-use manifest
  // state bound to a live Admin session authenticates it, because no session cookie rides along
  "git.app.callback": anonymous(),
  /** Drops the App's private key, webhook secret and client secret, and every installation: elevated like the creation. */
  "git.app.delete": elevated("admin"),
  "git.repos": session("admin"),
  "git.branches": session("admin"),
  "git.installations.delete": elevated("admin"),

  // integrations: anything that stores or drops a credential is elevated
  /** An admin gets every card; anyone else only what is connected (the handler decides). */
  "integrations.summary": session("viewer"),
  "integrations.vercel.connect": elevated("admin"),
  "integrations.vercel.delete": elevated("admin"),
  "integrations.vercel.projects": session("admin"),
  /** Writes secret env values, so it is elevated like every other secret write. */
  "integrations.vercel.import": elevated("admin"),
  "integrations.cloudflare.connect": elevated("admin"),
  "integrations.cloudflare.delete": elevated("admin"),
  "integrations.cloudflare.zones": session("admin"),
  "integrations.cloudflare.zone": elevated("admin"),
  /** Reads only zones the owner switched on. Writing a record is elevated: it can replace one, with a go-ahead. */
  "integrations.cloudflare.domains": session("admin"),
  "integrations.cloudflare.lookup": session("admin"),
  "integrations.cloudflare.record": elevated("admin"),
  "integrations.registries.list": session("admin"),
  "integrations.registries.create": elevated("admin"),
  "integrations.registries.patch": elevated("admin"),
  "integrations.registries.delete": elevated("admin"),
  "integrations.storage.list": session("admin"),
  "integrations.storage.create": elevated("admin"),
  "integrations.storage.patch": elevated("admin"),
  "integrations.storage.delete": elevated("admin"),
  "integrations.storage.test": session("admin"),
  /** Hints only, never a URL or a secret. */
  "integrations.webhooks.list": session("admin"),
  /** Each stores, replaces or drops a sealed URL or secret, and decides where alert text goes. */
  "integrations.webhooks.create": elevated("admin"),
  "integrations.webhooks.patch": elevated("admin"),
  "integrations.webhooks.delete": elevated("admin"),
  /** Sends one fixed test message through net-guard; nothing is stored. Rate limited like any write. */
  "integrations.webhooks.test": session("admin"),
  /** Logos are cosmetic: viewers see them next to the rules they can read. */
  "integrations.webhooks.icon": session("viewer"),
  /** Email sends password resets and codes in this instance's name: admin only, under step-up. */
  "integrations.email.connect": elevated("admin"),
  "integrations.email.delete": elevated("admin"),
  // Elevated: with the form's unsaved values it dials a server nothing has checked yet.
  "integrations.email.test": elevated("admin"),

  // resources and domains
  "resources.list": session("viewer", "read"),
  "resources.create": elevated("admin"),
  "domains.list": session("viewer", "read"),
  "domains.create": session("admin", "admin"),
  "domains.check": session("admin", "admin"),
  "domains.test.offer": session("admin", "admin"),
  /** Same as adding any domain; the name is generated here, never taken from the caller. */
  "domains.test.create": session("admin", "admin"),
  "domains.delete": elevated("admin"),

  // server and updates
  "server.get": session("viewer", "read"),
  "server.metrics": session("viewer", "read"),
  /**
   * No step-up: a prune removes only what the janitor removes on its own timer (images no rollback
   * needs, unused build cache), never a volume or anything of the control plane, so it changes no
   * code and destroys no data. The page's Prune button asks for no step-up either.
   */
  "server.prune": session("admin"),
  "server.updates": session("viewer"),
  "server.updates.check": session("admin"),
  "server.updates.apply": elevated("admin"),
  /** Rolling back restores the pre-update dump: it changes what runs and discards later writes. */
  "server.updates.rollback": elevated("admin"),
  "server.updates.skip": elevated("admin"),
  "server.updates.pause": elevated("admin"),
  /** Turning automatic installs on decides what code runs without a click. */
  "server.updates.policy": elevated("admin"),
  /** Every member sees the security release banner; it reads the stored signed feed only. */
  "server.updates.security": session("viewer"),
  /** Only Admins get the popup, so only they put it off. It changes nothing but their own reminder. */
  "server.updates.security.snooze": session("admin"),

  // backups: retention, restore, download and delete are elevated
  "backups.list": session("viewer", "read"),
  "backups.schedules": session("viewer", "read"),
  "backups.config": session("viewer"),
  "backups.schedules.patch": elevated("admin"),
  "backups.run": session("admin", "admin"),
  "backups.restore": elevated("admin"),
  "backups.restoreStatus": session("admin"),
  "backups.test": session("admin"),
  "backups.orphans.delete": elevated("admin"),
  "backups.download": elevated("admin"),

  "alerts.get": session("viewer", "read"),
  "alerts.rules.create": session("admin"),
  "alerts.rules.patch": session("admin"),
  "alerts.rules.delete": session("admin"),
  "alerts.mutes.put": session("admin"),
  "alerts.mutes.delete": session("admin"),

  "logs.query": session("viewer", "read"),
  "logs.stream": session("viewer", "read"),

  /** Public by design; the handler returns only what the project chose to publish. */
  "public.status": anonymous(),
  /** Authenticated by the GitHub HMAC signature, checked by the handler. */
  "webhooks.github": anonymous(),

  /** The same reader rule as every other log, whichever server the lines come from. */
  "apps.vercel.logs": session("viewer", "read"),
  "apps.vercel.logs.stream": session("viewer", "read"),
  /** Each stores or drops a signing secret and changes what is registered on the owner's Vercel account. */
  "integrations.vercel.webhook.create": elevated("admin"),
  "integrations.vercel.webhook.delete": elevated("admin"),
  /** Only reads Vercel and writes the mirror's rows. */
  "integrations.vercel.sync": session("admin"),
  /** Authenticated by the Vercel HMAC signature, checked by the handler; it only ever queues a mirror sync. */
  "webhooks.vercel": anonymous(),
} as const satisfies Record<EndpointId, Policy>;

/** Infrastructure routes outside the contract catalog. */
export const INFRA_POLICIES = {
  "GET /healthz": anonymous(),
  "GET /readyz": anonymous(),
  /** The domain ownership probe's answer on every host Traefik sends the prefix for (modules/domains/check-route.ts). */
  "GET /.well-known/dockify-check/:token": anonymous(),
  /** The page a sleeping preview's hosts show; static, and it says nothing about the preview (modules/previews/asleep-route.ts). */
  "GET /.well-known/dockify-preview-asleep": anonymous(),
  /**
   * The preview password gate (modules/previews/gate.ts). forwardAuth's check is outside the public
   * prefix, so only the edge network reaches it, and it says only yes or shows the password page. The form
   * reaches the api through a preview's own router, which fixes the id; it has per-preview limits.
   */
  "GET /internal/preview-gate/:id": anonymous(),
  "POST /.well-known/dockify-preview-gate/:id": anonymous(),
  /** The secret-opening service for the worker; see internal/secrets.ts. */
  "POST /internal/secrets/open": internal(),
  "POST /internal/secrets/seal": internal(),
  "POST /internal/secrets/escrow": internal(),
} as const satisfies Record<string, Policy>;
