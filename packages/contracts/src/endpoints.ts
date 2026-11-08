/**
 * The endpoint catalog: every route the web speaks, with its request schemas and response shape.
 * The api registers routes from this table only, so a route cannot exist without a contract, and
 * its policy table is typed `Record<EndpointId, Policy>`, so a contract cannot exist without a policy.
 */
import { z } from "zod";
import * as A from "./auth.ts";
import * as T from "./templates.ts";
import * as Act from "./activity.ts";
import * as Ap from "./apps.ts";
import * as B from "./backups.ts";
import * as Dd from "./dashboard-domain.ts";
import { EmptyBody, ExternalId, Uuid } from "./common.ts";
import * as Ic from "./icons.ts";
import * as J from "./jobs.ts";
import * as I from "./integrations.ts";
import * as P from "./projects.ts";
import * as R from "./resources.ts";
import * as S from "./server.ts";
import * as Sec from "./security-release.ts";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
/** json: a JSON body; none: 204 or 202 with no body; file: a download; stream: SSE; websocket: upgrade. */
export type ResponseKind = "json" | "none" | "file" | "stream" | "websocket";

export interface EndpointDef {
  method: Method;
  path: string;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  response?: z.ZodType;
  /** Success status. Default 200 for json, 204 for none. */
  status?: number;
  kind?: ResponseKind;
}

const ep = <const T extends EndpointDef>(d: T): T => d;
const V1 = "/api/v1";
const IdParams = z.strictObject({ id: Uuid });
const ExtParams = z.strictObject({ id: ExternalId });
const list = <T extends z.ZodType>(t: T) => z.array(t);

export const endpoints = {
  // ---------------------------------------------------------------- auth
  "auth.setupStatus": ep({ method: "GET", path: `${V1}/auth/setup-status`, response: A.SetupStatus }),
  "auth.setup": ep({ method: "POST", path: `${V1}/auth/setup`, body: A.SetupBody, response: A.OkEmpty }),
  "auth.login": ep({ method: "POST", path: `${V1}/auth/login`, body: A.LoginBody, response: A.LoginResponse }),
  "auth.verify": ep({ method: "POST", path: `${V1}/auth/verify`, body: A.VerifyBody, response: A.OkEmpty }),
  "auth.logout": ep({ method: "POST", path: `${V1}/auth/logout`, body: EmptyBody, response: A.OkEmpty }),
  "auth.invite.get": ep({ method: "GET", path: `${V1}/auth/invite/:token`, params: A.InviteParams, response: A.InvitePreview }),
  "auth.invite.accept": ep({ method: "POST", path: `${V1}/auth/invite/:token`, params: A.InviteParams, body: A.AcceptInviteBody, response: A.OkEmpty }),
  "auth.stepUp": ep({ method: "POST", path: `${V1}/auth/step-up`, body: A.StepUpBody, response: A.StepUpResponse }),
  "auth.forgot": ep({ method: "POST", path: `${V1}/auth/forgot`, body: A.ForgotBody, kind: "none", status: 202 }),
  "auth.reset.get": ep({ method: "GET", path: `${V1}/auth/reset/:token`, params: A.ResetParams, response: A.ResetPreview }),
  "auth.reset": ep({ method: "POST", path: `${V1}/auth/reset/:token`, params: A.ResetParams, body: A.PasswordResetBody, response: A.OkEmpty }),

  // ---------------------------------------------------------------- account
  "me.get": ep({ method: "GET", path: `${V1}/me`, response: A.Me }),
  "me.patch": ep({ method: "PATCH", path: `${V1}/me`, body: A.PatchMeBody, response: A.Me }),
  "me.preferences": ep({ method: "PATCH", path: `${V1}/me/preferences`, body: A.PreferencesBody, response: A.Me }),
  "me.github": ep({ method: "PUT", path: `${V1}/me/github`, body: A.GitHubLoginBody, response: A.Me }),
  "me.password": ep({ method: "POST", path: `${V1}/me/password`, body: A.ChangePasswordBody, kind: "none" }),
  "me.password.code": ep({ method: "POST", path: `${V1}/me/password/code`, body: A.PasswordCodeBody, response: A.PasswordCodeResponse }),
  "me.email.code": ep({ method: "POST", path: `${V1}/me/email/code`, body: A.EmailCodeBody, response: A.EmailCodeResponse }),
  "me.email.confirm": ep({ method: "POST", path: `${V1}/me/email/confirm`, body: A.EmailConfirmBody, response: A.Me }),
  "me.2fa.setup": ep({ method: "POST", path: `${V1}/me/2fa/setup`, body: EmptyBody, response: A.TotpSetup }),
  "me.2fa.verify": ep({ method: "POST", path: `${V1}/me/2fa/verify`, body: A.CodeBody, kind: "none" }),
  "me.2fa.disable": ep({ method: "POST", path: `${V1}/me/2fa/disable`, body: A.CodeBody, kind: "none" }),
  "me.sessions.list": ep({ method: "GET", path: `${V1}/me/sessions`, response: list(A.SessionRow) }),
  "me.sessions.revoke": ep({ method: "DELETE", path: `${V1}/me/sessions/:id`, params: IdParams, kind: "none" }),
  "me.sessions.revokeOthers": ep({ method: "DELETE", path: `${V1}/me/sessions`, kind: "none" }),

  // ---------------------------------------------------------------- team, settings, tokens
  "team.get": ep({ method: "GET", path: `${V1}/team`, response: A.Team }),
  "team.change": ep({ method: "POST", path: `${V1}/team`, body: A.TeamChangesBody, response: A.Team }),
  "team.invites.create": ep({ method: "POST", path: `${V1}/team/invites`, body: A.CreateInviteBody, response: A.CreateInviteResponse }),
  "team.invites.delete": ep({ method: "DELETE", path: `${V1}/team/invites/:id`, params: IdParams, kind: "none" }),
  "settings.get": ep({ method: "GET", path: `${V1}/settings`, response: A.InstanceSettings }),
  "settings.patch": ep({ method: "PATCH", path: `${V1}/settings`, body: A.PatchSettingsBody, response: A.InstanceSettings }),
  "settings.domain.get": ep({ method: "GET", path: `${V1}/settings/domain`, response: Dd.DashboardDomainState }),
  "settings.domain.start": ep({ method: "POST", path: `${V1}/settings/domain`, body: Dd.DashboardDomainBody, response: Dd.DashboardDomainState }),
  "settings.domain.check": ep({ method: "POST", path: `${V1}/settings/domain/check`, body: EmptyBody, response: Dd.DashboardDomainState }),
  "settings.domain.record": ep({ method: "POST", path: `${V1}/settings/domain/record`, body: Dd.CfRecordBody, response: Dd.DashboardDomainState }),
  "settings.domain.switch": ep({ method: "POST", path: `${V1}/settings/domain/switch`, body: EmptyBody, response: Dd.DashboardDomainState }),
  "settings.domain.cancel": ep({ method: "DELETE", path: `${V1}/settings/domain`, response: Dd.DashboardDomainState }),
  "settings.domain.previous.delete": ep({ method: "DELETE", path: `${V1}/settings/domain/previous/:host`, params: Dd.DashboardPreviousParams, response: Dd.DashboardDomainState }),
  "tokens.list": ep({ method: "GET", path: `${V1}/tokens`, response: list(A.ApiTokenRow) }),
  "tokens.create": ep({ method: "POST", path: `${V1}/tokens`, body: A.CreateTokenBody, response: A.CreateTokenResponse }),
  "tokens.delete": ep({ method: "DELETE", path: `${V1}/tokens/:id`, params: IdParams, kind: "none" }),

  // ---------------------------------------------------------------- activity, overview
  "activity.list": ep({ method: "GET", path: `${V1}/activity`, query: Act.ActivityQuery, response: Act.ActivityPage }),
  "overview.get": ep({ method: "GET", path: `${V1}/overview`, response: Act.Overview }),
  /** Every app and project icon that is not the plain default, read once by the console layout. */
  "icons.list": ep({ method: "GET", path: `${V1}/icons`, response: Ic.IconMap }),
  /** One app's or project's icon for a signed, unguessable token, so an email can show it without a session. */
  "icons.mail.get": ep({ method: "GET", path: `${V1}/icons/mail/:token`, params: Ic.MailIconParams, kind: "file" }),

  // ---------------------------------------------------------------- projects
  "projects.list": ep({ method: "GET", path: `${V1}/projects`, response: list(P.ProjectListItem) }),
  "projects.create": ep({ method: "POST", path: `${V1}/projects`, body: P.NewProjectBody, response: P.NewProjectResponse, status: 201 }),
  "projects.get": ep({ method: "GET", path: `${V1}/projects/:slug`, params: P.SlugParams, response: P.ProjectDetail }),
  "projects.patch": ep({ method: "PATCH", path: `${V1}/projects/:slug`, params: P.SlugParams, body: P.ProjectPatchBody, response: P.ProjectDetail }),
  "projects.delete": ep({ method: "DELETE", path: `${V1}/projects/:slug`, params: P.SlugParams, body: P.ConfirmBody, kind: "none" }),
  "projects.apps.create": ep({ method: "POST", path: `${V1}/projects/:slug/apps`, params: P.SlugParams, body: P.NewAppBody, response: P.NewAppResponse, status: 201 }),
  /** What will run, for the New app picker. Static, ships with the release, and holds no secret. */
  "templates.list": ep({ method: "GET", path: `${V1}/templates`, response: T.TemplateList }),
  "projects.apps.template": ep({ method: "POST", path: `${V1}/projects/:slug/apps/template`, params: P.SlugParams, body: T.DeployTemplateBody, response: T.DeployTemplateResponse, status: 201 }),
  "projects.apps.import": ep({ method: "POST", path: `${V1}/projects/:slug/apps/import`, params: P.SlugParams, body: P.ImportAppsBody, response: P.ImportAppsResponse, status: 201 }),
  "env.get": ep({ method: "GET", path: `${V1}/projects/:slug/env`, params: P.SlugParams, response: P.ProjectEnv }),
  "env.put": ep({ method: "PUT", path: `${V1}/projects/:slug/env`, params: P.SlugParams, body: P.EnvPutBody, response: P.ProjectEnv }),
  "env.delete": ep({ method: "DELETE", path: `${V1}/projects/:slug/env`, params: P.SlugParams, body: P.EnvDeleteBody, kind: "none" }),
  "env.state": ep({ method: "GET", path: `${V1}/projects/:slug/env/state`, params: P.SlugParams, response: P.EnvState }),
  "env.apply": ep({ method: "POST", path: `${V1}/projects/:slug/env/apply`, params: P.SlugParams, body: P.EnvApplyBody, response: P.EnvApplyResponse }),
  "env.reveal": ep({ method: "POST", path: `${V1}/projects/:slug/env/reveal`, params: P.SlugParams, body: P.EnvRevealBody, response: P.EnvRevealResponse }),
  "env.versions": ep({ method: "GET", path: `${V1}/projects/:slug/env/versions`, params: P.SlugParams, query: P.EnvVersionsQuery, response: P.EnvVersions }),
  "env.rollback": ep({ method: "POST", path: `${V1}/projects/:slug/env/rollback`, params: P.SlugParams, body: P.EnvRollbackBody, response: P.EnvRollbackResponse }),
  "environments.create": ep({ method: "POST", path: `${V1}/projects/:slug/environments`, params: P.SlugParams, body: P.AddEnvironmentBody, kind: "none", status: 201 }),
  "environments.patch": ep({ method: "PATCH", path: `${V1}/projects/:slug/environments/:name`, params: P.EnvironmentParams, body: P.EnvironmentBranchBody, kind: "none" }),
  "environments.delete": ep({ method: "DELETE", path: `${V1}/projects/:slug/environments/:name`, params: P.EnvironmentParams, body: P.ConfirmBody, kind: "none" }),
  "previews.get": ep({ method: "GET", path: `${V1}/projects/:slug/previews`, params: P.SlugParams, response: P.PreviewState }),
  "previews.settings": ep({ method: "PATCH", path: `${V1}/projects/:slug/previews/settings`, params: P.SlugParams, body: P.PreviewSettings, response: P.PreviewSettingsSaved }),
  /** Makes a new preview password, shows it once and locks out every browser the old one let in. */
  "previews.password": ep({ method: "POST", path: `${V1}/projects/:slug/previews/password`, params: P.SlugParams, body: EmptyBody, response: P.PreviewPassword }),
  "previews.delete": ep({ method: "DELETE", path: `${V1}/projects/:slug/previews/:pr`, params: P.PreviewParams, body: EmptyBody, kind: "none", status: 202 }),
  "previews.dns.check": ep({ method: "POST", path: `${V1}/projects/:slug/previews/dns/check`, params: P.SlugParams, body: EmptyBody, kind: "none", status: 202 }),
  "previews.detail": ep({ method: "GET", path: `${V1}/projects/:slug/previews/:pr`, params: P.PreviewParams, response: P.PreviewDetail }),
  "previews.wake": ep({ method: "POST", path: `${V1}/projects/:slug/previews/:pr/wake`, params: P.PreviewParams, body: EmptyBody, kind: "none", status: 202 }),
  "statusPage.get": ep({ method: "GET", path: `${V1}/projects/:slug/status-page`, params: P.SlugParams, response: P.StatusPageState }),
  "statusPage.patch": ep({ method: "PATCH", path: `${V1}/projects/:slug/status-page`, params: P.SlugParams, body: P.StatusPagePatch, response: P.StatusPageState }),
  "projects.icon.get": ep({ method: "GET", path: `${V1}/projects/:slug/icon`, params: Ic.ProjectIconParams, query: Ic.IconQuery, kind: "file" }),
  "projects.icon.put": ep({ method: "PUT", path: `${V1}/projects/:slug/icon`, params: Ic.ProjectIconParams, body: Ic.SetProjectIconBody, response: Ic.IconState }),

  // ---------------------------------------------------------------- apps
  "apps.detect": ep({ method: "POST", path: `${V1}/apps/detect`, body: P.DetectBody, response: P.DetectResult }),
  "apps.jobs.list": ep({ method: "GET", path: `${V1}/apps/:id/jobs`, params: Ap.AppParams, response: J.AppJobs }),
  "apps.jobs.create": ep({ method: "POST", path: `${V1}/apps/:id/jobs`, params: Ap.AppParams, body: J.CreateJobBody, response: J.ScheduledJob, status: 201 }),
  "apps.jobs.update": ep({ method: "PATCH", path: `${V1}/apps/:id/jobs/:jobId`, params: J.JobParams, body: J.PatchJobBody, response: J.ScheduledJob }),
  "apps.jobs.delete": ep({ method: "DELETE", path: `${V1}/apps/:id/jobs/:jobId`, params: J.JobParams, kind: "none" }),
  "apps.jobs.run": ep({ method: "POST", path: `${V1}/apps/:id/jobs/:jobId/run`, params: J.JobParams, body: EmptyBody, response: J.RunJobResponse, status: 202 }),
  "apps.jobs.runs": ep({ method: "GET", path: `${V1}/apps/:id/jobs/:jobId/runs`, params: J.JobParams, response: J.JobRuns }),
  "apps.jobs.run.get": ep({ method: "GET", path: `${V1}/apps/:id/jobs/:jobId/runs/:runId`, params: J.JobRunParams, response: J.JobRunDetail }),
  "apps.get": ep({ method: "GET", path: `${V1}/apps/:id`, params: Ap.AppParams, response: Ap.AppDetail }),
  "apps.patch": ep({ method: "PATCH", path: `${V1}/apps/:id`, params: Ap.AppParams, body: Ap.AppPatchBody, response: Ap.AppDetail }),
  "apps.rename": ep({ method: "PUT", path: `${V1}/apps/:id/name`, params: Ap.AppParams, body: Ap.AppRenameBody, response: Ap.AppDetail }),
  "apps.delete": ep({ method: "DELETE", path: `${V1}/apps/:id`, params: Ap.AppParams, body: P.ConfirmBody, kind: "none" }),
  "apps.logs": ep({ method: "GET", path: `${V1}/apps/:id/logs`, params: Ap.AppParams, query: Ap.AppLogsQuery, response: Ap.AppLogs }),
  "apps.vercel.sync": ep({ method: "POST", path: `${V1}/apps/:id/vercel/sync`, params: Ap.AppParams, body: EmptyBody, kind: "none", status: 202 }),
  /** The Vercel project an app links to, read live from Vercel (cached briefly): settings, production, domains. */
  "apps.vercel.project": ep({ method: "GET", path: `${V1}/apps/:id/vercel/project`, params: Ap.AppParams, response: I.VercelProjectView }),
  /** The linked Vercel project's environment variables. Never decrypted; plain values for admins only. */
  "apps.vercel.env": ep({ method: "GET", path: `${V1}/apps/:id/vercel/env`, params: Ap.AppParams, response: I.VercelEnvList }),
  /** A Vercel app's runtime logs, read from Vercel (at most 256 lines; Vercel keeps them per plan). */
  "apps.vercel.logs": ep({ method: "GET", path: `${V1}/apps/:id/vercel/logs`, params: Ap.AppParams, query: S.VercelLogsQuery, response: S.VercelLogPage }),
  /** SSE of a Vercel app's runtime logs as Vercel prints them: events `line` (id = line id) and `end`. */
  "apps.vercel.logs.stream": ep({ method: "GET", path: `${V1}/apps/:id/vercel/logs/stream`, params: Ap.AppParams, query: S.VercelLogStreamQuery, kind: "stream" }),
  "apps.deploy": ep({ method: "POST", path: `${V1}/apps/:id/deploy`, params: Ap.AppParams, body: EmptyBody, response: Ap.DeployResponse, status: 202 }),
  "apps.restart": ep({ method: "POST", path: `${V1}/apps/:id/restart`, params: Ap.AppParams, body: EmptyBody, kind: "none", status: 202 }),
  "apps.stop": ep({ method: "POST", path: `${V1}/apps/:id/stop`, params: Ap.AppParams, body: EmptyBody, kind: "none", status: 202 }),
  "apps.start": ep({ method: "POST", path: `${V1}/apps/:id/start`, params: Ap.AppParams, body: EmptyBody, kind: "none", status: 202 }),
  "apps.metrics": ep({ method: "GET", path: `${V1}/apps/:id/metrics`, params: Ap.AppParams, query: Ap.RangeQuery, response: Ap.AppMetrics }),
  "apps.domains": ep({ method: "GET", path: `${V1}/apps/:id/domains`, params: Ap.AppParams, response: Ap.AppDomains }),
  "apps.data.tables": ep({ method: "GET", path: `${V1}/apps/:id/data/tables`, params: Ap.AppParams, response: Ap.PgTables }),
  "apps.data.rows": ep({ method: "GET", path: `${V1}/apps/:id/data/rows`, params: Ap.AppParams, query: Ap.PgRowsQuery, response: Ap.PgRows }),
  "apps.data.keys": ep({ method: "GET", path: `${V1}/apps/:id/data/keys`, params: Ap.AppParams, query: Ap.RedisKeysQuery, response: Ap.RedisKeys }),
  "apps.data.query": ep({ method: "POST", path: `${V1}/apps/:id/data/query`, params: Ap.AppParams, body: Ap.QueryBody, response: Ap.QueryResult }),
  "apps.version.get": ep({ method: "GET", path: `${V1}/apps/:id/service-version`, params: Ap.AppParams, response: Ap.ServiceVersionView }),
  "apps.version.change": ep({ method: "POST", path: `${V1}/apps/:id/service-version`, params: Ap.AppParams, body: Ap.ServiceVersionChange, response: Ap.ServiceVersionView, status: 202 }),
  "apps.version.switch": ep({ method: "POST", path: `${V1}/apps/:id/service-version/switch`, params: Ap.AppParams, body: Ap.ServiceVersionConfirm, response: Ap.ServiceVersionView, status: 202 }),
  "apps.version.back": ep({ method: "POST", path: `${V1}/apps/:id/service-version/back`, params: Ap.AppParams, body: Ap.ServiceVersionConfirm, response: Ap.ServiceVersionView }),
  "apps.backups": ep({ method: "GET", path: `${V1}/apps/:id/backups`, params: Ap.AppParams, response: Ap.AppBackups }),
  "apps.config.get": ep({ method: "GET", path: `${V1}/apps/:id/config`, params: Ap.AppParams, response: Ap.AppConfig }),
  "apps.config.patch": ep({ method: "PATCH", path: `${V1}/apps/:id/config`, params: Ap.AppParams, body: Ap.AppConfigPatch, response: Ap.AppConfig }),
  "apps.terminal.ticket": ep({ method: "POST", path: `${V1}/apps/:id/terminal/ticket`, params: Ap.AppParams, body: EmptyBody, response: Ap.TerminalTicket }),
  "apps.icon.get": ep({ method: "GET", path: `${V1}/apps/:id/icon`, params: Ic.AppIconParams, query: Ic.IconQuery, kind: "file" }),
  "apps.icon.put": ep({ method: "PUT", path: `${V1}/apps/:id/icon`, params: Ic.AppIconParams, body: Ic.SetIconBody, response: Ic.IconState }),
  /** The upgrade itself: the ticket is the socket's first message, never part of a URL (api modules/terminal). */
  "apps.terminal": ep({ method: "GET", path: `${V1}/apps/:id/terminal`, params: Ap.AppParams, kind: "websocket" }),

  // ---------------------------------------------------------------- deployments
  "deployments.list": ep({ method: "GET", path: `${V1}/deployments`, query: Act.DeploymentsQuery, response: Act.DeploymentPage }),
  "deployments.get": ep({ method: "GET", path: `${V1}/deployments/:id`, params: IdParams, response: Act.DeploymentDetail }),
  "deployments.logs": ep({ method: "GET", path: `${V1}/deployments/:id/logs`, params: IdParams, query: Act.DeploymentLogsQuery, response: Act.DeploymentLogs }),
  /** SSE: events `line` (id = seq), `done` and `error`; resumes from Last-Event-ID. */
  "deployments.logs.stream": ep({ method: "GET", path: `${V1}/deployments/:id/logs/stream`, params: IdParams, query: Act.DeploymentLogsQuery, kind: "stream" }),
  "deployments.redeploy": ep({ method: "POST", path: `${V1}/deployments/:id/redeploy`, params: IdParams, body: EmptyBody, response: Act.DeploymentActionResponse }),
  "deployments.rollback": ep({ method: "POST", path: `${V1}/deployments/:id/rollback`, params: IdParams, body: EmptyBody, response: Act.DeploymentActionResponse }),
  "deployments.cancel": ep({ method: "POST", path: `${V1}/deployments/:id/cancel`, params: IdParams, body: EmptyBody, response: Act.DeploymentActionResponse }),

  // ---------------------------------------------------------------- git
  "git.installations": ep({ method: "GET", path: `${V1}/git/installations`, response: list(I.GitInstallation) }),
  "git.installUrl": ep({ method: "GET", path: `${V1}/git/install-url`, response: I.GitInstallUrl }),
  "git.setup": ep({ method: "GET", path: `${V1}/git/setup`, query: I.GitSetupQuery, kind: "none", status: 302 }),
  "git.app.manifest": ep({ method: "POST", path: `${V1}/git/app/manifest`, body: I.GitAppManifestBody, response: I.GitAppManifest }),
  "git.app.callback": ep({ method: "GET", path: `${V1}/git/app/callback`, query: I.GitAppCallbackQuery, kind: "none", status: 302 }),
  /** Forgets this server's GitHub App and its installations, so another can be created. The App stays on GitHub. */
  "git.app.delete": ep({ method: "DELETE", path: `${V1}/git/app`, kind: "none" }),
  "git.repos": ep({ method: "GET", path: `${V1}/git/repos`, query: I.GitReposQuery, response: I.GitRepoPage }),
  "git.branches": ep({ method: "GET", path: `${V1}/git/repos/:id/branches`, params: ExtParams, response: list(I.GitBranch) }),
  "git.installations.delete": ep({ method: "DELETE", path: `${V1}/git/installations/:id`, params: ExtParams, response: z.object({ ok: z.literal(true) }) }),

  // ---------------------------------------------------------------- integrations
  "integrations.summary": ep({ method: "GET", path: `${V1}/integrations`, response: z.union([I.IntegrationsSummary, I.IntegrationsConnected]) }),
  "integrations.vercel.connect": ep({ method: "POST", path: `${V1}/integrations/vercel`, body: I.VercelConnectBody, response: z.union([I.VercelCheck, I.VercelIntegration]) }),
  "integrations.vercel.delete": ep({ method: "DELETE", path: `${V1}/integrations/vercel`, kind: "none" }),
  "integrations.vercel.projects": ep({ method: "GET", path: `${V1}/integrations/vercel/projects`, response: list(I.VercelProject) }),
  "integrations.vercel.import": ep({ method: "POST", path: `${V1}/integrations/vercel/import`, body: I.VercelImportBody, response: I.VercelImportResult }),
  /** Registers (or replaces) the deployment webhook for every linked Vercel project. 200 with state unavailable on Hobby. */
  "integrations.vercel.webhook.create": ep({ method: "POST", path: `${V1}/integrations/vercel/webhook`, body: EmptyBody, response: I.VercelWebhookState }),
  "integrations.vercel.webhook.delete": ep({ method: "DELETE", path: `${V1}/integrations/vercel/webhook`, kind: "none" }),
  /** Reads every linked Vercel project's deployments now, instead of at the next periodic pass. */
  "integrations.vercel.sync": ep({ method: "POST", path: `${V1}/integrations/vercel/sync`, body: EmptyBody, kind: "none", status: 202 }),
  "integrations.cloudflare.connect": ep({ method: "POST", path: `${V1}/integrations/cloudflare`, body: I.CloudflareConnectBody, response: I.CloudflareIntegration }),
  "integrations.cloudflare.delete": ep({ method: "DELETE", path: `${V1}/integrations/cloudflare`, kind: "none" }),
  "integrations.cloudflare.zones": ep({ method: "GET", path: `${V1}/integrations/cloudflare/zones`, response: list(I.CloudflareZone) }),
  "integrations.cloudflare.zone": ep({ method: "PATCH", path: `${V1}/integrations/cloudflare/zones/:id`, params: ExtParams, body: I.CloudflareZonePatch, response: I.CloudflareZone }),
  "integrations.cloudflare.domains": ep({ method: "GET", path: `${V1}/integrations/cloudflare/domains`, response: Dd.CfDomainsPayload }),
  "integrations.cloudflare.lookup": ep({ method: "GET", path: `${V1}/integrations/cloudflare/lookup`, query: Dd.CfLookupQuery, response: Dd.CfLookup }),
  "integrations.cloudflare.record": ep({ method: "POST", path: `${V1}/integrations/cloudflare/domains/:id/record`, params: IdParams, body: Dd.CfRecordBody, response: Dd.CfRecordResult }),
  "integrations.registries.list": ep({ method: "GET", path: `${V1}/integrations/registries`, response: list(I.Registry) }),
  "integrations.registries.create": ep({ method: "POST", path: `${V1}/integrations/registries`, body: I.RegistryCreateBody, response: I.Registry }),
  "integrations.registries.patch": ep({ method: "PATCH", path: `${V1}/integrations/registries/:id`, params: IdParams, body: I.RegistryPatchBody, response: I.Registry }),
  "integrations.registries.delete": ep({ method: "DELETE", path: `${V1}/integrations/registries/:id`, params: IdParams, kind: "none" }),
  "integrations.storage.list": ep({ method: "GET", path: `${V1}/integrations/storage`, response: list(I.StorageDestination) }),
  "integrations.storage.create": ep({ method: "POST", path: `${V1}/integrations/storage`, body: I.StorageCreateBody, response: I.StorageDestination }),
  "integrations.storage.patch": ep({ method: "PATCH", path: `${V1}/integrations/storage/:id`, params: IdParams, body: I.StoragePatchBody, response: I.StorageDestination }),
  "integrations.storage.delete": ep({ method: "DELETE", path: `${V1}/integrations/storage/:id`, params: IdParams, kind: "none" }),
  "integrations.storage.test": ep({ method: "POST", path: `${V1}/integrations/storage/:id/test`, params: IdParams, body: EmptyBody, response: I.StorageTestResult }),
  /** Deprecated, kept for one version: the first Discord and generic webhook. Use integrations.webhooks.*. */
  "integrations.webhooks.list": ep({ method: "GET", path: `${V1}/integrations/webhooks`, response: list(I.Webhook) }),
  "integrations.webhooks.create": ep({ method: "POST", path: `${V1}/integrations/webhooks`, body: I.WebhookCreateBody, response: I.WebhookSaved, status: 201 }),
  "integrations.webhooks.patch": ep({ method: "PATCH", path: `${V1}/integrations/webhooks/:id`, params: IdParams, body: I.WebhookPatchBody, response: I.WebhookSaved }),
  "integrations.webhooks.delete": ep({ method: "DELETE", path: `${V1}/integrations/webhooks/:id`, params: IdParams, kind: "none" }),
  /** One test message, to a saved webhook ({ id }) or to one the add form has not saved yet. A refusal is 502 WEBHOOK_FAILED. */
  "integrations.webhooks.test": ep({ method: "POST", path: `${V1}/integrations/webhooks/test`, body: I.WebhookTestBody, response: I.WebhookTestResult }),
  /** A generic webhook's logo or favicon, versioned like app icons. */
  "integrations.webhooks.icon": ep({ method: "GET", path: `${V1}/integrations/webhooks/:id/icon`, params: IdParams, query: Ic.IconQuery, kind: "file" }),
  "integrations.email.connect": ep({ method: "PUT", path: `${V1}/integrations/email`, body: I.EmailConnectBody, response: I.EmailIntegration }),
  "integrations.email.delete": ep({ method: "DELETE", path: `${V1}/integrations/email`, kind: "none" }),
  "integrations.email.test": ep({ method: "POST", path: `${V1}/integrations/email/test`, body: I.EmailTestBody, response: I.EmailTestResult }),

  // ---------------------------------------------------------------- resources, domains
  "resources.list": ep({ method: "GET", path: `${V1}/resources`, response: list(R.ResourceRow) }),
  "resources.create": ep({ method: "POST", path: `${V1}/resources`, body: R.CreateResourceBody, response: R.ResourceRow, status: 201 }),
  "domains.list": ep({ method: "GET", path: `${V1}/domains`, response: R.DomainsPayload }),
  "domains.create": ep({ method: "POST", path: `${V1}/domains`, body: R.CreateDomainBody, response: R.DomainRow, status: 201 }),
  "domains.test.offer": ep({ method: "GET", path: `${V1}/domains/test-domain`, response: R.TestDomainOffer }),
  "domains.test.create": ep({ method: "POST", path: `${V1}/domains/test-domain`, body: R.CreateTestDomainBody, response: R.DomainRow, status: 201 }),
  "domains.check": ep({ method: "POST", path: `${V1}/domains/:id/check`, params: IdParams, body: EmptyBody, response: R.DomainRow }),
  "domains.delete": ep({ method: "DELETE", path: `${V1}/domains/:id`, params: IdParams, query: R.DeleteDomainQuery, kind: "none" }),

  // ---------------------------------------------------------------- server, updates
  "server.get": ep({ method: "GET", path: `${V1}/server`, response: S.ServerSnapshot }),
  "server.metrics": ep({ method: "GET", path: `${V1}/server/metrics`, query: S.MetricsQuery, response: S.ServerMetrics }),
  "server.prune": ep({ method: "POST", path: `${V1}/server/prune`, body: S.PruneBody, response: S.PruneResult }),
  "server.updates": ep({ method: "GET", path: `${V1}/server/updates`, response: S.UpdateStatus }),
  "server.updates.check": ep({ method: "POST", path: `${V1}/server/updates/check`, body: EmptyBody, response: S.UpdateStatus }),
  "server.updates.apply": ep({ method: "POST", path: `${V1}/server/updates/apply`, body: S.ApplyUpdateBody, response: S.UpdateJob }),
  "server.updates.rollback": ep({ method: "POST", path: `${V1}/server/updates/rollback`, body: S.RollbackUpdateBody, response: S.UpdateJob }),
  "server.updates.skip": ep({ method: "POST", path: `${V1}/server/updates/skip`, body: S.SkipUpdateBody, response: S.UpdateStatus }),
  "server.updates.pause": ep({ method: "POST", path: `${V1}/server/updates/pause`, body: S.PauseUpdatesBody, response: S.UpdateStatus }),
  "server.updates.policy": ep({ method: "PUT", path: `${V1}/server/updates/policy`, body: S.UpdatePolicyBody, response: S.UpdateStatus }),
  /** The pending security release for the console's banner and popup, with this member's reminder. */
  "server.updates.security": ep({ method: "GET", path: `${V1}/server/updates/security`, response: Sec.SecurityAlert }),
  /** "Remind me in" 1, 3 or 7 days for this member, capped by the release's level. */
  "server.updates.security.snooze": ep({ method: "POST", path: `${V1}/server/updates/security/snooze`, body: Sec.SecuritySnoozeBody, response: Sec.SecurityAlert }),

  // ---------------------------------------------------------------- backups
  "backups.list": ep({ method: "GET", path: `${V1}/backups`, response: list(B.BackupRun) }),
  "backups.schedules": ep({ method: "GET", path: `${V1}/backups/schedules`, response: list(B.BackupSchedule) }),
  "backups.config": ep({ method: "GET", path: `${V1}/backups/config`, response: B.BackupConfig }),
  "backups.schedules.patch": ep({ method: "PATCH", path: `${V1}/backups/schedules/:id`, params: IdParams, body: B.SchedulePatchBody, response: B.BackupSchedule }),
  "backups.run": ep({ method: "POST", path: `${V1}/backups/run`, body: B.RunBackupsBody, response: B.RunBackupsResponse }),
  "backups.restore": ep({ method: "POST", path: `${V1}/backups/:id/restore`, params: IdParams, body: B.RestoreBody, response: B.RestoreResponse }),
  "backups.restoreStatus": ep({ method: "GET", path: `${V1}/backups/:id/restore/:jobId`, params: B.RestoreStatusParams, response: B.RestoreStatus }),
  "backups.test": ep({ method: "POST", path: `${V1}/backups/:id/test`, params: IdParams, body: EmptyBody, response: B.BackupRun }),
  "backups.orphans.delete": ep({ method: "DELETE", path: `${V1}/backups/orphans/:resourceId`, params: B.OrphanParams, body: EmptyBody, response: B.OrphanDeleteResult }),
  "backups.download": ep({ method: "GET", path: `${V1}/backups/:id/download`, params: IdParams, kind: "file" }),

  // ---------------------------------------------------------------- alerts
  "alerts.get": ep({ method: "GET", path: `${V1}/alerts`, response: S.AlertsPayload }),
  "alerts.rules.create": ep({ method: "POST", path: `${V1}/alerts/rules`, body: S.RuleBody, response: S.AlertRule }),
  "alerts.rules.patch": ep({ method: "PATCH", path: `${V1}/alerts/rules/:id`, params: IdParams, body: S.RulePatchBody, response: S.AlertRule }),
  "alerts.rules.delete": ep({ method: "DELETE", path: `${V1}/alerts/rules/:id`, params: IdParams, kind: "none" }),
  "alerts.mutes.put": ep({ method: "PUT", path: `${V1}/alerts/mutes/:appId`, params: S.MuteParams, body: S.MuteBody, response: S.AlertMute }),
  "alerts.mutes.delete": ep({ method: "DELETE", path: `${V1}/alerts/mutes/:appId`, params: S.MuteParams, kind: "none" }),

  // ---------------------------------------------------------------- runtime logs
  "logs.query": ep({ method: "GET", path: `${V1}/logs`, query: S.LogsQuery, response: S.LogPage }),
  "logs.stream": ep({ method: "GET", path: `${V1}/logs/stream`, query: S.LogStreamQuery, kind: "stream" }),

  // ---------------------------------------------------------------- public and inbound
  "public.status": ep({ method: "GET", path: `${V1}/public/status/:slug`, params: S.PublicStatusParams, response: S.PublicStatus }),
  "webhooks.github": ep({ method: "POST", path: `${V1}/webhooks/github`, body: z.unknown(), kind: "none", status: 202 }),
  /** Vercel's deployment events, signed with x-vercel-signature. Only ever triggers a mirror sync. */
  "webhooks.vercel": ep({ method: "POST", path: `${V1}/webhooks/vercel`, body: z.unknown(), kind: "none", status: 202 }),
} as const satisfies Record<string, EndpointDef>;

export type Endpoints = typeof endpoints;
export type EndpointId = keyof Endpoints;
export const endpointIds = Object.keys(endpoints) as EndpointId[];

/**
 * Endpoints taken out on purpose, kept here so a test stops anyone from adding them back unreviewed.
 * resources.connection read a service's credentials in the clear; apps now get them through env
 * references (env-refs.ts), resolved at deploy time, and a person sees one only through env.reveal.
 */
export const removedEndpoints = [
  { id: "resources.connection", method: "GET", path: `${V1}/resources/:id/connection` },
  // Erasing the server is `sudo dockify admin factory-reset`, over SSH only: no web session may ever reach it.
  { id: "settings.reset", method: "POST", path: `${V1}/settings/reset` },
] as const satisfies ReadonlyArray<{ id: string; method: Method; path: string }>;

type Infer<T> = T extends z.ZodType ? z.infer<T> : never;
type InferIn<T> = T extends z.ZodType ? z.input<T> : never;
/** Request and response types per endpoint, for typed clients and handlers. */
export type BodyOf<K extends EndpointId> = Endpoints[K] extends { body: infer B } ? Infer<B> : undefined;
export type BodyInputOf<K extends EndpointId> = Endpoints[K] extends { body: infer B } ? InferIn<B> : undefined;
export type QueryOf<K extends EndpointId> = Endpoints[K] extends { query: infer Q } ? Infer<Q> : undefined;
export type ParamsOf<K extends EndpointId> = Endpoints[K] extends { params: infer P } ? Infer<P> : undefined;
export type ResponseOf<K extends EndpointId> = Endpoints[K] extends { response: infer R } ? Infer<R> : undefined;

