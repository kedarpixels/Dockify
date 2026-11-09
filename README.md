# Dockify

Self-hosted deploys for one server: projects hold environments, environments hold apps
(services, Postgres, Redis), each with domains, env vars, backups and logs.

Docs: https://dockify.sh/docs

## What it supports

- One server per install, on Ubuntu 22.04 or 24.04. More servers are not supported yet.
- Apps from a Git repository (a Dockerfile or Railpack), a Docker image, or a pasted
  docker-compose.yml.
- Managed Postgres and Redis, with scheduled backups.
- Six app templates: Gotify, ntfy, Memos, SeaweedFS, Uptime Kuma and Miniflux.

## Install

On a fresh server, as root or a user with sudo:

```
curl -fsSL https://dockify.sh/install.sh | sh
```

Dockify 1.0 is released. The command installs the newest signed release: it checks the feed signature against the pinned key, then pulls the images by digest.
`--dry-run` shows what it would do: `curl -fsSL https://dockify.sh/install.sh | sh -s -- --dry-run`.
Every flag is in [the install docs](https://dockify.sh/docs/install).

## Build from source

Requires Node 22.18 or newer and pnpm 11.

```
pnpm install
cp .env.example .env            # then set DOCKIFY_MASTER_KEY (openssl rand -base64 32)
pnpm typecheck
pnpm test
```

Tests that need Postgres run only when `DATABASE_URL_TEST` points at a scratch database with the
migrations applied. The root `docker-compose.yml` starts one for local development:

```
docker compose up -d postgres
DATABASE_URL=postgresql://dockify:dockify-local-dev@127.0.0.1:55432/dockify pnpm db:migrate
DATABASE_URL_TEST=postgresql://dockify:dockify-local-dev@127.0.0.1:55432/dockify pnpm test
```

The dashboard (`apps/web`) and the site (`apps/site`) are not workspace members: run
`pnpm install --ignore-workspace` in `apps/web` and `npm ci` in `apps/site`. The production image
is `deploy/Dockerfile` and the stack it runs is `deploy/docker-compose.yml`.

How the pieces fit: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Contributing:
[.github/CONTRIBUTING.md](.github/CONTRIBUTING.md). Report a vulnerability as
[.github/SECURITY.md](.github/SECURITY.md) says.

## License

Apache 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE).
