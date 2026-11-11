#!/usr/bin/env bash
# Dockify installer for a fresh Ubuntu server (22.04 or 24.04), as root:
#
#   curl -fsSL https://dockify.sh/install.sh | sh
#
# That one-liner fetches installer/bootstrap.sh, which verifies this file by SHA-256 and runs it as
# root. Run directly, it is:  sudo bash install.sh [--domain dockify.example.com]
#
# No domain is needed to try it. Press Enter at the prompt (or attach no terminal) and the dashboard
# starts at a temporary address, https://<server-ip-with-dashes>.sslip.io, with a real certificate, in
# direct mode. For real use, move to your own domain in Settings, Instance, or with:
# sudo dockify admin set-domain <host>
#
# What it does, in order:
#   1. preflight: Ubuntu, root, architecture, free ports, existing install
#   2. host hardening: unattended security upgrades, ufw (ssh, plus 80/443 in direct mode)
#   3. Docker Engine from Docker's signed apt repository, if missing
#   4. refuses a runc or containerd with known container-escape bugs
#   5. a DOCKER-USER rule that drops container traffic to cloud metadata addresses, and an INPUT
#      rule that drops tenant bridges (dk-*) reaching the host, except the control plane's own
#      deploy bridge on 80 and 443 only, kept across reboots by systemd. Where the kernel restricts
#      user namespaces (Ubuntu 24.04), an AppArmor profile so rootless BuildKit can create its own
#      (dockify-buildkit, for that container only)
#   6. the signed release: the static feed (<feed>/releases/stable.json), its minisign signature
#      checked with openssl against the pinned key before it is parsed, images by per-architecture digest
#   7. ingress: direct mode, or a NEW uniquely named Cloudflare tunnel (never an existing one)
#   8. .env, release.env and secrets/ with generated values, then starts the stack. On a volume an
#      earlier install kept, the secrets come from that install's backup in /root instead
#   9. waits for readiness and prints the setup URL and the one-time setup token
#
# Flags:
#   --domain HOST            dashboard hostname. Omitted: asked for on the terminal; Enter, or no
#                            terminal, starts on <server-ip-with-dashes>.sslip.io in direct mode
#   --ingress tunnel|direct  how the server is reached. Default: tunnel with --domain, asked for on the
#                            terminal when you type a domain, direct on sslip.io
#   --cf-token-file PATH     Cloudflare API token (Zone:DNS:Edit, Account:Cloudflare Tunnel:Edit);
#                            prompted for when omitted and a terminal is attached
#   --cf-account-id ID       required when the token sees more than one account
#   --replace-dns            allow replacing an existing CNAME for --domain (never other types)
#   --acme-email EMAIL       Let's Encrypt account (direct mode). Omitted: asked for on the terminal;
#                            Enter, or no terminal, registers dockify@<the dashboard host>
#   --dir PATH               install folder, default /opt/dockify
#   --release-feed URL       signed feed base, https; the manifest is URL/releases/stable.json
#                            (default: DOCKIFY_DEFAULT_FEED below, the repository's releases branch)
#   --release-pubkey KEY     minisign public key, base64 line (default: the pinned key below)
#   --control-image REF --web-image REF
#                            skip the feed and run these digest-pinned images (self-update stays
#                            available only when a feed and key are also given)
#   --no-ufw                 leave the host firewall alone
#   --allow-vulnerable-runtime  warn instead of refusing on an old runc or containerd
#   --from-checkout          take docker-compose.yml and the socket proxy config from the repository
#                            this script sits in, which must be root's alone; without it they only
#                            ever come from the signed feed
#   --dry-run                print what would happen and change nothing
#   --upgrade                upgrade the install in --dir in place instead of installing: the new
#                            docker-compose.yml and socket proxy config (from the signed feed, or
#                            --from-checkout), the container firewall rules, the one-time fixes an older
#                            install needs, migrations first, then each service recreated and
#                            waited for. With --control-image/--web-image (or a feed) it also moves
#                            to those images; images from the feed also set DOCKIFY_RELEASE_FEED and
#                            DOCKIFY_RELEASE_PUBKEY in .env to the feed and key that checked them, so
#                            the dashboard's updates follow them. Takes --cf-token-file to add the
#                            dashboard's api rule to a tunnel made before it existed. Nothing else in
#                            .env or secrets/
#                            changes, and the previous files are kept in upgrade-backups/, the last
#                            three upgrades' worth.
#
# Optional integrations, read from the environment on the first install only (each also settable
# later in Settings). Keys and private keys go into secrets/, never into .env:
#   DOCKIFY_SMTP_HOST, DOCKIFY_SMTP_PORT (default 587), DOCKIFY_SMTP_USER, DOCKIFY_SMTP_PASSWORD or
#   DOCKIFY_SMTP_PASSWORD_FILE (a file on this host), DOCKIFY_EMAIL_FROM, DOCKIFY_EMAIL_FROM_NAME
#                            email through your mail server, so setup can verify the owner
#   DOCKIFY_GITHUB_APP_ID, DOCKIFY_GITHUB_APP_SLUG, DOCKIFY_GITHUB_APP_PRIVATE_KEY_FILE (a PEM
#   file on this host), DOCKIFY_GITHUB_WEBHOOK_SECRET or DOCKIFY_GITHUB_WEBHOOK_SECRET_FILE
#                            an existing GitHub App for this instance; all four or none
set -euo pipefail
umask 077

# Pinned at release time (docs/RELEASING.md, key ceremony). The key must equal deploy/release.pub;
# the release workflow refuses to publish when they differ. An empty key means: pass
# --release-pubkey or --control-image/--web-image. The feed is static files only: the raw
# `releases` branch of the repository, or the same bytes mirrored at https://dockify.sh.
DOCKIFY_DEFAULT_FEED="https://raw.githubusercontent.com/kedarpixels/Dockify/releases"
DOCKIFY_DEFAULT_PUBKEY="RWQMt8NepFW/8+8stTUCxZiJZRx6me6P7D9/KZOPpQOy5txCetMlolRT"
DOCKER_GPG_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
CF_API="https://api.cloudflare.com/client/v4"

DOMAIN="" INGRESS="" CF_TOKEN_FILE="" CF_ACCOUNT_ID="" REPLACE_DNS=0 ACME_EMAIL=""
DIR="/opt/dockify" FEED="$DOCKIFY_DEFAULT_FEED" PUBKEY="$DOCKIFY_DEFAULT_PUBKEY"
CONTROL_IMAGE="" WEB_IMAGE="" UFW=1 ALLOW_VULN=0 DRY=0 UPGRADE=0 FROM_CHECKOUT=0

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\n\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }

# ------------------------------------------------------------------ helpers (also sourced by tests)

# Who owns what under the install folder. Root-equivalent tooling (the `dockify` wrapper, and the
# updater through the Docker socket) executes docker-compose.yml with .env, so those and the folder
# itself are root's; uid 1000 (the container user) only reads them through the group. The only
# paths uid 1000 may write: proxy/ (the agent's route files), buildkit/ (rootless BuildKit's socket: a
# folder Docker made for the bind mount would be root's, and the daemon could not start) and release/
# (release.env, which the updater rewrites atomically next to itself). Columns: kind mode owner:group path.
layout_plan() {
  cat <<EOF
dir 0750 0:1000 $1
dir 0750 1000:1000 $1/proxy
dir 0750 1000:1000 $1/buildkit
dir 0750 1000:1000 $1/release
dir 0750 0:1000 $1/secrets
dir 0750 0:1000 $1/socket-proxy
file 0640 0:1000 $1/socket-proxy/haproxy.cfg
file 0440 0:1000 $1/secrets/master_key
file 0440 0:1000 $1/secrets/master_key_previous
file 0440 0:1000 $1/secrets/postgres_password
file 0440 0:1000 $1/secrets/setup_token
file 0440 0:1000 $1/secrets/internal_token
file 0440 0:1000 $1/secrets/link_key
file 0440 0:1000 $1/secrets/link_cert
file 0440 0:1000 $1/secrets/primary_join_token
file 0440 0:1000 $1/secrets/cf_dns_token
file 0440 0:1000 $1/secrets/smtp_password
file 0440 0:1000 $1/secrets/github_app_private_key
file 0440 0:1000 $1/secrets/github_webhook_secret
file 0640 0:1000 $1/docker-compose.yml
file 0640 0:1000 $1/.env
file 0600 1000:1000 $1/release/release.env
EOF
}
# $1 dir|file, $2 install folder. Folders are created; files must already be written.
apply_layout() {
  layout_plan "$2" | while read -r kind mode owner path; do
    [ "$kind" = "$1" ] || continue
    if [ "$kind" = dir ]; then install -d -m "$mode" -o "${owner%:*}" -g "${owner#*:}" "$path"
    else chown "$owner" "$path"; chmod "$mode" "$path"; fi
  done
}

# The root-run wrapper. $1 install folder, $2 the uid that must own it (0; tests pass their own).
# Before running compose it refuses anything a non-root user could have changed: the folder,
# docker-compose.yml and .env must be owned by that uid and not writable by group or others, and
# release.env (the one file the updater writes) may only pin the two Dockify images by digest, so
# it cannot override DOCKIFY_DIR, COMPOSE_PROFILES or any other variable the compose file reads.
render_wrapper() {
  cat <<EOF
#!/bin/sh
# Runs docker compose against the Dockify install in $1 with both env files, after checking that
# nothing a non-root user can write is about to be executed as root.
set -eu
D='$1'
R="\$D/release/release.env"
fail() { printf 'dockify: %s\n' "\$*" >&2; exit 1; }
chk() {
  for f in "\$@"; do
    if [ -L "\$f" ] || [ ! -e "\$f" ]; then fail "\$f is missing or a symlink"; fi
    o="\$(stat -c '%u' "\$f")"; m="\$(stat -c '%a' "\$f")"
    [ "\$o" = '$2' ] || fail "\$f must be owned by uid $2, found uid \$o; fix with: chown root \$f"
    case "\$m" in *[2367][0-7]|*[2367]) fail "\$f is writable by group or others (mode \$m); fix with: chmod go-w \$f" ;; esac
  done
}
# dockify uninstall [flags]: the uninstaller the installer shipped into the folder, after the same
# ownership checks, or the published one verified by its checksum when the folder has none. It
# runs before the other checks, so a half removed install can still be uninstalled.
if [ "\${1:-}" = uninstall ]; then
  shift
  U="\$D/uninstall.sh"
  if [ -e "\$U" ] || [ -L "\$U" ]; then chk "\$D" "\$U"; exec bash "\$U" --dir "\$D" "\$@"; fi
  T="\$(mktemp -d)"
  curl -fsSL --proto '=https' --tlsv1.2 https://dockify.sh/uninstaller.sh -o "\$T/u.sh" || fail "cannot download the uninstaller"
  curl -fsSL --proto '=https' --tlsv1.2 https://dockify.sh/uninstaller.sh.sha256 -o "\$T/u.sha256" || fail "cannot download the uninstaller checksum"
  [ "\$(cut -d' ' -f1 "\$T/u.sha256")" = "\$(sha256sum "\$T/u.sh" | cut -d' ' -f1)" ] || fail "uninstaller checksum mismatch, refusing to run it"
  exec bash "\$T/u.sh" --dir "\$D" "\$@"
fi
chk "\$D" "\$D/docker-compose.yml" "\$D/.env"
# Docker merges an image's labels into its container, so a tenant container made before the worker
# blanked them can claim to be a service here, and compose exec would run in it. Real services never
# carry dockify.managed. Account rescue and dumps must not trust what such a container says.
if [ "\${1:-}" = exec ] || [ "\${1:-}" = admin ]; then
  I="\$(docker ps -aq --filter label=dockify.managed=true --filter label=com.docker.compose.project=dockify)"
  [ -z "\$I" ] || fail "tenant containers carry Docker Compose's labels for this stack and could answer for its services: \$I. Redeploy their apps, or remove them with docker rm -f, then run this again"
fi
if [ -L "\$R" ] || [ ! -f "\$R" ]; then fail "\$R is missing or a symlink"; fi
if grep -Evq '^(#.*|DOCKIFY_(CONTROL|WEB)_IMAGE=[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64})?\$' "\$R"; then
  fail "\$R may only pin DOCKIFY_CONTROL_IMAGE and DOCKIFY_WEB_IMAGE by digest"
fi
if [ "\$(grep -c '^DOCKIFY_CONTROL_IMAGE=' "\$R")" != 1 ] || [ "\$(grep -c '^DOCKIFY_WEB_IMAGE=' "\$R")" != 1 ]; then
  fail "\$R must pin each image exactly once"
fi
# dockify update status | check | apply [version] | rollback [update-id]: the updater's CLI in a
# one-off updater container, so it works when the dashboard, or the updater service, does not.
if [ "\${1:-}" = update ]; then
  shift
  exec docker compose --project-directory "\$D" -f "\$D/docker-compose.yml" --env-file "\$D/.env" --env-file "\$R" run --rm --no-deps -T updater update "\$@"
fi
# dockify admin set-domain <host> | --sslip: moves the dashboard to this address, the way back in when
# the dashboard itself cannot be reached. Rewrites DOCKIFY_PUBLIC_URL in .env and recreates the three
# services that read it. The api's boot records the change, and the address it left keeps redirecting.
if [ "\${1:-}" = admin ] && [ "\${2:-}" = set-domain ]; then
  c() { docker compose --project-directory "\$D" -f "\$D/docker-compose.yml" --env-file "\$D/.env" --env-file "\$R" "\$@"; }
  H="\${3:-}"
  I="\$(sed -n 's/^DOCKIFY_INGRESS=//p' "\$D/.env" | tail -n 1)"
  if [ "\$H" = --sslip ]; then
    [ "\$I" != cloudflare_tunnel ] || fail "a Cloudflare tunnel only serves names on Cloudflare; give a hostname"
    A="\$(sed -n 's/^DOCKIFY_SERVER_IPV4=//p' "\$D/.env" | tail -n 1)"
    [ -n "\$A" ] || fail "DOCKIFY_SERVER_IPV4 is not in \$D/.env; give a hostname"
    H="\$(printf '%s' "\$A" | tr . -).sslip.io"
    printf 'Moving the dashboard to https://%s, the address a new install starts on.\n' "\$H"
  fi
  H="\$(printf '%s' "\$H" | tr '[:upper:]' '[:lower:]' | sed -e 's#^https\\{0,1\\}://##' -e 's#/.*\$##' -e 's#[.]\$##')"
  printf '%s' "\$H" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z]{2,63}\$' || fail "usage: dockify admin set-domain <host> | --sslip"
  # An app or a preview may hold the name. A dashboard that is down cannot say, which must not stop this.
  rc=0
  c exec -T api dockify-entrypoint admin check-domain "\$H" || rc=\$?
  [ "\$rc" != 2 ] || exit 2
  T="\$D/.env.tmp.\$\$"
  { grep -v '^DOCKIFY_PUBLIC_URL=' "\$D/.env"; printf 'DOCKIFY_PUBLIC_URL=https://%s\n' "\$H"; } > "\$T"
  chown --reference="\$D/.env" "\$T"
  chmod --reference="\$D/.env" "\$T"
  mv -f "\$T" "\$D/.env"
  for s in api worker web; do
    c up -d --no-deps --wait "\$s" || fail "\$s did not come up healthy (see: dockify logs \$s); DOCKIFY_PUBLIC_URL is now https://\$H in \$D/.env"
  done
  printf 'The dashboard now answers on https://%s\nEveryone signs in again there. The old address keeps redirecting.\n' "\$H"
  if [ "\$I" = cloudflare_tunnel ]; then
    printf 'In tunnel mode the worker adds the tunnel rules when Cloudflare is connected in Settings. If it is not, run: sudo bash install.sh --upgrade --cf-token-file <file>\n'
  else
    printf 'Its DNS must lead to this server for the certificate to be issued.\n'
  fi
  printf 'A connected GitHub App: check its URLs in Settings, Instance, or on github.com.\n'
  exit 0
fi
# dockify admin factory-reset [--delete-backups]: erases every app, database, domain and account and
# returns to first-run setup. On purpose the only way to do this: over SSH as root, typed, in a terminal.
# No web session, API token or job can ask for it, so a stolen dashboard login cannot erase the server.
if [ "\${1:-}" = admin ] && [ "\${2:-}" = factory-reset ]; then
  c() { docker compose --project-directory "\$D" -f "\$D/docker-compose.yml" --env-file "\$D/.env" --env-file "\$R" "\$@"; }
  [ "\$(id -u)" = 0 ] || fail "run it as root: sudo dockify admin factory-reset"
  K=0
  case "\${3:-}" in
    --delete-backups) [ "\$#" = 3 ] || fail "usage: dockify admin factory-reset [--delete-backups]"; K=1 ;;
    '') [ "\$#" = 2 ] || fail "usage: dockify admin factory-reset [--delete-backups]" ;;
    *) fail "usage: dockify admin factory-reset [--delete-backups]" ;;
  esac
  [ -t 0 ] || fail "this asks you to type a confirmation, so it needs a terminal"
  H="\$(sed -n 's#^DOCKIFY_PUBLIC_URL=https://##p' "\$D/.env" | tail -n 1 | sed 's#/.*\$##')"
  W="\${H:-factory-reset}"
  A="\$(docker ps -aq --filter label=dockify.managed=true | wc -l)"
  printf 'This erases this Dockify server and returns it to first-run setup:\n'
  printf '  %s app and database containers, and every volume they keep their data on\n' "\$A"
  printf '  every project, variable, secret, domain, deployment, user, token and integration in the control database\n'
  if [ "\$K" = 1 ]; then printf '  the backups kept on this server\n'; else printf 'It keeps the backups on this server (add --delete-backups to erase them) and anything in your S3 storage.\n'; fi
  printf 'It keeps Docker, the images, the master key, the dashboard address and the TLS certificates. It changes nothing at Cloudflare, Vercel or GitHub: remove what you connected there by hand.\n'
  printf 'A copy of secrets/, .env and release.env goes to /root first.\n'
  printf 'This cannot be undone. Type %s to erase: ' "\$W"
  IFS= read -r T || T=""
  [ "\$T" = "\$W" ] || fail "that did not match; nothing was changed"
  B="/root/dockify-backup-\$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -m 0700 "\$B" || fail "could not create \$B; nothing was changed"
  cp -pR "\$D/secrets" "\$B/secrets"
  cp -p "\$D/.env" "\$R" "\$B/"
  # What writes first stops first; postgres stays up for the drop below.
  c rm -fs web api worker agent updater || fail "could not stop the control services; nothing was erased"
  for i in \$(docker ps -aq --filter label=dockify.managed=true); do docker rm -fv "\$i" >/dev/null || fail "could not remove container \$i"; done
  for v in \$(docker volume ls -q --filter label=dockify.managed=true; docker volume ls -q --filter label=dockify.app); do docker volume rm -f "\$v" >/dev/null || printf 'dockify: could not remove volume %s\n' "\$v" >&2; done
  # The proxy stays up, and it has joined every environment's network: Docker refuses to remove one until it leaves.
  for n in \$(docker network ls -q --filter label=dockify.environment; docker network ls -q --filter label=dockify.role=helpers); do
    for m in \$(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "\$n" 2>/dev/null); do docker network disconnect -f "\$n" "\$m" >/dev/null 2>&1 || true; done
    docker network rm "\$n" >/dev/null 2>&1 || printf 'dockify: could not remove network %s\n' "\$n" >&2
  done
  [ "\$K" = 0 ] || docker volume rm -f dockify_dockify-backups >/dev/null || printf 'dockify: could not remove the backups volume\n' >&2
  find "\$D/proxy/conf" -maxdepth 1 -type f -delete 2>/dev/null || true
  c exec -T postgres psql -v ON_ERROR_STOP=1 -U dockify -d postgres -c 'DROP DATABASE IF EXISTS dockify WITH (FORCE)' -c 'CREATE DATABASE dockify' || fail "could not reset the control database; the copy of the secrets is in \$B"
  # The old token may have been read in a past setup: a server back in setup mode gets a new one.
  umask 077
  openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > "\$D/secrets/setup_token.new"
  chown --reference="\$D/secrets/setup_token" "\$D/secrets/setup_token.new"
  chmod --reference="\$D/secrets/setup_token" "\$D/secrets/setup_token.new"
  mv -f "\$D/secrets/setup_token.new" "\$D/secrets/setup_token"
  c run --rm --no-deps migrate || fail "the migrations failed (see: dockify logs migrate); run dockify redeploy after fixing it"
  for s in api agent worker web; do c up -d --no-deps --wait "\$s" || fail "\$s did not come up healthy (see: dockify logs \$s)"; done
  c up -d --no-deps updater || fail "the updater did not start (see: dockify logs updater)"
  printf 'Done. Open https://%s/setup\nSetup token (asked for once, to create the owner):\n  %s\nThe copy of the old secrets is in %s. Delete it when you no longer need it.\n' "\$H" "\$(cat "\$D/secrets/setup_token")" "\$B"
  exit 0
fi
# dockify admin reset-link: forgets this server's agent key, after a lost agent volume. A new join token
# first, so whoever read the old one cannot take the agent's place. In place, not by a rename, because the
# containers hold this file as a bind mount, which follows the inode. For a compromised agent, stop it and
# remove the dockify_dockify-agent volume first: it keeps its key there and joins again with the new token.
if [ "\${1:-}" = admin ] && [ "\${2:-}" = reset-link ]; then
  [ "\$(id -u)" = 0 ] || fail "run it as root: sudo dockify admin reset-link"
  [ "\$#" = 2 ] || fail "usage: dockify admin reset-link"
  T="\$(openssl rand -base64 32 | tr '+/' '-_' | tr -cd 'A-Za-z0-9_-')"
  [ -n "\$T" ] || fail "cannot make a new join token with openssl; nothing was changed"
  printf '%s' "\$T" > "\$D/secrets/primary_join_token" || fail "cannot write the new join token; nothing was changed"
  exec docker compose --project-directory "\$D" -f "\$D/docker-compose.yml" --env-file "\$D/.env" --env-file "\$R" exec api dockify-entrypoint admin reset-link
fi
# dockify admin disable-mfa | reset-password | revoke-sessions <email>: account rescue for a lost
# authenticator or password, inside the running api container (a one-off api container would ask
# for the api's fixed network addresses, which the running one holds). Through the entrypoint, so
# the database URL is assembled from the secret file the same way the api's own is.
if [ "\${1:-}" = admin ]; then
  shift
  exec docker compose --project-directory "\$D" -f "\$D/docker-compose.yml" --env-file "\$D/.env" --env-file "\$R" exec api dockify-entrypoint admin "\$@"
fi
# dockify redeploy: recreate the control services on the images release.env pins, the way an
# update does: migrations first (nothing is recreated if they fail), then api, agent, worker and web
# one at a time, each waited for, then the updater. For a release.env pinned by hand.
if [ "\${1:-}" = redeploy ]; then
  c() { docker compose --project-directory "\$D" -f "\$D/docker-compose.yml" --env-file "\$D/.env" --env-file "\$R" "\$@"; }
  c run --rm --no-deps migrate || fail "migrations failed; nothing was recreated (see: dockify logs migrate)"
  for s in api agent worker web; do
    c up -d --no-deps --wait "\$s" || fail "\$s did not come up healthy (see: dockify logs \$s)"
  done
  c up -d --no-deps updater || fail "the updater did not start (see: dockify logs updater)"
  exit 0
fi
exec docker compose --project-directory "\$D" -f "\$D/docker-compose.yml" --env-file "\$D/.env" --env-file "\$R" "\$@"
EOF
}

# Ubuntu's stock unattended-upgrades allows only the Ubuntu security pockets. Docker's own repo
# ships docker-ce and containerd.io (which bundles runc), the packages whose container-escape fixes
# matter most here, so it is added by site. Lists in apt.conf.d files are merged, not replaced.
render_docker_upgrades() {
  cat <<'EOF'
// Written by the Dockify installer. Lets unattended-upgrades apply Docker's packages
// (docker-ce, docker-ce-cli, containerd.io with its bundled runc) from download.docker.com,
// so runc and containerd security fixes land without anyone logging in.
// An upgrade restarts the Docker daemon; every container comes back by its restart policy.
Unattended-Upgrade::Origins-Pattern {
        "origin=Docker,site=download.docker.com";
};
EOF
}

# Reads `apt-cache policy PKG` on stdin and names where the installed version comes from:
# docker (download.docker.com, covered by the drop-in above), distro (an apt archive such as
# Ubuntu's, covered by its security pocket), or local (dpkg status only: nothing updates it).
classify_policy() {
  awk '
    /^ \*\*\* / { f = 1; next }
    f && /^     [^ ]/ { f = 0 }
    f && /download\.docker\.com/ { d = 1 }
    f && /(https?|ftp|file|cdrom):/ { r = 1 }
    END { if (d) print "docker"; else if (r) print "distro"; else print "local" }'
}
# $1 a binary on PATH. Prints "<source> <package>"; source is docker, distro, local or manual.
runtime_update_source() {
  bin="$(command -v "$1" 2>/dev/null || true)"
  [ -n "$bin" ] || { echo "manual -"; return 0; }
  pkg="$(dpkg-query -S "$(readlink -f "$bin")" 2>/dev/null | head -n1 | cut -d: -f1 || true)"
  [ -n "$pkg" ] || { echo "manual -"; return 0; }
  echo "$(apt-cache policy "$pkg" 2>/dev/null | classify_policy) $pkg"
}

# Checks a minisign signature with openssl alone, so no package or download is needed: the minisign
# package does not exist on Ubuntu 22.04. Does what `minisign -V` does, and what the updater does
# (minisign.ts): $1 the file, $2 its .minisig, $3 the public key, a base64 line. On success prints
# "Trusted comment: ..." and answers 0. On anything else says why on stderr and answers 1.
#   public key  base64( "Ed" | key id[8] | Ed25519 key[32] )
#   .minisig    untrusted comment line
#               base64( "ED" | key id[8] | Ed25519 signature[64] over BLAKE2b-512 of the file )
#               trusted comment line
#               base64( Ed25519 signature[64] over the signature above | the trusted comment )
# The legacy format ("Ed", signing the file itself) is refused: sign.sh and `minisign -S` do not write
# it. OpenSSL 3 is on every Ubuntu this installer supports; 1.1.1 has no -rawin, and that is said here
# instead of reading as a bad signature.
minisign_verify() (
  set -eu
  fail() { printf '%s\n' "$*" >&2; exit 1; }
  # Whole-string checks, then an exact length: base64 -d alone would pass a short or padded value.
  b64() {
    case "$1" in ''|*[!A-Za-z0-9+/=]*) return 1 ;; esac
    printf '%s' "$1" | base64 -d > "$2" 2>/dev/null || return 1
    [ "$(wc -c < "$2" | tr -d ' ')" = "$3" ]
  }
  # $1 the signature, $2 what it signs.
  ed25519() { openssl pkeyutl -verify -pubin -inkey "$d/pub.pem" -rawin -in "$2" -sigfile "$1" >/dev/null 2>&1; }

  case "$(openssl version 2>/dev/null)" in
    'OpenSSL '[3-9].*|'OpenSSL '[1-9][0-9].*) ;;
    *) fail "OpenSSL 3 or newer is needed to check the release signature (found: $(openssl version 2>&1 | head -n 1))" ;;
  esac
  [ -f "$1" ] || fail "no such file: $1"
  [ -f "$2" ] || fail "no signature file: $2"
  d="$(mktemp -d)"
  trap 'rm -rf "$d"' EXIT

  b64 "$(printf '%s' "$3" | tr -d ' \r\n')" "$d/pub.bin" 42 || fail "the public key is not a minisign key"
  [ "$(head -c 2 "$d/pub.bin")" = Ed ] || fail "the public key is not a minisign Ed25519 key"
  # SubjectPublicKeyInfo for Ed25519 (RFC 8410): 302a300506032b6570032100, then the 32 bytes of the key.
  { printf '\060\052\060\005\006\003\053\145\160\003\041\000'; tail -c 32 "$d/pub.bin"; } > "$d/pub.der"
  openssl pkey -pubin -inform DER -in "$d/pub.der" -out "$d/pub.pem" >/dev/null 2>&1 || fail "openssl cannot read the public key"

  sed 's/\r$//' "$2" > "$d/sig.txt"
  l1="$(sed -n 1p "$d/sig.txt")"; l2="$(sed -n 2p "$d/sig.txt")"; l3="$(sed -n 3p "$d/sig.txt")"; l4="$(sed -n 4p "$d/sig.txt")"
  case "$l1" in 'untrusted comment:'*) ;; *) fail "malformed signature file" ;; esac
  case "$l3" in 'trusted comment: '*) ;; *) fail "malformed signature file: no trusted comment" ;; esac
  comment="${l3#trusted comment: }"

  b64 "$l2" "$d/sig.bin" 74 || fail "malformed signature file: the signature has the wrong length"
  case "$(head -c 2 "$d/sig.bin")" in
    ED) ;;
    Ed) fail "this signature uses minisign's legacy format, which is refused; sign the release again with a current minisign" ;;
    *) fail "unsupported signature algorithm" ;;
  esac
  head -c 10 "$d/sig.bin" | tail -c 8 > "$d/sig.id"
  head -c 10 "$d/pub.bin" | tail -c 8 > "$d/pub.id"
  cmp -s "$d/sig.id" "$d/pub.id" || fail "signed by a different key"
  tail -c 64 "$d/sig.bin" > "$d/sig"

  openssl dgst -blake2b512 -binary "$1" > "$d/digest" 2>/dev/null || fail "openssl cannot compute BLAKE2b-512"
  [ "$(wc -c < "$d/digest" | tr -d ' ')" = 64 ] || fail "openssl cannot compute BLAKE2b-512"
  ed25519 "$d/sig" "$d/digest" || fail "the signature does not match this file"

  b64 "$l4" "$d/global" 64 || fail "malformed signature file: the global signature has the wrong length"
  { cat "$d/sig"; printf '%s' "$comment"; } > "$d/signed-comment"
  ed25519 "$d/global" "$d/signed-comment" || fail "the trusted comment was altered"
  printf 'Trusted comment: %s\n' "$comment"
)

# The newest release of a verified stable feed, as shell variables. $1 the manifest (its signature
# already verified), $2 minisign_verify's output (with the trusted comment), $3 the dpkg architecture.
# The trusted comment must name the channel and the newest version, the rule the updater applies
# too, and every image must be pinned by digest. Fails on anything else.
manifest_release() {
  arch="$3"
  case "$arch" in amd64|arm64) ;; *) return 1 ;; esac
  jq -e '.schema == 2 and .channel == "stable" and (.releases | length) > 0' "$1" >/dev/null 2>&1 || return 1
  v="$(jq -er '.releases[0].version' "$1")" || return 1
  printf '%s' "$v" | grep -Eq '^[0-9]+[.][0-9]+[.][0-9]+(-[0-9A-Za-z.]+)?$' || return 1
  ve="$(printf '%s' "$v" | sed 's/[.]/[.]/g')"
  printf '%s' "$2" | grep -Eq "Trusted comment: (.* )?version:$ve( |$)" || return 1
  printf '%s' "$2" | grep -Eq "Trusted comment: (.* )?channel:stable( |$)" || return 1
  c="$(jq -er --arg a "$arch" '.releases[0].images.control[$a]' "$1")" || return 1
  w="$(jq -er --arg a "$arch" '.releases[0].images.web[$a]' "$1")" || return 1
  for ref in "$c" "$w"; do printf '%s' "$ref" | grep -Eq '^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$' || return 1; done
  cs="$(jq -r '.releases[0].composeSha256 // empty' "$1")"
  ps="$(jq -r '.releases[0].socketProxySha256 // empty' "$1")"
  mf="$(jq -r '.releases[0].minFrom // empty' "$1")"
  [ -z "$mf" ] || printf '%s' "$mf" | grep -Eq '^([0-9]+[.][0-9]+[.][0-9]+(-[0-9A-Za-z.]+)?)?$' || return 1
  printf 'REL_VERSION=%s\nREL_CONTROL=%s\nREL_WEB=%s\nREL_COMPOSE_SHA=%s\nREL_PROXY_SHA=%s\nREL_MIN_FROM=%s\n' "$v" "$c" "$w" "$cs" "$ps" "$mf"
}

# True when version $1 is older than $2. A pre-release sorts before its release, as in the updater.
ver_lt() {
  [ "$1" != "$2" ] || return 1
  a="${1%%-*}" b="${2%%-*}"
  if [ "$a" = "$b" ]; then
    case "$1:$2" in
      *-*:*-*) [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$1" ] ;;
      *-*:*) return 0 ;;
      *) return 1 ;;
    esac
    return
  fi
  [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -n 1)" = "$a" ]
}

# Why a move from version $1 to release $2 with minFrom $3 must not happen, the rules the updater holds
# (release.ts refuseTarget), or nothing. The same version is allowed: --upgrade also refreshes the files.
# Unknown or development versions cannot be compared, so they pass.
upgrade_refusal() {
  case "$1" in ""|0.0.0-dev) return 0 ;; esac
  if ver_lt "$2" "$1"; then
    printf 'Refusing a downgrade: this server runs %s and the signed feed offers %s. To go back, use: dockify update rollback. To pin images on purpose, pass --control-image and --web-image.' "$1" "$2"
  elif [ -n "$3" ] && ver_lt "$1" "$3"; then
    printf '%s upgrades only from %s or newer, and this server runs %s. Install %s first: dockify update apply %s' "$2" "$3" "$1" "$3" "$3"
  fi
}

# The dashboard host carries two services. /api/v1/ is the api's: API tokens, GitHub's webhook and
# GitHub's return after an install or an App creation all arrive there. Everything else is the web.
# Both are named by their fixed edge addresses from docker-compose.yml: "api" alone can resolve to
# the egress network, where the caller's source address is not one the api trusts, and Traefik
# joins tenant networks, where a tenant service may answer to "web" or "api". The api's own
# internal routes are not under the prefix, so neither proxy can reach them.
DASH_API_UPSTREAM="http://172.30.1.10:3001"
DASH_WEB_UPSTREAM="http://172.30.1.20:3000"
is_dashboard_host() { printf '%s' "$1" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'; }

# The name sslip.io answers with this address: 203.0.113.4 gives 203-0-113-4.sslip.io. A real public
# name for a server that has none yet, so Let's Encrypt can issue it a certificate.
sslip_host() { printf '%s.sslip.io' "$(printf '%s' "$1" | tr . -)"; }
# True for a public IPv4 address, in the dotted form sslip.io can spell.
is_public_ipv4() {
  printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || return 1
  case "$1" in
    0.*|10.*|127.*|169.254.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*|22[4-9].*|2[3-5][0-9].*) return 1 ;;
  esac
}
# This server's public IPv4: the outgoing interface's address, or behind NAT, what the outside sees
# (Cloudflare's trace page, by address, so no name has to resolve yet). Empty when neither is known.
public_ipv4() {
  a="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }')"
  if is_public_ipv4 "$a"; then printf '%s' "$a"; return 0; fi
  command -v curl >/dev/null 2>&1 || return 0
  a="$(curl -4 -fsS --proto '=https' --max-time 8 https://1.1.1.1/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p')"
  if is_public_ipv4 "$a"; then printf '%s' "$a"; fi
}
# Asks on the terminal (the one-liner pipes this script, so never stdin). The answer goes to stdout;
# empty when nothing was typed or no terminal is attached. DOCKIFY_TTY replaces it in tests.
ask_tty() {
  t="${DOCKIFY_TTY:-/dev/tty}"
  { printf '%s' "$1" > "$t"; } 2>/dev/null || return 0
  a=""
  { IFS= read -r a < "$t"; } 2>/dev/null || a=""
  printf '%s' "$a"
}
clean_host() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]' | sed -e 's#^https\{0,1\}://##' -e 's#/.*$##' -e 's#[.]$##'; }

# Tunnel mode: the new tunnel's whole ingress. cloudflared takes the first rule that matches, so
# the api's path comes before the rest of the dashboard host, and every other hostname falls
# through to the proxy, which serves only the domains Dockify configured. $1 the dashboard host.
render_tunnel_ingress() {
  is_dashboard_host "$1" || return 1
  printf '{"config":{"ingress":[{"hostname":"%s","path":"^/api/v1/","service":"%s"},{"hostname":"%s","service":"%s"},{"service":"http://dockify-proxy:80"}]}}\n' \
    "$1" "$DASH_API_UPSTREAM" "$1" "$DASH_WEB_UPSTREAM"
}

# Direct mode writes no dashboard route here. The worker is the one owner of the dashboard's
# routers: it writes proxy/conf/__dashboard.yml (the api's /api/v1/ router above the web's) at
# every boot from DOCKIFY_PUBLIC_URL, before it waits for anything else, and removes the
# proxy/00-dashboard.yml earlier installers wrote (apps/worker/src/edge/routes.ts).

# A dashboard host the tunnel has no rule for at all, after `dockify admin set-domain` on a server
# whose Cloudflare is not connected in Settings: its two rules at the top. Prints nothing when the
# host has any rule already. Reads the same answer as below. $1 the dashboard host.
tunnel_add_dashboard_rules() {
  is_dashboard_host "$1" || return 1
  jq -c --arg h "$1" --arg api "$DASH_API_UPSTREAM" --arg web "$DASH_WEB_UPSTREAM" '
    (if has("result") then .result else . end) as $r
    | ($r.config.ingress // []) as $ing
    | if any($ing[]; .hostname == $h) then empty
      else {config: ($r.config + {ingress: ([{hostname: $h, path: "^/api/v1/", service: $api}, {hostname: $h, service: $web}] + $ing)})}
      end'
}

# A tunnel the installer made before the api had its own path on the dashboard host: the config
# on stdin (Cloudflare's GET .../configurations answer, or its result), the config to PUT on
# stdout, with the api rule inserted right above the dashboard's own rule. Prints nothing when the
# rule is there already or the dashboard rule is not (a hand-edited tunnel is left alone). $1 the
# dashboard host. The worker's reconcile does the same once Cloudflare is connected in Settings.
tunnel_add_api_rule() {
  is_dashboard_host "$1" || return 1
  jq -c --arg h "$1" --arg api "$DASH_API_UPSTREAM" '
    (if has("result") then .result else . end) as $r
    | ($r.config.ingress // []) as $ing
    | if any($ing[]; .hostname == $h and .path == "^/api/v1/") then empty
      else ([$ing | to_entries[] | select(.value.hostname == $h and ((.value.path // "") == "")) | .key] | first) as $at
      | if $at == null then empty
        else {config: ($r.config + {ingress: ($ing[0:$at] + [{hostname: $h, path: "^/api/v1/", service: $api}] + $ing[$at:])})}
        end
      end'
}

# The container firewall, applied before every Docker start and again after it.
# Idempotent: each rule is inserted only when missing. A rule inserted later lands above the earlier
# ones, so the deploy bridge's 80 and 443 come before the tenant-bridge drop. It needs nothing of
# Docker's: it makes DOCKER-USER itself, and Docker keeps a chain of that name it finds.
render_firewall() {
  cat <<'EOF'
#!/bin/sh
# Dockify host rules, applied before and after every Docker start. Idempotent.
set -eu
ins() { t="$1"; shift; c="$1"; shift; "$t" -C "$c" "$@" 2>/dev/null || "$t" -I "$c" "$@"; }
iptables -N DOCKER-USER 2>/dev/null || true
# Cloud metadata endpoints (AWS, GCP, Azure, DigitalOcean, Hetzner: 169.254.0.0/16; Alibaba).
ins iptables DOCKER-USER -d 169.254.0.0/16 -j DROP
ins iptables DOCKER-USER -d 100.100.100.200/32 -j DROP
# Azure's WireServer. Not port 53: the same address is the VM's DNS, which Docker's resolver forwards to
# from inside each container's network.
ins iptables DOCKER-USER -d 168.63.129.16/32 -p tcp ! --dport 53 -j DROP
# Tenant bridges (dk-*) may not open connections to the host itself; replies are allowed.
ins iptables INPUT -i dk-+ -j DROP
ins iptables INPUT -i dk-+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# Except the control plane's deploy bridge (the worker and the proxy, never a tenant app), to this
# server's own web ports only: the worker checks a domain's certificate and sends same-server
# webhooks to the server's public address, and that hairpin arrives here.
ins iptables INPUT -i dk-deploy -p tcp --dport 80 -j ACCEPT
ins iptables INPUT -i dk-deploy -p tcp --dport 443 -j ACCEPT
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -N DOCKER-USER 2>/dev/null || true
  ins ip6tables DOCKER-USER -d fd00:ec2::254/128 -j DROP
  ins ip6tables DOCKER-USER -d fe80::/10 -j DROP
  ins ip6tables INPUT -i dk-+ -j DROP
  ins ip6tables INPUT -i dk-+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ins ip6tables INPUT -i dk-deploy -p tcp --dport 80 -j ACCEPT
  ins ip6tables INPUT -i dk-deploy -p tcp --dport 443 -j ACCEPT
fi
EOF
}

# Sets KEY=VALUE in an env file, replacing the line that sets KEY or appending one, and keeps every
# other line, the file's owner and its mode. $1 file, $2 key, $3 value (plain characters only).
env_set() {
  # Whole-string checks (grep would pass a value with a newline if one of its lines matched).
  case "$2" in ''|[!A-Z]*|*[!A-Z0-9_]*) return 1 ;; esac
  case "$3" in *[!A-Za-z0-9._:/@+=-]*) return 1 ;; esac
  t="$1.tmp.$$"
  { grep -v "^$2=" "$1" || true; printf '%s=%s\n' "$2" "$3"; } > "$t"
  chown --reference="$1" "$t" 2>/dev/null || true
  chmod --reference="$1" "$t" 2>/dev/null || true
  mv -f "$t" "$1"
}

# The ports SSH answers on, one per line, so ufw allows them before it denies everything else:
# sshd's own listeners, and with socket activation (ssh.socket, Ubuntu's default since 22.10,
# where the listening process is systemd and not sshd) the socket's ListenStream ports. Empty
# when neither shows one; the caller then falls back to 22.
ssh_ports() {
  {
    ss -ltnpH 2>/dev/null | awk '/"sshd"/ { n = split($4, a, ":"); print a[n] }'
    systemctl show -p Listen --value ssh.socket 2>/dev/null | grep -oE ':[0-9]+ \(Stream\)' | tr -dc '0-9\n'
  } | grep -E '^[0-9]{1,5}$' | sort -un || true
}

# `dockify up -d --wait` for the given services, tried once more before it fails: on a first boot
# a recreated dependency (the socket proxy) can make one wait report unhealthy.
up_wait() {
  dockify up -d --wait "$@" && return 0
  warn "not every service reported healthy; waiting 10 s and trying once more"
  sleep 10
  dockify up -d --wait "$@"
}

# ------------------------------------------------------------------ steps an install and --upgrade share

# The Cloudflare token goes to curl through a header file, never argv, so `ps` cannot show it.
# From --cf-token-file, or asked for on the terminal when $1 is "ask".
cf_token_header() {
  if [ -n "$CF_TOKEN_FILE" ]; then
    [ -r "$CF_TOKEN_FILE" ] || die "cannot read $CF_TOKEN_FILE"
    CF_TOKEN="$(tr -d '\r\n' < "$CF_TOKEN_FILE")"
  elif [ "${1:-}" = ask ] && { [ -t 0 ] || [ -r /dev/tty ]; }; then
    printf 'Cloudflare API token (Zone:DNS:Edit, Account:Cloudflare Tunnel:Edit): ' > /dev/tty
    stty -echo < /dev/tty; IFS= read -r CF_TOKEN < /dev/tty; stty echo < /dev/tty; printf '\n' > /dev/tty
  else
    die "pass --cf-token-file in non-interactive installs"
  fi
  [ -n "$CF_TOKEN" ] || die "empty Cloudflare token"
  printf 'Authorization: Bearer %s\n' "$CF_TOKEN" > "$TMP/cf.hdr"
  unset CF_TOKEN
}
cf() {
  if [ -n "${3:-}" ]; then
    curl -sS --proto '=https' -X "$1" -H @"$TMP/cf.hdr" -H 'Content-Type: application/json' --data "$3" "$CF_API$2"
  else
    curl -sS --proto '=https' -X "$1" -H @"$TMP/cf.hdr" "$CF_API$2"
  fi
}
ok() { printf '%s' "$1" | jq -e '.success == true' >/dev/null 2>&1; }
errs() { printf '%s' "$1" | jq -r '[.errors[]?.message] | join("; ")' 2>/dev/null; }

# Writes the container firewall script and its systemd unit, and applies the rules now.
install_firewall() {
  say "Container firewall rules"
  if [ "$DRY" = 0 ]; then
    render_firewall > /usr/local/sbin/dockify-firewall
    chmod 0755 /usr/local/sbin/dockify-firewall
    cat > /etc/systemd/system/dockify-firewall.service <<'EOF'
[Unit]
Description=Dockify container firewall rules
After=docker.service
PartOf=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/dockify-firewall
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target docker.service
EOF
    # Docker starts restart-policy containers before it reports started, so after a reboot the unit
    # above is late for them. This one holds Docker back until the rules are in. Not RemainAfterExit:
    # it runs again on each Docker start. After any service that reloads the tables at boot.
    cat > /etc/systemd/system/dockify-firewall-early.service <<'EOF'
[Unit]
Description=Dockify container firewall rules, before Docker starts
Before=docker.service
After=ufw.service firewalld.service netfilter-persistent.service nftables.service
ConditionPathExists=/usr/local/sbin/dockify-firewall

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/dockify-firewall

[Install]
WantedBy=docker.service
EOF
    systemctl daemon-reload
    systemctl enable dockify-firewall-early.service >/dev/null
    systemctl enable --now dockify-firewall.service >/dev/null
    systemctl restart dockify-firewall.service
  fi
  note "metadata addresses blocked for containers; dk-* bridges cannot reach the host (the deploy bridge only its ports 80 and 443)"
}

# Docker's default pools hold 31 networks, and each isolated preview takes one. This is Docker's own
# list, so nothing already chosen moves, then 256 small ones to spill into. A network it would overlap
# with a route on this server is skipped by Docker.
DOCKER_ADDRESS_POOLS='[{"base":"172.17.0.0/16","size":16},{"base":"172.18.0.0/16","size":16},{"base":"172.19.0.0/16","size":16},{"base":"172.20.0.0/14","size":16},{"base":"172.24.0.0/14","size":16},{"base":"172.28.0.0/14","size":16},{"base":"192.168.0.0/16","size":20},{"base":"10.213.0.0/16","size":24}]'
DOCKER_DAEMON_JSON="${DOCKER_DAEMON_JSON:-/etc/docker/daemon.json}"

# Widens the pools in daemon.json. A daemon reads them only at start, and that start stops every
# container on it, so Docker is restarted only if nothing is running. Otherwise the file waits for
# the next restart: the pools apply to new networks only, so that restart changes nothing else. A
# file this cannot read, or that already chooses its own pools, is the owner's and is left alone.
widen_address_pools() {
  command -v jq >/dev/null 2>&1 || { warn "jq is missing, so Docker's address pools were not widened"; return 0; }
  if [ -s "$DOCKER_DAEMON_JSON" ]; then
    jq -e 'type == "object"' "$DOCKER_DAEMON_JSON" >/dev/null 2>&1 || { warn "$DOCKER_DAEMON_JSON is not a JSON object, so Docker's address pools were not widened"; return 0; }
    if jq -e 'has("default-address-pools")' "$DOCKER_DAEMON_JSON" >/dev/null; then
      jq -e --argjson want "$DOCKER_ADDRESS_POOLS" '."default-address-pools" == $want' "$DOCKER_DAEMON_JSON" >/dev/null ||
        note "$DOCKER_DAEMON_JSON already sets default-address-pools; leaving it. Each isolated preview takes one network from them"
      return 0
    fi
    NEXT_DAEMON="$(jq --argjson want "$DOCKER_ADDRESS_POOLS" '. + {"default-address-pools": $want}' "$DOCKER_DAEMON_JSON")"
  else
    NEXT_DAEMON="$(jq -n --argjson want "$DOCKER_ADDRESS_POOLS" '{"default-address-pools": $want}')"
  fi
  if [ "$DRY" = 1 ]; then note "[dry-run] would add default-address-pools to $DOCKER_DAEMON_JSON"; return 0; fi

  PREV_DAEMON="$DOCKER_DAEMON_JSON.before-dockify"
  had_daemon=0
  if [ -e "$DOCKER_DAEMON_JSON" ]; then had_daemon=1; cp -p "$DOCKER_DAEMON_JSON" "$PREV_DAEMON"; fi
  install -d -m 0755 "$(dirname "$DOCKER_DAEMON_JSON")"
  printf '%s\n' "$NEXT_DAEMON" > "$DOCKER_DAEMON_JSON.new"
  chmod 0644 "$DOCKER_DAEMON_JSON.new"
  if ! dockerd --validate --config-file "$DOCKER_DAEMON_JSON.new" >/dev/null 2>&1; then
    rm -f "$DOCKER_DAEMON_JSON.new"
    warn "Docker refused the widened address pools, so $DOCKER_DAEMON_JSON is unchanged"
    return 0
  fi
  mv "$DOCKER_DAEMON_JSON.new" "$DOCKER_DAEMON_JSON"

  if [ -n "$(docker ps -q 2>/dev/null)" ]; then
    note "Docker's address pools are widened in $DOCKER_DAEMON_JSON, for about 280 networks"
    note "they apply the next time Docker restarts, and running containers keep working until then"
    note "to apply now, in a quiet moment: sudo systemctl restart docker (every app stops for a few seconds and comes back)"
    return 0
  fi
  if systemctl restart docker && docker version >/dev/null 2>&1; then
    note "Docker's address pools are widened, for about 280 networks"
    return 0
  fi
  if [ "$had_daemon" = 1 ]; then mv "$PREV_DAEMON" "$DOCKER_DAEMON_JSON"; else rm -f "$DOCKER_DAEMON_JSON"; fi
  systemctl restart docker || die "Docker did not start after restoring $DOCKER_DAEMON_JSON: see journalctl -u docker"
  warn "Docker did not start with the widened address pools, so its previous settings are back"
}

# Rootless BuildKit starts in a user namespace of its own. Ubuntu 23.10 and later (24.04 included) stop
# unconfined processes from creating one (kernel.apparmor_restrict_unprivileged_userns=1), and the
# daemon then restarts for ever with "fork/exec /proc/self/exe: permission denied". This profile is
# unconfined like before, plus userns, for the BuildKit container alone: the host keeps its restriction.
# Elsewhere (22.04, or the restriction off) the container stays plain unconfined, as it always was.
BUILDKIT_APPARMOR_PROFILE=dockify-buildkit
APPARMOR_USERNS_SYSCTL="${APPARMOR_USERNS_SYSCTL:-/proc/sys/kernel/apparmor_restrict_unprivileged_userns}"
APPARMOR_DIR="${APPARMOR_DIR:-/etc/apparmor.d}"

render_buildkit_apparmor() {
  cat <<EOF
# Written by the Dockify installer: rootless BuildKit's user namespace (docker-compose.yml, buildkit).
abi <abi/4.0>,
include <tunables/global>

profile $BUILDKIT_APPARMOR_PROFILE flags=(unconfined) {
  userns,
}
EOF
}

# Prints the AppArmor setting for the buildkit service (DOCKIFY_BUILDKIT_APPARMOR in .env): the
# profile above, loaded now and from $APPARMOR_DIR at every boot, or "unconfined" where none is needed.
buildkit_apparmor() {
  if [ ! -r "$APPARMOR_USERNS_SYSCTL" ] || [ "$(cat "$APPARMOR_USERNS_SYSCTL" 2>/dev/null)" != 1 ]; then
    echo unconfined
    return 0
  fi
  if [ "$DRY" = 1 ]; then
    note "[dry-run] would load the AppArmor profile $BUILDKIT_APPARMOR_PROFILE so rootless BuildKit may create its user namespace" >&2
    echo "$BUILDKIT_APPARMOR_PROFILE"
    return 0
  fi
  command -v apparmor_parser >/dev/null 2>&1 || die "this kernel restricts user namespaces (kernel.apparmor_restrict_unprivileged_userns=1), so BuildKit needs an AppArmor profile, and apparmor_parser is missing: apt-get install apparmor, then run this again"
  install -d -m 0755 "$APPARMOR_DIR"
  render_buildkit_apparmor > "$APPARMOR_DIR/$BUILDKIT_APPARMOR_PROFILE.new"
  chmod 0644 "$APPARMOR_DIR/$BUILDKIT_APPARMOR_PROFILE.new"
  mv "$APPARMOR_DIR/$BUILDKIT_APPARMOR_PROFILE.new" "$APPARMOR_DIR/$BUILDKIT_APPARMOR_PROFILE"
  apparmor_parser -r -W "$APPARMOR_DIR/$BUILDKIT_APPARMOR_PROFILE" >/dev/null \
    || die "AppArmor refused the profile $APPARMOR_DIR/$BUILDKIT_APPARMOR_PROFILE that lets rootless BuildKit create its user namespace"
  echo "$BUILDKIT_APPARMOR_PROFILE"
}

# The signed release: the static feed's manifest, its signature checked before jq reads a byte of
# it. Sets VERSION, COMPOSE_SHA and PROXY_CFG_SHA, and the images unless they were given.
resolve_release() {
  say "Release"
  VERSION="" COMPOSE_SHA="" PROXY_CFG_SHA=""
  FEED="${FEED%/}"
  MANIFEST_URL="$FEED/releases/stable.json"
  if [ -n "$FEED" ] && [ -n "$PUBKEY" ] && [ "$DRY" = 1 ] && ! { command -v openssl && command -v jq; } >/dev/null 2>&1; then
    # A dry run installs nothing: without the tools the feed cannot be checked, so it is not read.
    note "[dry-run] openssl or jq is not installed yet (the real run installs them first), so the signed release feed is not read"
    [ -n "$CONTROL_IMAGE" ] || return 0
  elif [ -n "$FEED" ] && [ -n "$PUBKEY" ]; then
    curl -fsS --proto '=https' --max-filesize 524288 -o "$TMP/manifest.json" "$MANIFEST_URL" || die "cannot fetch $MANIFEST_URL"
    curl -fsS --proto '=https' --max-filesize 4096 -o "$TMP/manifest.json.minisig" "$MANIFEST_URL.minisig" || die "cannot fetch $MANIFEST_URL.minisig"
    OUT="$(minisign_verify "$TMP/manifest.json" "$TMP/manifest.json.minisig" "$PUBKEY" 2> "$TMP/verify.err")" \
      || die "the release manifest's signature did not verify against the pinned key: $(cat "$TMP/verify.err")"
    manifest_release "$TMP/manifest.json" "$OUT" "$(dpkg --print-architecture)" > "$TMP/release.vars" \
      || die "the signed manifest is not a valid stable release feed for this architecture"
    # shellcheck disable=SC1091
    . "$TMP/release.vars"
    if [ -z "$CONTROL_IMAGE" ]; then CONTROL_IMAGE="$REL_CONTROL" WEB_IMAGE="$REL_WEB"; fi
    VERSION="$REL_VERSION" COMPOSE_SHA="$REL_COMPOSE_SHA" PROXY_CFG_SHA="$REL_PROXY_SHA"
    note "verified release $VERSION"
  fi
  for ref in "$CONTROL_IMAGE" "$WEB_IMAGE"; do
    printf '%s' "$ref" | grep -Eq '@sha256:[a-f0-9]{64}$' || die "release image is not pinned by digest: $ref"
  done
}

# True when nobody but this uid can change these paths. $1 the uid, then the paths.
owned_only_by() {
  u="$1"; shift
  for f in "$@"; do
    if [ -L "$f" ] || [ ! -e "$f" ]; then return 1; fi
    [ "$(stat -c '%u' "$f")" = "$u" ] || return 1
    case "$(stat -c '%a' "$f")" in *[2367][0-7]|*[2367]) return 1 ;; esac
  done
}
# A folder no other user can write: where a file sitting next to this script may be trusted from.
# The bootstrap's private temp folder qualifies. /tmp, where a script may have been saved, does not.
script_dir_is_private() {
  [ -d "$1" ] && [ ! -L "$1" ] || return 1
  case "$(stat -c '%a' "$1")" in *[2367][0-7]|*[2367]) return 1 ;; esac
}

# The compose file and the socket proxy allowlist into $TMP, from the feed, each checked against its
# hash in the signed manifest. A checkout only with --from-checkout, and only one root alone can
# change: this script may have been saved anywhere, and a path relative to it is not a promise (run
# from /tmp/tmp.XXXX, the bootstrap's own folder, "../deploy" is world-writable /tmp/deploy).
fetch_stack_files() {
  SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo /nonexistent)"
  if [ "$FROM_CHECKOUT" = 1 ]; then
    REPO="$(cd "$SRC/.." 2>/dev/null && pwd || echo /nonexistent)"
    [ -f "$REPO/deploy/docker-compose.yml" ] || die "--from-checkout: there is no deploy/docker-compose.yml in $REPO"
    [ -f "$REPO/deploy/socket-proxy/haproxy.cfg" ] || die "deploy/socket-proxy/haproxy.cfg is missing from the checkout"
    owned_only_by 0 "$REPO" "$REPO/deploy" "$REPO/deploy/docker-compose.yml" "$REPO/deploy/socket-proxy" "$REPO/deploy/socket-proxy/haproxy.cfg" \
      || die "--from-checkout: $REPO, its deploy folder and those two files must be owned by root and not writable by group or others. Fix with: chown -R root: $REPO && chmod -R go-w $REPO"
    cp "$REPO/deploy/docker-compose.yml" "$TMP/docker-compose.yml"
    cp "$REPO/deploy/socket-proxy/haproxy.cfg" "$TMP/haproxy.cfg"
    # A signed manifest that names hashes is obeyed, wherever the file came from.
    if [ -n "${COMPOSE_SHA:-}" ] && [ "$(sha256sum "$TMP/docker-compose.yml" | cut -d' ' -f1)" != "$COMPOSE_SHA" ]; then die "the checkout's docker-compose.yml does not match the signed manifest"; fi
    if [ -n "${PROXY_CFG_SHA:-}" ] && [ "$(sha256sum "$TMP/haproxy.cfg" | cut -d' ' -f1)" != "$PROXY_CFG_SHA" ]; then die "the checkout's socket-proxy/haproxy.cfg does not match the signed manifest"; fi
  elif [ -n "$FEED" ] && [ -n "$COMPOSE_SHA" ] && [ -n "$PROXY_CFG_SHA" ]; then
    curl -fsS --proto '=https' --max-filesize 262144 -o "$TMP/docker-compose.yml" "$FEED/releases/$VERSION/docker-compose.yml" || die "cannot fetch docker-compose.yml"
    [ "$(sha256sum "$TMP/docker-compose.yml" | cut -d' ' -f1)" = "$COMPOSE_SHA" ] || die "docker-compose.yml does not match the signed manifest"
    curl -fsS --proto '=https' --max-filesize 65536 -o "$TMP/haproxy.cfg" "$FEED/releases/$VERSION/socket-proxy/haproxy.cfg" || die "cannot fetch socket-proxy/haproxy.cfg"
    [ "$(sha256sum "$TMP/haproxy.cfg" | cut -d' ' -f1)" = "$PROXY_CFG_SHA" ] || die "socket-proxy/haproxy.cfg does not match the signed manifest"
  elif [ "$DRY" = 1 ]; then
    note "[dry-run] would download docker-compose.yml and haproxy.cfg for the release and check them against the signed manifest"
  else
    die "no docker-compose.yml: use a feed whose manifest has composeSha256 and socketProxySha256, or pass --from-checkout in a repository root owns"
  fi
}

# The server's public IPv6, when it has a global one: what direct-mode AAAA records point at.
server_ipv6() {
  ip -6 route get 2606:4700:4700::1111 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }' | grep -E '^[0-9a-f]*:[0-9a-f:]+$' | grep -Ev '^(fe80|fd|fc)' || true
}

# The server's own name for the Server page: the api and the worker only know their container ids.
# Hostname characters only, one line, so it is safe as a .env value.
host_name() {
  uname -n 2>/dev/null | head -n 1 | tr -cd 'A-Za-z0-9.-' | cut -c 1-253
}

# The folder Traefik watches (--providers.file.directory), which must exist before it starts. The
# worker writes every route there, the dashboard's own included; uid 1000 owns it.
# The worker's end of the link, and the token this server's agent joins with once. Ed25519, 100 years:
# agents compare the certificate by its fingerprint and never read a date. Kept across upgrades, because
# every agent has pinned this certificate.
make_link_secrets() {
  [ -f "$1/primary_join_token" ] || { (umask 077; openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > "$1/primary_join_token") || die "cannot make the agent's join token"; }
  [ -f "$1/link_key" ] && [ -f "$1/link_cert" ] && return 0
  (umask 077; openssl req -x509 -newkey ed25519 -nodes -keyout "$1/link_key" -out "$1/link_cert" -days 36500 -subj /CN=dockify-worker 2>/dev/null) || die "cannot make the link's key with openssl"
}

make_route_folder() {
  install -d -m 0750 -o 1000 -g 1000 "$DIR/proxy/conf"
}

# True when Docker holds a control database from an earlier install.
kept_database_volume() {
  command -v docker >/dev/null 2>&1 && docker volume inspect dockify_dockify-db >/dev/null 2>&1
}
# The newest backup in $1 that can open that database. Timestamped names sort by time. Empty when none.
kept_data_backup() {
  found=""
  for b in "$1"/dockify-backup-*; do
    if [ -s "$b/secrets/postgres_password" ] && [ -s "$b/secrets/master_key" ]; then found="$b"; fi
  done
  printf '%s' "$found"
}

# What an install on kept data must say. $1 is the ingress. The rows came back and the app containers did
# not: the uninstall removed them and nothing recreates a container but a deploy, while
# `dockify redeploy` recreates only Dockify's own services.
kept_data_apps_step() {
  cat <<STEP

  YOUR APPS ARE NOT RUNNING YET. The uninstall removed their containers, and nothing restarts them
  on its own. Their settings, variables and volumes are all here. In the dashboard, deploy each one
  again: open it and press Deploy, databases first, then the apps that use them.
  (\`dockify redeploy\` does not do this: it recreates Dockify's own services, not your apps.)
STEP
  [ "$1" != tunnel ] || cat <<STEP
  This install has a new Cloudflare tunnel, so an app domain routed through the old one leads nowhere.
  In Settings, Integrations, connect Cloudflare again, then remove each such domain and add it again.
STEP
}

# Keeps the newest $2 timestamped folders in $1. Each holds .env and a full database dump, which must
# not outlive a key rotation or a deleted account for ever.
prune_upgrade_backups() {
  find "$1" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*T*Z' 2>/dev/null | sort -r | tail -n "+$(($2 + 1))" | while IFS= read -r d; do rm -rf "$d"; done
}

# Tells the database what now runs, as a finished self-update does. Otherwise the dashboard keeps showing
# the old version and offers the release already running. Only a version from the signed feed, already
# checked against manifest_release's pattern, reaches this.
record_release_version() {
  [ -n "$1" ] || return 0
  dockify exec -T postgres psql -v ON_ERROR_STOP=1 -q -U dockify -d dockify -c "UPDATE instance SET \"releaseVersion\" = '$1' WHERE id = 1" \
    || warn "could not record version $1 in the database; the dashboard shows the old one until the next update"
}

# --upgrade: the install in $DIR, brought up to this installer's version in place. Every step is
# safe to run again. The services keep running until migrate has passed.
upgrade() {
  [ -f "$DIR/.env" ] || die "no Dockify install in $DIR (no .env); run without --upgrade to install"
  # Images given by hand are the operator's choice and name no version; the feed's are held to its rules.
  EXPLICIT_IMAGES=0
  [ -z "$CONTROL_IMAGE" ] || EXPLICIT_IMAGES=1
  command -v docker >/dev/null 2>&1 || die "Docker is not installed"
  command -v dockify >/dev/null 2>&1 || [ -x /usr/local/bin/dockify ] || die "the dockify wrapper is missing; reinstall"
  envget() { sed -n "s/^$1=//p" "$DIR/.env" | tail -n 1; }
  DOMAIN="$(envget DOCKIFY_PUBLIC_URL | sed -e 's#^https://##' -e 's#[/:].*$##')"
  is_dashboard_host "$DOMAIN" || die "DOCKIFY_PUBLIC_URL in $DIR/.env does not name a plain hostname"
  case "$(envget DOCKIFY_INGRESS)" in direct_tls) INGRESS=direct ;; *) INGRESS=tunnel ;; esac
  [ -n "$FEED" ] || FEED="$(envget DOCKIFY_RELEASE_FEED)"
  [ -n "$PUBKEY" ] || PUBKEY="$(envget DOCKIFY_RELEASE_PUBKEY)"
  for ref in "$CONTROL_IMAGE" "$WEB_IMAGE"; do
    [ -z "$ref" ] || printf '%s' "$ref" | grep -Eq '@sha256:[a-f0-9]{64}$' || die "image references must be pinned by digest (...@sha256:<64 hex>)"
  done
  if [ -n "$CONTROL_IMAGE$WEB_IMAGE" ] && { [ -z "$CONTROL_IMAGE" ] || [ -z "$WEB_IMAGE" ]; }; then die "pass both --control-image and --web-image"; fi
  say "Upgrading $DIR ($DOMAIN, $INGRESS mode)"

  # The images: the ones given, else the feed's newest, else the ones pinned now.
  if [ -n "$CONTROL_IMAGE" ] || { [ -n "$FEED" ] && [ -n "$PUBKEY" ]; }; then
    # Checking the signed feed takes openssl and jq, both in Ubuntu's main component.
    if [ -n "$FEED" ] && [ -n "$PUBKEY" ]; then
      { command -v openssl && command -v jq; } >/dev/null 2>&1 || run apt-get install -y -qq openssl jq >/dev/null || die "openssl and jq are needed to check the signed release feed, and could not be installed"
    fi
    resolve_release
    if [ "$EXPLICIT_IMAGES" = 1 ]; then
      VERSION=""
    elif [ -n "$VERSION" ]; then
      # What runs is in the database, written by the updater and by this script; .env only says what was last
      # installed by hand. Before anything changes, and before the feed's choice is taken as the target.
      RUNNING="$(dockify exec -T postgres psql -U dockify -d dockify -tAc 'SELECT "releaseVersion" FROM instance WHERE id = 1' 2>/dev/null | tr -d '[:space:]' || true)"
      # Else the api image's own version; .env's goes stale after an in-app update, so it comes last.
      [ -n "$RUNNING" ] || RUNNING="$(dockify exec -T api printenv DOCKIFY_IMAGE_VERSION 2>/dev/null | tr -d '[:space:]' || true)"
      [ -n "$RUNNING" ] || RUNNING="$(envget DOCKIFY_VERSION)"
      WHY="$(upgrade_refusal "$RUNNING" "$VERSION" "${REL_MIN_FROM:-}")"
      [ -z "$WHY" ] || die "$WHY Nothing was changed."
    fi
  else
    CONTROL_IMAGE="$(sed -n 's/^DOCKIFY_CONTROL_IMAGE=//p' "$DIR/release/release.env")"
    WEB_IMAGE="$(sed -n 's/^DOCKIFY_WEB_IMAGE=//p' "$DIR/release/release.env")"
    VERSION="" COMPOSE_SHA="" PROXY_CFG_SHA=""
    note "keeping the images release.env pins"
  fi
  fetch_stack_files
  if [ "$DRY" = 1 ]; then
    note "[dry-run] would back up and replace docker-compose.yml and haproxy.cfg, rewrite the firewall rules and the dockify wrapper, widen Docker's address pools (no restart while anything runs), hand the work volume to uid 1000, run migrate, then recreate each service"
    exit 0
  fi

  # The files this changes, kept so a failed migrate can put them back.
  B="$DIR/upgrade-backups/$(date -u +%Y%m%dT%H%M%SZ)"
  install -d -m 0700 -o 0 -g 0 "$DIR/upgrade-backups" "$B"
  cp -p "$DIR/docker-compose.yml" "$DIR/.env" "$DIR/release/release.env" "$DIR/socket-proxy/haproxy.cfg" "$B/"
  restore_files() {
    cp -p "$B/docker-compose.yml" "$DIR/docker-compose.yml"
    cp -p "$B/.env" "$DIR/.env"
    cp -p "$B/release.env" "$DIR/release/release.env"
    cp -p "$B/haproxy.cfg" "$DIR/socket-proxy/haproxy.cfg"
  }

  install_firewall
  widen_address_pools
  # Installs from before the profile existed run on Ubuntu 24.04 with BuildKit restarting for ever.
  BUILDKIT_AA="$(buildkit_apparmor)" || exit 1
  env_set "$DIR/.env" DOCKIFY_BUILDKIT_APPARMOR "$BUILDKIT_AA" || die "cannot set DOCKIFY_BUILDKIT_APPARMOR in .env"
  apply_layout dir "$DIR"
  make_route_folder
  # Empty until the owner sets email up in Settings: the row, not this file, is what sends.
  [ -f "$DIR/secrets/smtp_password" ] || : > "$DIR/secrets/smtp_password"
  make_link_secrets "$DIR/secrets"
  cp "$TMP/docker-compose.yml" "$DIR/docker-compose.yml"
  cp "$TMP/haproxy.cfg" "$DIR/socket-proxy/haproxy.cfg"
  env_set "$DIR/.env" DOCKIFY_COMPOSE_SHA256 "$(sha256sum "$DIR/docker-compose.yml" | cut -d' ' -f1)" || die "cannot pin the new docker-compose.yml in .env"
  [ -z "$VERSION" ] || env_set "$DIR/.env" DOCKIFY_VERSION "$VERSION"
  # Images from the signed feed: the updater follows the feed and key they were checked against, so an
  # install made without them (from a checkout, or with images given by hand) takes signed updates from
  # here on, and one pinned to another key cannot refuse the release it now runs.
  if [ -n "$VERSION" ]; then
    { env_set "$DIR/.env" DOCKIFY_RELEASE_FEED "$FEED" && env_set "$DIR/.env" DOCKIFY_RELEASE_PUBKEY "$PUBKEY"; } \
      || { restore_files; die "cannot record the release feed and key in .env; the previous files are back"; }
  fi
  if [ -z "$(envget DOCKIFY_SERVER_IPV6)" ]; then
    V6="$(server_ipv6)"
    [ -z "$V6" ] || env_set "$DIR/.env" DOCKIFY_SERVER_IPV6 "$V6" || true
  fi
  # Refreshed each upgrade, so a renamed server shows its new name.
  HN="$(host_name)"
  [ -z "$HN" ] || env_set "$DIR/.env" DOCKIFY_HOST_NAME "$HN" || true
  # And the engine's version, which unattended upgrades move on from what the install recorded.
  DV="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
  [ -z "$DV" ] || env_set "$DIR/.env" DOCKIFY_DOCKER_VERSION "$DV" || true
  printf '# Pinned by digest. The updater rewrites this file.\nDOCKIFY_CONTROL_IMAGE=%s\nDOCKIFY_WEB_IMAGE=%s\n' "$CONTROL_IMAGE" "$WEB_IMAGE" > "$DIR/release/release.env"
  apply_layout file "$DIR"
  if [ -f "$SRC/uninstall.sh" ] && script_dir_is_private "$SRC"; then install -m 0700 -o 0 -g 0 "$SRC/uninstall.sh" "$DIR/uninstall.sh"; fi
  render_wrapper "$DIR" 0 > /usr/local/bin/dockify
  chmod 0755 /usr/local/bin/dockify

  say "Images"
  dockify pull --quiet || { restore_files; die "cannot pull the images; the previous files are back and nothing was recreated"; }

  # One time, for installs from before the image created the work folder: the worker's volume was
  # root's, so every backup failed. Root in a throwaway container with only CAP_CHOWN and no
  # network hands the volume's top folder to uid 1000. A no-op on a volume that already has it.
  say "Work volume"
  docker run --rm --network none --user 0:0 --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges \
    -v dockify_dockify-work:/w --entrypoint /bin/chown "$CONTROL_IMAGE" 1000:1000 /w \
    || warn "could not hand the work volume to uid 1000; backups fail until it is (the worker says so in its log)"

  # A copy of the database to come back to, then the migrations, before any service is recreated.
  say "Migrations"
  dockify exec -T postgres pg_dump -U dockify -d dockify -Fc --no-owner > "$B/control.dump" || { restore_files; die "cannot dump the database before migrating; nothing was changed"; }
  chmod 0600 "$B/control.dump"
  # Postgres moves to its fixed address first: migrate, and everything after it, dials that address.
  # It stays on the old network too, so the api and worker still running reconnect by name.
  up_wait --no-deps postgres || { restore_files; die "postgres did not come back (see: dockify logs postgres); the previous files are back. The database dump from before is $B/control.dump"; }
  dockify run --rm --no-deps migrate || { restore_files; die "migrations failed; the previous files are back and no service was recreated. The database dump from before is $B/control.dump"; }
  record_release_version "$VERSION"

  # One at a time, each waited for. The socket proxy first, recreated even when its compose entry
  # is unchanged, because its allowlist is a mounted file compose does not compare. The control
  # services next: the new agent, told by the new worker, rewrites the route files before the proxy
  # starts watching proxy/conf, so the proxy, recreated last, loads a clean folder. Then the updater.
  say "Services"
  up_wait --no-deps --force-recreate socket-proxy || die "socket-proxy did not come up (see: dockify logs socket-proxy); the previous files are in $B"
  PROXY=proxy-direct
  [ "$INGRESS" = direct ] || PROXY=proxy
  # The agent ahead of the worker: it redials until the new worker listens, and the worker's boot
  # waits for it, so neither holds the other up.
  for s in buildkit api agent worker web "$PROXY"; do up_wait --no-deps "$s" || die "$s did not come up healthy (see: dockify logs $s); the previous files are in $B"; done
  [ "$INGRESS" = direct ] || up_wait --no-deps cloudflared || die "cloudflared did not come up (see: dockify logs cloudflared)"
  dockify up -d --no-deps updater || die "the updater did not start (see: dockify logs updater)"
  # Networks an earlier compose file used and this one does not. Compose leaves them behind.
  for n in dockify_socket dockify_default; do docker network rm "$n" >/dev/null 2>&1 || true; done

  # Tunnel installs from before the api had its own path on the dashboard host.
  if [ "$INGRESS" = tunnel ]; then
    ACC="$(envget DOCKIFY_CF_ACCOUNT_ID)" TUN="$(envget DOCKIFY_CF_TUNNEL_ID)"
    if [ -n "$CF_TOKEN_FILE" ] && [ -n "$ACC" ] && [ -n "$TUN" ]; then
      cf_token_header
      R="$(cf GET "/accounts/$ACC/cfd_tunnel/$TUN/configurations")"; ok "$R" || die "cannot read the tunnel's ingress: $(errs "$R")"
      NEXT="$(printf '%s' "$R" | tunnel_add_dashboard_rules "$DOMAIN")" || die "cannot read the tunnel's ingress"
      [ -n "$NEXT" ] || NEXT="$(printf '%s' "$R" | tunnel_add_api_rule "$DOMAIN")" || die "cannot read the tunnel's ingress"
      if [ -n "$NEXT" ]; then
        R="$(cf PUT "/accounts/$ACC/cfd_tunnel/$TUN/configurations" "$NEXT")"; ok "$R" || die "cannot update the tunnel's ingress: $(errs "$R")"
        note "the tunnel now sends /api/v1/ on $DOMAIN to the api"
      else
        note "the tunnel's api rule was already in place (or its dashboard rule was edited by hand and left alone)"
      fi
    else
      note "the worker adds the tunnel's /api/v1/ rule once Cloudflare is connected in Settings; or run this again with --cf-token-file"
    fi
  fi

  # An install from before email was SMTP: the first-boot key is sealed in the database by now, and
  # no compose file that names this file can come back after this point.
  rm -f "$DIR/secrets/resend_api_key"

  prune_upgrade_backups "$DIR/upgrade-backups" 3
  say "Upgraded"
  note "the previous files and a database dump are in $B"
  note "upgrade-backups keeps the last three; each holds a copy of .env and the whole control database in the clear, root only"
}

if [ "${DOCKIFY_INSTALL_LIB:-}" = 1 ]; then return 0 2>/dev/null || exit 0; fi

TMP="$(mktemp -d)"
# The bootstrap execs this script, which drops its trap, so its temp folder goes here. stty on the terminal:
# stdin is the pipe under `curl | sh`.
cleanup() {
  { stty echo < /dev/tty; } 2>/dev/null || true
  rm -rf "$TMP"
  case "$0" in */tmp.*/installer.sh) ! script_dir_is_private "$(dirname "$0")" || rm -rf "$(dirname "$0")" ;; esac
}
trap cleanup EXIT INT TERM

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --ingress) INGRESS="${2:-}"; shift 2 ;;
    --cf-token-file) CF_TOKEN_FILE="${2:-}"; shift 2 ;;
    --cf-account-id) CF_ACCOUNT_ID="${2:-}"; shift 2 ;;
    --replace-dns) REPLACE_DNS=1; shift ;;
    --acme-email) ACME_EMAIL="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --release-feed) FEED="${2:-}"; shift 2 ;;
    --release-pubkey) PUBKEY="${2:-}"; shift 2 ;;
    --control-image) CONTROL_IMAGE="${2:-}"; shift 2 ;;
    --web-image) WEB_IMAGE="${2:-}"; shift 2 ;;
    --no-ufw) UFW=0; shift ;;
    --allow-vulnerable-runtime) ALLOW_VULN=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --upgrade) UPGRADE=1; shift ;;
    --from-checkout) FROM_CHECKOUT=1; shift ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) die "unknown flag: $1 (see --help)" ;;
  esac
done

# ------------------------------------------------------------------ 1. preflight

say "Preflight"
[ "$(id -u)" = 0 ] || die "run as root (sudo)"
[ -r /etc/os-release ] || die "cannot read /etc/os-release"
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "this installer supports Ubuntu only (found ${ID:-unknown})"
case "${VERSION_ID:-}" in 22.04|24.04|26.04) ;; *) warn "Ubuntu ${VERSION_ID:-?} is untested; 22.04 and 24.04 are supported" ;; esac
case "$(uname -m)" in x86_64|aarch64) ;; *) die "unsupported architecture $(uname -m)" ;; esac
case "$DIR" in /*) ;; *) die "--dir must be an absolute path" ;; esac
# The folder is written into the root-run wrapper and the layout table, so keep it plain.
printf '%s' "$DIR" | grep -Eq '^(/[A-Za-z0-9._-]+)+$' || die "--dir may only use letters, digits, '.', '_', '-' and '/'"
case "$FEED" in ""|https://*) ;; *) die "--release-feed must be https" ;; esac

if [ "$UPGRADE" = 1 ]; then
  upgrade
  exit 0
fi

# An install that wrote its files and then failed to start: no setup token was ever printed.
if [ -f "$DIR/.install-incomplete" ] && [ -f "$DIR/.env" ]; then
  if dockify exec -T api wget -q -T 5 -O /dev/null http://127.0.0.1:3001/readyz 2>/dev/null; then
    rm -f "$DIR/.install-incomplete"
  else
    say "An earlier install in $DIR did not finish starting"
    note "Nothing was changed. See what failed: dockify ps, then dockify logs migrate or dockify logs api"
    note "After fixing it, start the rest with: dockify up -d --wait"
    note "Or start over, which keeps a backup of the secrets: sudo dockify uninstall, then run this again"
    [ ! -s "$DIR/secrets/setup_token" ] || note "The setup token, asked for once to create the owner: $(cat "$DIR/secrets/setup_token")"
    exit 1
  fi
fi

if [ -f "$DIR/.env" ]; then
  say "Dockify is already installed in $DIR"
  note "Nothing was changed. Update from Settings, Updates, or on this server:"
  note "  dockify update apply           the newest signed release, the way the dashboard does it"
  note "  dockify redeploy               recreate the services on the images release.env pins (migrations first)"
  note "  sudo bash install.sh --upgrade this installer's compose file, firewall rules and one-time fixes"
  exit 0
fi

# Data an earlier install kept. Postgres skips its first-run setup on that volume, so it keeps the old
# password, and a new secret could not open it or anything sealed in it. Only that install's secrets can.
REUSE_FROM=""
if kept_database_volume; then
  REUSE_FROM="$(kept_data_backup /root)"
  if [ -n "$REUSE_FROM" ]; then
    say "Found the data of an earlier install"
    note "The volume dockify_dockify-db is kept, so this install uses it, with the secrets in $REUSE_FROM"
    note "To start empty instead, delete that data first: curl -fsSL https://dockify.sh/uninstall.sh | sh -s -- --purge"
  else
    die "the volume dockify_dockify-db holds an earlier install's database, and no /root/dockify-backup-*/secrets has its password and master key. Nothing was changed. Either put that install's secrets/ back in /root/dockify-backup-<any>/, then run this again; or, to delete all of that data for good: curl -fsSL https://dockify.sh/uninstall.sh | sh -s -- --purge"
  fi
fi

# The dashboard's address. None given: ask on the terminal. Enter, or no terminal, starts on the
# server's sslip.io name in direct mode, so a plain `curl | sh` ends at a working https link. The
# owner moves to a real domain later, in Settings, Instance.
case "$INGRESS" in ""|tunnel|direct) ;; *) die "--ingress must be tunnel or direct" ;; esac
TYPED=0
if [ -z "$DOMAIN" ]; then
  SERVER_IP="$(public_ipv4)"
  if [ -n "$SERVER_IP" ]; then HINT="Enter for a temporary address, https://$(sslip_host "$SERVER_IP"), to change later"; else HINT="for example dockify.example.com"; fi
  DOMAIN="$(clean_host "$(ask_tty "Dashboard domain ($HINT): ")")"
  if [ -n "$DOMAIN" ]; then
    TYPED=1
  else
    [ "$INGRESS" != tunnel ] || die "a Cloudflare tunnel needs a domain: pass --domain"
    [ -n "$SERVER_IP" ] || die "this server's public IPv4 address could not be found, so it has no sslip.io name: pass --domain"
    DOMAIN="$(sslip_host "$SERVER_IP")"
    INGRESS=direct
    note "starting on https://$DOMAIN, a temporary address: move to your own domain for real use"
  fi
else
  DOMAIN="$(clean_host "$DOMAIN")"
fi
is_dashboard_host "$DOMAIN" || die "--domain must be a hostname, for example dockify.example.com"
# Typed at the prompt: ask how the server is reached. Given as a flag: a tunnel, as it always was.
if [ -z "$INGRESS" ] && [ "$TYPED" = 1 ]; then
  case "$(ask_tty "Reach this server on ports 80 and 443 (Enter), or through a Cloudflare tunnel (t)? ")" in t|T|tunnel) INGRESS=tunnel ;; *) INGRESS=direct ;; esac
fi
[ -n "$INGRESS" ] || INGRESS=tunnel
if [ "$INGRESS" = direct ]; then
  [ -n "$ACME_EMAIL" ] || ACME_EMAIL="$(ask_tty "Email for Let's Encrypt (Enter to skip): " | tr -d '[:space:]')"
  [ -n "$ACME_EMAIL" ] || ACME_EMAIL="dockify@$DOMAIN"
  printf '%s' "$ACME_EMAIL" | grep -Eq '^[^@ ]+@[^@ ]+\.[^@ ]+$' || die "--acme-email must be an email address"
fi
for ref in "$CONTROL_IMAGE" "$WEB_IMAGE"; do
  [ -z "$ref" ] || printf '%s' "$ref" | grep -Eq '@sha256:[a-f0-9]{64}$' || die "image references must be pinned by digest (...@sha256:<64 hex>)"
done
if [ -n "$CONTROL_IMAGE$WEB_IMAGE" ] && { [ -z "$CONTROL_IMAGE" ] || [ -z "$WEB_IMAGE" ]; }; then die "pass both --control-image and --web-image"; fi
if [ -z "$CONTROL_IMAGE" ] && { [ -z "$FEED" ] || [ -z "$PUBKEY" ]; }; then
  die "no release source: pass --release-feed and --release-pubkey, or --control-image and --web-image"
fi

# Optional integrations from the environment, checked before anything changes.
SMTP_HOST="${DOCKIFY_SMTP_HOST:-}" SMTP_PORT="${DOCKIFY_SMTP_PORT:-}" SMTP_USER="${DOCKIFY_SMTP_USER:-}" SMTP_PASSWORD="${DOCKIFY_SMTP_PASSWORD:-}"
EMAIL_FROM="${DOCKIFY_EMAIL_FROM:-}" EMAIL_FROM_NAME="${DOCKIFY_EMAIL_FROM_NAME:-}"
if [ -n "${DOCKIFY_SMTP_PASSWORD_FILE:-}" ]; then
  [ -r "$DOCKIFY_SMTP_PASSWORD_FILE" ] || die "DOCKIFY_SMTP_PASSWORD_FILE is not readable"
  SMTP_PASSWORD="$(tr -d '\r\n' < "$DOCKIFY_SMTP_PASSWORD_FILE")"
fi
if [ -n "$SMTP_HOST$SMTP_USER$SMTP_PASSWORD$EMAIL_FROM" ]; then
  SMTP_HOST="$(printf '%s' "$SMTP_HOST" | tr '[:upper:]' '[:lower:]')"
  printf '%s' "$SMTP_HOST" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' || die "DOCKIFY_SMTP_HOST must be your mail server's host name"
  SMTP_PORT="${SMTP_PORT:-587}"
  case "$SMTP_PORT" in 25|465|587|2465|2525|2587) ;; *) die "DOCKIFY_SMTP_PORT must be one of 25, 465, 587, 2465, 2525 or 2587" ;; esac
  printf '%s' "$SMTP_USER" | grep -Eq '^[A-Za-z0-9._%+@-]{1,254}$' || die "DOCKIFY_SMTP_USER must be the mail server's username"
  [ -n "$SMTP_PASSWORD" ] || die "DOCKIFY_SMTP_PASSWORD or DOCKIFY_SMTP_PASSWORD_FILE is required with DOCKIFY_SMTP_HOST"
  EMAIL_FROM="$(printf '%s' "$EMAIL_FROM" | tr '[:upper:]' '[:lower:]')"
  printf '%s' "$EMAIL_FROM" | grep -Eq '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}$' || die "DOCKIFY_EMAIL_FROM must be an address your mail server may send from"
fi
# Written unquoted into .env, so only plain characters survive.
EMAIL_FROM_NAME="$(printf '%s' "$EMAIL_FROM_NAME" | tr -cd 'A-Za-z0-9 ._-' | cut -c1-60)"
GH_APP_ID="${DOCKIFY_GITHUB_APP_ID:-}" GH_APP_SLUG="${DOCKIFY_GITHUB_APP_SLUG:-}" GH_KEY_FILE="${DOCKIFY_GITHUB_APP_PRIVATE_KEY_FILE:-}"
GH_HOOK="${DOCKIFY_GITHUB_WEBHOOK_SECRET:-}"
if [ -n "${DOCKIFY_GITHUB_WEBHOOK_SECRET_FILE:-}" ]; then
  [ -r "$DOCKIFY_GITHUB_WEBHOOK_SECRET_FILE" ] || die "DOCKIFY_GITHUB_WEBHOOK_SECRET_FILE is not readable"
  GH_HOOK="$(tr -d '\r\n' < "$DOCKIFY_GITHUB_WEBHOOK_SECRET_FILE")"
fi
if [ -n "$GH_APP_ID$GH_APP_SLUG$GH_KEY_FILE$GH_HOOK" ]; then
  printf '%s' "$GH_APP_ID" | grep -Eq '^[0-9]{1,12}$' || die "DOCKIFY_GITHUB_APP_ID must be the App's numeric id"
  printf '%s' "$GH_APP_SLUG" | grep -Eq '^[a-z0-9][a-z0-9-]{0,99}$' || die "DOCKIFY_GITHUB_APP_SLUG must be the App's slug"
  { [ -r "$GH_KEY_FILE" ] && grep -q 'BEGIN .*PRIVATE KEY' "$GH_KEY_FILE"; } || die "DOCKIFY_GITHUB_APP_PRIVATE_KEY_FILE must be a readable PEM private key"
  [ -n "$GH_HOOK" ] || die "set DOCKIFY_GITHUB_WEBHOOK_SECRET or DOCKIFY_GITHUB_WEBHOOK_SECRET_FILE for the GitHub App"
fi

if [ "$INGRESS" = direct ] && command -v ss >/dev/null 2>&1; then
  for p in 80 443; do
    if ss -ltnH "sport = :$p" 2>/dev/null | grep -q .; then die "port $p is already in use; direct mode needs it"; fi
  done
fi
[ "$DRY" = 1 ] && note "dry run: nothing will be changed"

# ------------------------------------------------------------------ 2. host hardening

say "Host packages and security updates"
export DEBIAN_FRONTEND=noninteractive
run apt-get update -qq
run apt-get install -y -qq ca-certificates curl jq openssl gnupg unattended-upgrades iptables >/dev/null
if [ "$DRY" = 0 ]; then
  cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  render_docker_upgrades > /etc/apt/apt.conf.d/52dockify-docker
  chmod 0644 /etc/apt/apt.conf.d/52dockify-docker
fi
note "unattended upgrades are on for: Ubuntu ${VERSION_CODENAME:-} security (and ESM security when enabled), Docker (download.docker.com)"
note "kernel fixes still need a reboot: reboot after updates, or set Unattended-Upgrade::Automatic-Reboot \"true\" in /etc/apt/apt.conf.d/50unattended-upgrades"

if [ "$UFW" = 1 ]; then
  SSH_PORTS="$(ssh_ports)"
  [ -n "$SSH_PORTS" ] || SSH_PORTS=22
  run apt-get install -y -qq ufw >/dev/null
  for p in $SSH_PORTS; do run ufw allow "$p/tcp" >/dev/null; done
  if [ "$INGRESS" = direct ]; then run ufw allow 80/tcp >/dev/null; run ufw allow 443/tcp >/dev/null; fi
  run ufw default deny incoming >/dev/null
  run ufw --force enable >/dev/null
  note "ufw allows ssh ($(echo $SSH_PORTS))$([ "$INGRESS" = direct ] && echo ', 80 and 443')"
fi

# ------------------------------------------------------------------ 3. Docker

ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker Engine"
  run install -m 0755 -d /etc/apt/keyrings
  if [ "$DRY" = 0 ]; then
    curl -fsSL --proto '=https' https://download.docker.com/linux/ubuntu/gpg -o "$TMP/docker.asc"
    FPR="$(gpg --show-keys --with-colons "$TMP/docker.asc" 2>/dev/null | awk -F: '/^fpr/ { print $10; exit }')"
    [ "$FPR" = "$DOCKER_GPG_FINGERPRINT" ] || die "Docker's apt key has an unexpected fingerprint ($FPR)"
    install -m 0644 "$TMP/docker.asc" /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  fi
  run apt-get update -qq
  run apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  run systemctl enable --now docker >/dev/null
fi

# ------------------------------------------------------------------ 4. runtime versions

say "Checking the container runtime"
if [ "$DRY" = 0 ]; then
  ENGINE="$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 0)"
  ver_ge "$ENGINE" 25.0.0 || die "Docker Engine $ENGINE is too old; 25.0 or newer is required"
  COMPOSE="$(docker compose version --short 2>/dev/null | sed 's/^v//' || echo 0)"
  ver_ge "$COMPOSE" 2.24.0 || die "docker compose $COMPOSE is too old; 2.24 or newer is required"

  RUNC="$(runc --version 2>/dev/null | awk '/^runc version/ { print $3 }')"
  CONTAINERD="$(containerd --version 2>/dev/null | awk '{ print $3 }' | sed 's/^v//')"
  vuln=""
  # runc container escapes CVE-2025-31133, CVE-2025-52565, CVE-2025-52881: fixed in 1.2.8, 1.3.3, 1.4.0-rc.3.
  case "$RUNC" in
    "") vuln="runc version unknown" ;;
    1.2.*) ver_ge "$RUNC" 1.2.8 || vuln="runc $RUNC (needs 1.2.8 or newer)" ;;
    1.3.*) ver_ge "$RUNC" 1.3.3 || vuln="runc $RUNC (needs 1.3.3 or newer)" ;;
    1.4.0-rc.1*|1.4.0-rc.2*) vuln="runc $RUNC (needs 1.4.0-rc.3 or newer)" ;;
    1.[4-9].*|1.[1-9][0-9].*|[2-9].*) ;;
    *) vuln="runc $RUNC (needs 1.2.8, 1.3.3 or newer)" ;;
  esac
  # containerd CVE-2024-40635: fixed in 1.7.27 and 2.0.4.
  case "$CONTAINERD" in
    "") vuln="${vuln:+$vuln; }containerd version unknown" ;;
    1.7.*) ver_ge "$CONTAINERD" 1.7.27 || vuln="${vuln:+$vuln; }containerd $CONTAINERD (needs 1.7.27 or newer)" ;;
    2.0.*) ver_ge "$CONTAINERD" 2.0.4 || vuln="${vuln:+$vuln; }containerd $CONTAINERD (needs 2.0.4 or newer)" ;;
    1.[0-6].*) vuln="${vuln:+$vuln; }containerd $CONTAINERD is unsupported" ;;
  esac
  if [ -n "$vuln" ]; then
    msg="vulnerable container runtime: $vuln. Upgrade with: apt-get install --only-upgrade containerd.io docker-ce"
    if [ "$ALLOW_VULN" = 1 ]; then warn "$msg"; else die "$msg (or pass --allow-vulnerable-runtime)"; fi
  fi
  note "Docker $ENGINE, compose $COMPOSE, runc $RUNC, containerd $CONTAINERD"
  # Say exactly which origin keeps each runtime patched, and warn when none does.
  for b in runc containerd; do
    set -- $(runtime_update_source "$b")
    case "$1" in
      docker) note "$b updates automatically from download.docker.com (package $2)" ;;
      distro) note "$b updates automatically through the distribution's security pocket (package $2)" ;;
      *) warn "$b is not from an apt repository (${2}); it will NOT update automatically, patch it by hand" ;;
    esac
  done
fi

# ------------------------------------------------------------------ 5. firewall rules for containers

install_firewall
widen_address_pools
BUILDKIT_AA="$(buildkit_apparmor)"
[ "$BUILDKIT_AA" = unconfined ] || note "AppArmor profile $BUILDKIT_AA loaded: this kernel restricts user namespaces, and rootless BuildKit needs one"

# ------------------------------------------------------------------ 6. signed release

# Before anything at Cloudflare exists: a bad feed or a wrong flag must not leave a tunnel behind.
resolve_release
fetch_stack_files

# ------------------------------------------------------------------ 7. ingress

TUNNEL_TOKEN="" TUNNEL_ID="" RECORD_ID=""
if [ "$INGRESS" = tunnel ] && [ "$DRY" = 1 ] && ! command -v jq >/dev/null 2>&1; then
  # A dry run installs nothing, and every Cloudflare answer is read with jq.
  say "Cloudflare tunnel"
  note "[dry-run] jq is not installed yet (the real run installs it first), so the token, account, zone and DNS record checks are skipped"
  note "[dry-run] would create a new tunnel and route $DOMAIN to it"
elif [ "$INGRESS" = tunnel ]; then
  say "Cloudflare tunnel"
  cf_token_header ask

  R="$(cf GET /user/tokens/verify)"; ok "$R" || die "Cloudflare rejected the token: $(errs "$R")"
  if [ -z "$CF_ACCOUNT_ID" ]; then
    R="$(cf GET '/accounts?per_page=50')"; ok "$R" || die "cannot list accounts: $(errs "$R")"
    n="$(printf '%s' "$R" | jq '.result | length')"
    [ "$n" = 1 ] || die "the token sees $n accounts; pass --cf-account-id"
    CF_ACCOUNT_ID="$(printf '%s' "$R" | jq -r '.result[0].id')"
  fi

  ZONE_ID="" cand="$DOMAIN"
  while printf '%s' "$cand" | grep -q '\.'; do
    R="$(cf GET "/zones?name=$cand&status=active")"
    if ok "$R" && [ "$(printf '%s' "$R" | jq '.result | length')" -gt 0 ]; then ZONE_ID="$(printf '%s' "$R" | jq -r '.result[0].id')"; break; fi
    cand="${cand#*.}"
  done
  [ -n "$ZONE_ID" ] || die "no active Cloudflare zone for $DOMAIN under this token"
  note "zone $cand"

  # Existing records are never overwritten silently: only a CNAME, and only with --replace-dns.
  R="$(cf GET "/zones/$ZONE_ID/dns_records?name=$DOMAIN")"; ok "$R" || die "cannot read DNS: $(errs "$R")"
  EXIST_ID="$(printf '%s' "$R" | jq -r '.result[0].id // empty')"
  EXIST_TYPE="$(printf '%s' "$R" | jq -r '.result[0].type // empty')"
  if [ -n "$EXIST_ID" ]; then
    [ "$REPLACE_DNS" = 1 ] || die "$DOMAIN already has a $EXIST_TYPE record. Pick another hostname or pass --replace-dns"
    [ "$EXIST_TYPE" = CNAME ] || die "$DOMAIN has a $EXIST_TYPE record; only a CNAME can be replaced"
  fi

  # Always a NEW tunnel with a unique name: reusing one would take over another box's routes.
  NAME="dockify-$(hostname -s | tr -cd 'a-z0-9-' | cut -c1-20)-$(openssl rand -hex 3)"
  if [ "$DRY" = 1 ]; then
    note "[dry-run] would create tunnel $NAME and route $DOMAIN to it"
  else
    R="$(cf POST "/accounts/$CF_ACCOUNT_ID/cfd_tunnel" "$(jq -nc --arg n "$NAME" '{name: $n, config_src: "cloudflare"}')")"
    ok "$R" || die "cannot create the tunnel: $(errs "$R")"
    TUNNEL_ID="$(printf '%s' "$R" | jq -r '.result.id')"
    R="$(cf GET "/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token")"; ok "$R" || die "cannot read the tunnel token: $(errs "$R")"
    TUNNEL_TOKEN="$(printf '%s' "$R" | jq -r '.result')"
    # A brand-new tunnel has no ingress to merge with: the dashboard's api path, the rest of the
    # dashboard, then every other hostname to the proxy (render_tunnel_ingress above).
    ING="$(render_tunnel_ingress "$DOMAIN")" || die "cannot build the tunnel ingress for $DOMAIN"
    R="$(cf PUT "/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" "$ING")"; ok "$R" || die "cannot write the tunnel ingress: $(errs "$R")"
    REC="$(jq -nc --arg n "$DOMAIN" --arg c "$TUNNEL_ID.cfargotunnel.com" '{type: "CNAME", name: $n, content: $c, proxied: true, comment: "managed by Dockify"}')"
    if [ -n "$EXIST_ID" ]; then R="$(cf PUT "/zones/$ZONE_ID/dns_records/$EXIST_ID" "$REC")"; else R="$(cf POST "/zones/$ZONE_ID/dns_records" "$REC")"; fi
    ok "$R" || die "cannot write the DNS record: $(errs "$R")"
    RECORD_ID="$(printf '%s' "$R" | jq -r '.result.id')"
    note "tunnel $NAME ($TUNNEL_ID), $DOMAIN routed"
  fi
else
  say "Direct mode"
  case "$DOMAIN" in
    *.sslip.io) note "$DOMAIN already leads here: sslip.io answers with the address in the name" ;;
    *) note "$DOMAIN must have an A or AAAA record pointing at this server" ;;
  esac
fi

# ------------------------------------------------------------------ 8. files and start

say "Writing $DIR"
if [ "$DRY" = 1 ]; then
  note "[dry-run] would write .env, release.env, secrets/ and start the stack"
  exit 0
fi

token() { openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'; }
apply_layout dir "$DIR"
make_route_folder
# Every secret of the earlier install first: each line below keeps what is already there.
if [ -n "$REUSE_FROM" ]; then cp -pR "$REUSE_FROM/secrets/." "$DIR/secrets/"; fi
[ -s "$DIR/secrets/master_key" ] || openssl rand -base64 32 | tr -d '\n' > "$DIR/secrets/master_key"
# Empty until a key rotation puts the old key here (see the security docs).
[ -f "$DIR/secrets/master_key_previous" ] || : > "$DIR/secrets/master_key_previous"
[ -s "$DIR/secrets/postgres_password" ] || openssl rand -hex 24 | tr -d '\n' > "$DIR/secrets/postgres_password"
[ -s "$DIR/secrets/setup_token" ] || token > "$DIR/secrets/setup_token"
[ -s "$DIR/secrets/internal_token" ] || token > "$DIR/secrets/internal_token"
make_link_secrets "$DIR/secrets"
# Optional DNS-01 token for preview wildcard certificates in direct mode; empty until the owner adds one.
[ -f "$DIR/secrets/cf_dns_token" ] || : > "$DIR/secrets/cf_dns_token"
# Optional integrations: the api seeds them once on first boot. Empty files mean not configured.
if [ -z "$REUSE_FROM" ] || [ -n "$SMTP_PASSWORD" ]; then printf '%s' "$SMTP_PASSWORD" > "$DIR/secrets/smtp_password"; fi
[ -f "$DIR/secrets/smtp_password" ] || : > "$DIR/secrets/smtp_password"
if [ -n "$GH_KEY_FILE" ]; then cat "$GH_KEY_FILE" > "$DIR/secrets/github_app_private_key"; elif [ ! -f "$DIR/secrets/github_app_private_key" ]; then : > "$DIR/secrets/github_app_private_key"; fi
if [ -n "$GH_HOOK" ] || [ ! -f "$DIR/secrets/github_webhook_secret" ]; then printf '%s' "$GH_HOOK" > "$DIR/secrets/github_webhook_secret"; fi
cp "$TMP/docker-compose.yml" "$DIR/docker-compose.yml"
cp "$TMP/haproxy.cfg" "$DIR/socket-proxy/haproxy.cfg"
# The uninstaller `dockify uninstall` runs: next to this script in a checkout, or fetched and
# verified by the bootstrap. Without it the wrapper downloads the published one, checksum-verified.
if [ -f "$SRC/uninstall.sh" ] && script_dir_is_private "$SRC"; then install -m 0700 -o 0 -g 0 "$SRC/uninstall.sh" "$DIR/uninstall.sh"; fi
# Pinned in the root-owned .env; the updater refuses to run a compose file that no longer matches.
COMPOSE_PIN="$(sha256sum "$DIR/docker-compose.yml" | cut -d' ' -f1)"

DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)"
# What domains' A records point at: the public address, also behind NAT; else the interface's.
PUBLIC_IP="$(public_ipv4)"
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }')"
PUBLIC_IP6="$(server_ipv6)"
{
  echo "# Written by install.sh on $(date -u +%FT%TZ). Secrets live in secrets/, but for TUNNEL_TOKEN, which cloudflared reads from here."
  echo "DOCKIFY_DIR=$DIR"
  echo "DOCKIFY_PUBLIC_URL=https://$DOMAIN"
  echo "DOCKIFY_DOCKER_GID=$DOCKER_GID"
  echo "DOCKIFY_VERSION=${VERSION:-0.0.0-dev}"
  echo "DOCKIFY_COMPOSE_SHA256=$COMPOSE_PIN"
  echo "DOCKIFY_RELEASE_FEED=$FEED"
  echo "DOCKIFY_RELEASE_PUBKEY=$PUBKEY"
  echo "DOCKIFY_HOST_OS=${PRETTY_NAME:-Ubuntu}"
  HN="$(host_name)"
  [ -z "$HN" ] || echo "DOCKIFY_HOST_NAME=$HN"
  echo "DOCKIFY_DOCKER_VERSION=$(docker version --format '{{.Server.Version}}')"
  echo "DOCKIFY_PUBLIC_IP=${PUBLIC_IP:-}"
  echo "DOCKIFY_BUILDKIT_APPARMOR=$BUILDKIT_AA"
  # The A record target for direct mode; only an IPv4 address is accepted by the api and worker.
  if printf '%s' "${PUBLIC_IP:-}" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then echo "DOCKIFY_SERVER_IPV4=$PUBLIC_IP"; fi
  # The AAAA target, when the server has a global IPv6 address.
  [ -z "$PUBLIC_IP6" ] || echo "DOCKIFY_SERVER_IPV6=$PUBLIC_IP6"
  echo "LOG_LEVEL=info"
  if [ -n "$SMTP_HOST" ]; then
    echo "DOCKIFY_SMTP_HOST=$SMTP_HOST"
    echo "DOCKIFY_SMTP_PORT=$SMTP_PORT"
    echo "DOCKIFY_SMTP_USER=$SMTP_USER"
  fi
  if [ -n "$EMAIL_FROM" ]; then
    echo "DOCKIFY_EMAIL_FROM=$EMAIL_FROM"
    [ -z "$EMAIL_FROM_NAME" ] || echo "DOCKIFY_EMAIL_FROM_NAME=$EMAIL_FROM_NAME"
  fi
  if [ -n "$GH_APP_ID" ]; then
    echo "DOCKIFY_GITHUB_APP_ID=$GH_APP_ID"
    echo "DOCKIFY_GITHUB_APP_SLUG=$GH_APP_SLUG"
  fi
  if [ "$INGRESS" = tunnel ]; then
    echo "COMPOSE_PROFILES=tunnel"
    echo "DOCKIFY_INGRESS=cloudflare_tunnel"
    echo "TUNNEL_TOKEN=$TUNNEL_TOKEN"
    echo "DOCKIFY_CF_ACCOUNT_ID=$CF_ACCOUNT_ID"
    echo "DOCKIFY_CF_TUNNEL_ID=$TUNNEL_ID"
    echo "DOCKIFY_CF_DASHBOARD_RECORD_ID=$RECORD_ID"
  else
    echo "COMPOSE_PROFILES=direct"
    echo "DOCKIFY_INGRESS=direct_tls"
    echo "DOCKIFY_ACME_EMAIL=$ACME_EMAIL"
  fi
} > "$DIR/.env"
printf '# Pinned by digest. The updater rewrites this file.\nDOCKIFY_CONTROL_IMAGE=%s\nDOCKIFY_WEB_IMAGE=%s\n' "$CONTROL_IMAGE" "$WEB_IMAGE" > "$DIR/release/release.env"
apply_layout file "$DIR"
# Gone once it is ready. A run that finds it knows this install never finished, which .env alone cannot say.
: > "$DIR/.install-incomplete"

render_wrapper "$DIR" 0 > /usr/local/bin/dockify
chmod 0755 /usr/local/bin/dockify

say "Starting"
dockify pull --quiet
NOT_UP="the stack did not come up healthy"
[ -z "$REUSE_FROM" ] || NOT_UP="$NOT_UP. If migrate cannot sign in to the database, $REUSE_FROM is not the backup of the install that made the volume: run sudo dockify uninstall, then put the right secrets in a backup folder, or delete the data with --purge"
up_wait || { dockify ps; dockify logs --tail 40; die "$NOT_UP"; }

# ------------------------------------------------------------------ 9. ready

say "Waiting for readiness"
i=0
until dockify exec -T api wget -q -T 5 -O /dev/null http://127.0.0.1:3001/readyz 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -lt 90 ] || { dockify logs --tail 40 api; die "the api did not become ready in 180 s"; }
  sleep 2
done

# Direct mode: the dashboard's first certificate takes a moment, so the link printed below works when
# it is printed. Reaching this server's own public name from itself can fail behind some NAT, and that
# says nothing about the outside, so this only ever warns.
if [ "$INGRESS" = direct ]; then
  say "Waiting for the certificate"
  i=0
  until curl -sS --proto '=https' --max-time 8 -o /dev/null "https://$DOMAIN/setup" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 30 ]; then
      warn "https://$DOMAIN does not answer with a valid certificate from this server yet; it may still be issuing. See: dockify logs proxy-direct"
      break
    fi
    sleep 4
  done
fi

rm -f "$DIR/.install-incomplete"
record_release_version "${REUSE_FROM:+$VERSION}"

if [ -n "$REUSE_FROM" ]; then
  FIRST_STEP="Open    https://$DOMAIN
  Your accounts and projects are as the earlier install left them. Sign in as before.
$(kept_data_apps_step "$INGRESS")"
else
  FIRST_STEP="Open    https://$DOMAIN/setup
  Setup token (asked for once, to create the owner):
          $(cat "$DIR/secrets/setup_token")"
fi

cat <<EOF

  Dockify is running.

  $FIRST_STEP

  BACK UP THE MASTER KEY NOW. Without it, every stored secret and backup is unreadable:
          $DIR/secrets/master_key

  Your own domain, any time: Settings, Instance, Dashboard domain. An sslip.io address is temporary:
  it depends on a free third-party service, so use your own domain for real use.
  If the dashboard cannot be reached:
                         sudo dockify admin set-domain <host>

  Manage the stack with: dockify ps | dockify logs api
  Updates install themselves (Settings, Updates). By hand:
                         dockify update status | check | apply | rollback
  Recreate the services on the pinned images (migrations first):
                         dockify redeploy
  Apply a newer installer (compose file, firewall rules, one-time fixes, as root):
                         sudo bash install.sh --upgrade
  Locked out of an account (lost authenticator or password), on this server:
                         dockify admin disable-mfa <email> | reset-password <email>
  Reach it over SSH, sign in included:
                         ssh -N -L ${DOCKIFY_PORT:-3000}:127.0.0.1:${DOCKIFY_PORT:-3000} root@this-server, then http://127.0.0.1:${DOCKIFY_PORT:-3000}

EOF
