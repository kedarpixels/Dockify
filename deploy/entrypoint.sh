#!/bin/sh
# Role dispatch for the control image: api, worker, agent, migrate, updater, updater-refresh, update, admin.
# admin is host-only account rescue, run inside the running api container by the host wrapper:
# dockify admin disable-mfa|reset-password|revoke-sessions <email>, reset-link, rewrap-secrets. set-domain is the wrapper's own.
set -eu

# Secrets arrive as files (compose secrets). The database URL is assembled here because Prisma
# reads only DATABASE_URL. The generated password is hex, so it needs no URL escaping.
if [ -z "${DATABASE_URL:-}" ] && [ -n "${DOCKIFY_DB_PASSWORD_FILE:-}" ]; then
  DATABASE_URL="postgresql://dockify:$(cat "$DOCKIFY_DB_PASSWORD_FILE")@${DOCKIFY_DB_HOST:-postgres}:5432/dockify"
  export DATABASE_URL
fi

# The image's pinned release key (deploy/release.pub), when the release baked one in.
if [ -z "${DOCKIFY_PINNED_PUBKEY:-}" ] && [ -r /etc/dockify/release.pub ]; then
  k="$(grep -v '^untrusted comment:' /etc/dockify/release.pub | tr -d ' \r' | grep -v '^$' | tail -n 1 || true)"
  if [ -n "$k" ]; then DOCKIFY_PINNED_PUBKEY="$k"; export DOCKIFY_PINNED_PUBKEY; fi
fi

cd /app
case "${1:-api}" in
  api)     exec node apps/api/src/main.ts ;;
  worker)  exec node apps/worker/src/main.ts ;;
  # One per server: the narrow gate in front of its Docker. Reads no database and holds no secret.
  agent)   exec node apps/agent/src/main.ts ;;
  migrate) exec /opt/prisma/node_modules/.bin/prisma migrate deploy --schema packages/db/prisma/schema.prisma ;;
  updater) exec node apps/api/src/modules/platform/updates/main.ts daemon ;;
  # One-off, from a separate container: recreate the updater on the newly pinned image.
  updater-refresh) exec node apps/api/src/modules/platform/updates/main.ts refresh ;;
  # The host CLI: dockify update status | check | apply [version] | rollback [update-id]
  update)  shift; exec node apps/api/src/modules/platform/updates/main.ts cli "$@" ;;
  admin)   shift; exec node apps/api/src/admin.ts "$@" ;;
  *) echo "unknown role: $1 (api, worker, agent, migrate, updater, updater-refresh, update, admin)" >&2; exit 64 ;;
esac
