# Architecture

One server, one control plane. The browser talks to `web` (Next.js), `web` talks to `api`, the
same hostname sends `/api/v1/` to `api` directly (tokens and webhooks), and every slow or privileged
action is a row on the jobs table that `worker` claims. The worker runs Docker work through `agent`.

```
browser -> cloudflared or Traefik -> web -> api ----> Postgres (jobs, secrets, everything)
                                  /api/v1/ -> api        ^
                                               ^         |
                                  internal secrets routes |
                                               |         |
          worker ---------- pinned link -------+---------+
             |
             +-- agent -- gate -- socket proxy -- Docker
                   |-- BuildKit socket, Traefik files
          updater (the update lane: signed self_update jobs only) -- Docker socket
```

## Trust boundary: who holds the master key

Only the api holds `DOCKIFY_MASTER_KEY`. It is the one process that
can seal and open rows of the `secrets` table, and it is the only container the compose file
mounts `secrets/master_key` into. The worker, the agent, the updater, the web and the migrate step
hold no key, so compromising any of them yields ciphertext and nothing that opens it offline. Online
is another matter: see "The agent and the gate".

The worker still needs plaintext to do its jobs (an app's env for a deploy, a registry password
for a pull, the Cloudflare token, the backup key). It gets each value from the api's
secret-opening routes, over the `control` network, and nothing else:

- `POST /internal/secrets/open { ids, context }` answers with the plaintext of exactly the rows
  named. The api refuses kinds the worker never needs (TOTP seeds, env versions, webhook
  secrets: `WORKER_OPEN_KINDS` in `apps/api/src/internal/secrets.ts`), checks that the job the
  worker says it is running is claimed and still leased (`JOB_NOT_LIVE` otherwise) and of the
  kind named, and writes one `secret.open` activity row per call with the job id or timer name
  and the kinds opened. A refused call is audited as failed.
- `POST /internal/secrets/seal` seals a deployment's env snapshot or the instance backup key
  (`WORKER_SEAL_KINDS`), with the row id in the AAD; the worker inserts the row inside its own
  transaction.
- `POST /internal/secrets/escrow` returns the backup key sealed in the escrow file format
  (`packages/crypto/src/escrow.ts`) so the worker can upload it beside the dumps without ever
  seeing the master key. Only a `backup_key` row can be escrowed.

Authentication is the internal channel token (`secrets/internal_token`, the same shared secret
the api presents on the worker's data channel) as a bearer, compared in constant time, from a
pinned socket peer (`DOCKIFY_INTERNAL_PEERS`, the worker's fixed control address). These routes
have the policy `internal`: no cookie is read, no session or API token is accepted, and the
browser rate limiter does not apply. Every other route refuses the internal token.

On the worker side the only way to a secret is the `SecretVault` interface
(`packages/db`): `storeSecret`, `readSecretValue` and `readSecretValues` take either a keyring
(the api) or a vault, and the worker's `createRemoteVault` (`apps/worker/src/vault.ts`) is the
remote one. The running job rides along in an `AsyncLocalStorage` so the api can bind each open
to it; periodic work names itself (`timer:janitor`). `apps/worker/src/vault.test.ts` fails if any
worker source loads a keyring or the compose file mounts the key into it.

Recovery after a lost server: `openBackupKeyEscrow` in `@dockify/crypto` opens the escrowed
backup key with the master key (or a previous one), on a host that holds that key, never in a
tenant-facing process.

## Contracts first

`packages/contracts/src/endpoints.ts` lists every route the web calls with its zod schemas.
`apps/api/src/policy.ts` gives each one a policy, and the type `Record<EndpointId, Policy>` means
a contract cannot exist without one. `buildApp` registers routes from the catalog only, so a route
cannot exist without a contract. Tests check that every endpoint is registered with its policy and
that every endpoint has a handler except a reviewed `UNBUILT` list in `policy.test.ts`.

## api (`apps/api`)

- `app.ts` holds the one enforcing hook (headers, client address, rate limit, CSRF, policy) and
  merges the module handler tables through `moduleHandlers()`, which fails at boot if two modules
  claim one endpoint. Modules live in `src/modules/<name>`: projects, apps, deployments, domains,
  backups, data, observe, platform, integrations.
- The integrations module mounts itself as a plugin (`PLUGIN_OWNED`) because the GitHub webhook
  needs the raw body for its signature check. Its routes use the same policy table.
- A handler may set another success status (a long restore answers 202 with its job).
- Deploys have one entry point: `requestDeployTx` in `modules/deployments/enqueue.ts`. A click
  gets 409 while a deploy is in flight; a push or env change sets `pendingDeployAt` instead.

## worker (`apps/worker`)

- `queue.ts` claims with `FOR UPDATE SKIP LOCKED` and a lease, one loop per lane (deploy, data,
  maintenance). The `update` lane belongs to the updater and is never claimed here.
- `wiring.ts` builds the job table from every module (deploy, edge, data, observe, integrations,
  teardown) and the timers (data tick, DNS and reconcile every 15 minutes, janitor every 6 hours,
  heartbeat, observe loops). A test fails if a job kind has no handler and is not listed in
  `UNHANDLED_KINDS`.
- `errors.ts#isPermanentError` is the one "do not retry" test.
- Every container is built by `containerSpec()` and checked by `assertSafeSpec()` on the exact
  body sent. Tenant networks get a `dk-` bridge name so the host firewall rule matches them.
- Traefik routes have one writer, `edge/routes.ts`; the deploy swap calls it through
  `deploy/routes.ts`. Traefik watches exactly `proxy/conf/` (its watcher does not see subfolders);
  the agent stages in `proxy/.staging/` on the same mount and renames into it (`route-store`, in
  `packages/engine`), after `apps/agent/src/routes.ts` validates the file. A route names its
  container by DNS, `dk-route-<deployment id>` (an alias only that container holds), never by
  address, so a reboot that hands out new addresses cannot misroute it. A domain is routed only
  once it points at this server: its DNS names it, or, behind a proxy such as Cloudflare's,
  asking the domain itself reaches it (`edge/probe.ts`; Traefik sends
  `/.well-known/dockify-check/` on every host to the api, which answers only a domain's own
  token). The worker owns the dashboard's routers too (`conf/__dashboard.yml`) and the probe's
  catch-all routers (`conf/__edge.yml`), in direct mode.
- Start-up (`boot.ts`, `main.ts`): system routes first (files only), then the database and Docker
  waited for with backoff, then every route resynced against the live containers, then the work
  folder check. A work folder the worker cannot write is a health issue (`health.ts`): reported
  with the heartbeat (the Server page's Worker row and the service alert show it), and only the
  jobs that stage files there (backups, restores, restore tests) fail, at once, with how to fix
  it. Docker start events of Dockify's own containers queue a route sync, and the 15 minute
  reconcile syncs every app's route again.
- The data browser channel listens on the control network address only.
- Outbound calls from the api to GitHub, Vercel, Cloudflare and registries, and to alert channels, go through
  `@dockify/net-guard`: one SSRF rule (`packages/net-guard`), checked inside the socket's own DNS
  lookup, https only, redirects never followed. The api's at-rest host checks use the same
  package. The exceptions: the domain ownership probe asks a domain over http and follows one
  redirect to https on the same name and path, through the guarded lookup; a webhook logo follows
  checked redirects (`getFollowing`); S3 checks the address first (`assertPublicHost`); the worker's
  own GitHub and Cloudflare API calls go to fixed hosts with plain fetch. Log redaction for deploy and runtime logs is `@dockify/redact`,
  one module.

## The agent and the gate (`apps/agent`)

The worker holds no `docker-api` network, BuildKit socket or `proxy/` mount: `server/runtime` is built
from `link/remote.ts`, and the agent does the work. On the primary it dials the worker's listener over
the `link` network; TLS 1.3 with a pinned key runs inside that connection. Second servers are not offered yet.

- `docker-gate.ts` parses each request, refuses what the rules do not name, and sends on only a
  canonical copy of what it checked. `deploy/socket-proxy/haproxy.cfg` then allows the exact
  method-and-path pairs and denies the rest; `socket-proxy.test.ts` keeps the two in step.
  Haproxy reads no bodies.
- `registry-host.ts` refuses a pull from loopback, metadata or control addresses written in the
  reference. It cannot see a DNS answer; the api refuses one when the image is stored
  (`registryHostProblem`, on create and `apps.patch`), and dockerd resolves again at the pull.
- **What a compromise is worth.** The worker: no host root through the gate, but Postgres as superuser
  and the internal token, so every tenant's secrets, any image inside tenant limits, any tenant volume,
  exec, and code in the Postgres container. The agent: **code running in its process is host root**,
  because the gate is a function in it and haproxy reads no bodies (open by
  design). The updater holds the raw socket.

## Self-update (`apps/api/src/modules/platform/updates`)

Every install updates itself from static, signed files only; nothing phones home. Releasing is in
`docs/RELEASING.md`; the user-facing story is `apps/site/content/docs/updates.mdx`.

- **Feed.** `<feed>/releases/<channel>.json` plus `.minisig`, one file per channel listing every
  release (version, date, per-architecture image digests for control and web, `minFrom`, the
  migration id, notes URL, markdown notes, `critical`). `release.ts#verifyFeed` checks the minisign
  signature against the pinned key before it parses a byte, requires the trusted comment to name
  the channel and the newest version, and refuses tags, extra keys, unsorted or duplicate
  versions. The key baked into the control image (`deploy/release.pub`, `DOCKIFY_PINNED_PUBKEY`)
  wins over the installer's copy in `.env`. Fetches go through `@dockify/net-guard` (https only,
  no redirects, public addresses only). An older signed feed than the last one accepted is a
  replay and is refused (`instance.updateFeedSeenAt`).
- **One lane, leased.** The api enqueues `self_update` jobs on the `update` lane (`engine.ts`
  `beginApply`, `beginRollback`); only the updater sidecar claims that lane, with a 2 minute lease
  renewed every 30 s. A lapsed lease is taken over and the job resumes from its journal (the
  `release_updates` row, rewritten whole after every transition by `dbRecorder`). Past 3 attempts a
  takeover settles through a rollback instead of running again.
- **Steps** (`runner.ts`): preflight (database answers, no deploy, backup or restore holds a lease,
  free disk for three times the database plus 2 GiB; a busy server waits, without spending an
  attempt, up to 2 hours), pull by digest and check the pulled `RepoDigests`, stop api and worker,
  `pg_dump` with its sha256 recorded, migrations in a one-off `migrate` container, then api, worker
  and web recreated one at a time (api `/readyz`, worker heartbeat newer than the swap, web
  container health), then all three again. Any failure from the backup on rolls back to the
  journaled previous digests, restoring the dump (checksum verified first) once the migration has
  started. `release_updates` rows and `update.*` audit rows are carried across a restore.
- **The host helper** is the `updater` service, the one process besides the agent that reaches Docker: it holds the raw socket and the install folder,
  never the master key, and never recreates itself mid-job. After a successful update a one-off
  `updater-refresh` container moves it onto the new image. `dockify update status | check | apply
  [version] | rollback [update-id]` (the installer's wrapper) runs the same code in a one-off
  updater container, so it works when the dashboard does not.
- **By hand**: `dockify redeploy` recreates the services on the images `release/release.env` pins
  the way an update does, migrations first (nothing is recreated if they fail), then api, worker
  and web one at a time, each waited for, then the updater. A new `docker-compose.yml`, socket
  proxy allowlist, firewall rule or one-time fix for older installs comes with
  `sudo bash install.sh --upgrade`, which backs up the files it changes and the database, runs
  migrate first, then recreates each service; the updater itself refuses a compose file that
  differs from the one installed.
- **Policy** (`policy.ts`, Settings, Instance, Updates): manual, security only, or all stable
  releases (the default), a maintenance window in the instance time zone, the channel, skip a
  version, pause 7 days. The scheduler tick checks every 6 hours plus up to an hour of jitter.
- **After a job:** an `update_notify` job (worker: email to admins and Discord, when configured),
  the bell notices derived from the same rows (`notices.ts`, `overview.system`), and the dump
  copied offsite as a `control_plane` backup (worker `copyControlPlaneDump`). Dumps are kept 8
  days; "Roll back to vX" is offered for the last update within 7 days.

## Database (`packages/db`)

- `prisma/schema.prisma`, the squashed `0001_init` migration (the generated SQL followed by a
  hand-written invariants block of CHECK constraints), then forward migrations named `NNNN_name`.
  A migration that has shipped is never edited; a change is a new one.
- `src/migration.test.ts` replays the forward migrations onto the init statements with no
  database and fails on any difference from the SQL Prisma generates from the schema (drift).
  `pnpm db:drift` repeats the check against a shadow database.
- `enqueue` and `enqueueTx` are shared by the api and the worker: one dedupe rule.
- Secrets are sealed per value in the `secrets` table; the master key never enters the database.

## Pull request previews

A preview is the ephemeral environment `pr-<n>` cloned from the project's base environment
(default development). The webhook (`api/modules/previews/webhook.ts`) writes a `PreviewEnv` row
and one `PreviewDeployment` per included app under one server-wide advisory lock that also holds
the caps, the disk guard and the DNS gate, then queues deploys with `trigger: "preview"`. The deploy
pipeline runs those through `worker/src/deploy/preview.ts`: own container and route file
(`pv-<id>`), preview limits, no volume, never the app row. The worker is the only writer of the PR
comment and commit status (`preview_feedback`), of teardown (`preview_cleanup`, which also prunes
the preview's images), wake (`preview_wake`) and the wildcard DNS record (`preview_dns`). A timer
runs `reconcilePreviews` every three minutes: TTL, disabled and orphaned previews go, idle ones
sleep (Traefik request counters), and any container or route labelled as a preview without a live
row is removed. Preview domains: project override, else `Instance.previewDomain`, else
`preview.<parent of the dashboard host>`.

## Open items

- Unbuilt endpoints: see `UNBUILT` in `apps/api/src/policy.test.ts`.
- Job kinds with no producer or handler: `cancel_deploy`, `factory_reset` (the reset is `sudo dockify admin factory-reset`, over SSH only).
- The GitHub install state store is in memory; the `oauth_states` table is ready for it.
- `git.app.callback` (manifest code exchange) and status page incidents have no endpoints yet.
- An env scope check across tables (an app scope row in another project) is enforced only in the
  projects module; Postgres CHECK constraints cannot see other tables.
- The agent path has run on one real box only, and a second server not at all.

## Web terminal

`browser -> WebSocket -> api -> framed socket on the worker's control-network channel -> link -> agent -> gate -> socket proxy -> exec in dk-<app id>`. The api gains no Docker access. The elevated `apps.terminal.ticket` route issues a single-use ticket held only as a hash in the api's memory, bound to session, app and client (`modules/terminal/tickets.ts`). The upgrade (`modules/terminal/gateway.ts`) sits outside Fastify's request hook, so it repeats the session, role, origin and rate checks by calling the same functions; the ticket is the socket's first message and never in a URL. An open session is re-checked every 10 seconds. The worker (`apps/worker/src/terminal/session.ts`) takes only an app id, derives the name, checks what Docker reports (name, labels, namespaces), creates the exec, compares the exec's container id with the one it checked, and only then starts it. The command is a constant. Docker cannot end an exec, so a close signals the shell by the pid it reported, after asking Docker that this exec still runs.

## Preview access

Every preview router carries a forwardAuth middleware to the api (`worker edge/routes.ts gateParts`, `api modules/previews/gate.ts`), public or not: the setting is read on the request, cached 5 seconds, so a change needs no route rewrite and no preview can be served unasked. `/internal/preview-gate/<id>` is outside the public prefix. A non-2xx answer goes straight to the visitor, which is how the password page is served. The form has its own router on the preview's host, with the id fixed by replacePath. The reconcile rewrites routes made before the gate.

## The dashboard's address

`DOCKIFY_PUBLIC_URL` in the root-owned `.env` is the one source of the address; cookies, the CSRF origin and every link derive from it at boot. Three things can move it, and the api's boot records all three (`apps/api/src/boot.ts`): the old host joins `instance.dashboardPreviousHosts` and the change goes in `dashboardLastChange`.

- Settings: the worker checks the new domain (`apps/worker/src/edge/dashboard.ts`, the same DNS, probe and TLS reads as an app's domain) and only then gives the updater a `dashboard_domain_apply` job. The updater, the one process that holds the Docker socket and outlives what it recreates, rewrites `.env` as root in a throwaway container with no network and only CAP_CHOWN (`updates/env-file.ts`), then recreates api, worker and web, and goes back if they do not all come up (`updates/domain-switch.ts`).
- `sudo dockify admin set-domain <host>`: the wrapper does the same on the host, without the checks, as the way back in.
- `.env` by hand.

A host the dashboard left keeps a route (`__dashboard-old.yml`): `/api/v1/` is served, because GitHub does not follow a redirect for a webhook, and the rest redirects. Until the switch, the new host answers only the probe's path (`__dashboard-next.yml`), so nobody can sign in on it early. Tenants can claim neither.
