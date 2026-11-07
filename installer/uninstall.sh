#!/usr/bin/env bash
# Dockify uninstaller, as root:
#
#   curl -fsSL https://dockify.sh/uninstall.sh | sh
#   sudo dockify uninstall
#
# The one-liner fetches installer/uninstall-bootstrap.sh, which verifies this file by SHA-256 and
# runs it as root. On the server, `dockify uninstall` runs the copy the installer put in the
# install folder. Run directly, it is:  sudo bash uninstall.sh [flags]
#
# It removes what install.sh wrote, in this order, after showing the plan and asking you to type
# the dashboard domain (or "uninstall" when there is none):
#   1. a backup of the master key, secrets/, .env and release.env in /root/dockify-backup-<ts>/
#   2. the Dockify stack (compose project "dockify"), then every dockify.managed=true container
#   3. dockify-firewall.service, /usr/local/sbin/dockify-firewall and its live iptables rules
#   4. the `dockify` wrapper in /usr/local/bin, /etc/apt/apt.conf.d/52dockify-docker and the AppArmor
#      profile /etc/apparmor.d/dockify-buildkit (Ubuntu 24.04), unloaded first
#   5. tunnel mode: the Cloudflare tunnel dockify-<host>-<id> and every CNAME pointing at it,
#      through the Cloudflare API when a token is available, else it prints what to delete by hand
#   6. with --purge only: every Dockify volume, network, built image and Dockify's own images
#      (control, web, Postgres, Traefik, BuildKit, the socket proxy, cloudflared); one another
#      container still uses stays, and it says so
#   7. the install folder
#
# It keeps Docker, ufw and its rules, unattended-upgrades and Docker's apt repository, images your
# apps pulled (Dockify cannot tell them from yours), and /etc/docker/daemon.json with the address
# pools the installer added: that file may hold your other settings, and a change to it takes a
# Docker restart. It never edits that file and never restarts Docker. It prints all of this.
#
# Flags:
#   --dry-run            print the plan and change nothing
#   --yes                skip the confirmation prompts (for automation)
#   --keep-data          the default: keep Dockify's volumes and the apps' volumes and networks
#   --purge              also delete every Dockify volume, network and image (asks twice)
#   --no-backup          with --purge, skip the backup of the master key and secrets
#   --reboot             reboot when done, to start from a clean firewall state
#   --dir PATH           install folder, default /opt/dockify (or the one the wrapper names)
#   --cf-token-file PATH Cloudflare API token for the tunnel cleanup (Account:Cloudflare Tunnel:Edit,
#                        Zone:DNS:Edit). Otherwise DOCKIFY_CF_API_TOKEN, secrets/cf_api_token, or a
#                        hidden prompt on the terminal
set -euo pipefail
umask 077

# Everything runs inside main, so bash has read the whole file before the install folder that may
# hold it is deleted.
main() {

# DOCKIFY_UNINSTALL_ROOT is for the test suite only: every host path is taken under it and the root
# check is skipped. Never set it on a server.
ROOT="${DOCKIFY_UNINSTALL_ROOT:-}"
CF_API="https://api.cloudflare.com/client/v4"
[ -z "$ROOT" ] || CF_API="${DOCKIFY_UNINSTALL_CF_API:-$CF_API}"

DIR="" PURGE=0 YES=0 DRY=0 REBOOT=0 BACKUP=1 CF_TOKEN_FILE=""
W_WRAPPER="$ROOT/usr/local/bin/dockify"
W_FWBIN="$ROOT/usr/local/sbin/dockify-firewall"
W_UNIT="$ROOT/etc/systemd/system/dockify-firewall.service"
W_APT="$ROOT/etc/apt/apt.conf.d/52dockify-docker"
W_AA="$ROOT/etc/apparmor.d/dockify-buildkit"
DAEMON_JSON="$ROOT/etc/docker/daemon.json"
BACKUP_PARENT="$ROOT/root"
PROJECT=dockify

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --keep-data) PURGE=0; shift ;;
    --purge) PURGE=1; shift ;;
    --no-backup) BACKUP=0; shift ;;
    --reboot) REBOOT=1; shift ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --cf-token-file) CF_TOKEN_FILE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,39p' "$SELF"; exit 0 ;;
    *) die "unknown flag: $1 (see --help)" ;;
  esac
done
[ "$PURGE" = 1 ] || BACKUP=1

# ------------------------------------------------------------------ preflight

if [ -z "$ROOT" ]; then
  [ "$(id -u)" = 0 ] || die "run as root (sudo)"
fi
if [ -z "$DIR" ]; then
  DIR=/opt/dockify
  if [ ! -d "$ROOT$DIR" ] && [ -f "$W_WRAPPER" ]; then
    w="$(sed -n "s/^D='\(.*\)'\$/\1/p" "$W_WRAPPER" | head -n1)"
    [ -z "$w" ] || DIR="$w"
  fi
  DIR="$ROOT$DIR"
fi
case "$DIR" in /*) ;; *) die "--dir must be an absolute path" ;; esac
printf '%s' "$DIR" | grep -Eq '^(/[A-Za-z0-9._-]+)+$' || die "--dir may only use letters, digits, '.', '_', '-' and '/'"
case "$DIR/" in */../*|*/./*) die "--dir must be a plain path, with no . or .. in it" ;; esac
case "${DIR%/}" in /|/root|/home|/etc|/usr|/usr/local|/var|/opt|/srv|/tmp|/boot|/bin|/sbin|/lib) die "refusing to treat $DIR as the install folder" ;; esac
# Never delete a folder that does not look like a Dockify install. Any project has a .env or a compose
# file, so those have to name Dockify; what an interrupted uninstall left still has one of the three.
if [ -d "$DIR" ] && ! grep -qs '^DOCKIFY_PUBLIC_URL=' "$DIR/.env" && ! grep -qs 'DOCKIFY_PUBLIC_URL' "$DIR/docker-compose.yml" && [ ! -f "$DIR/secrets/master_key" ]; then
  die "$DIR has no .env or docker-compose.yml naming DOCKIFY_PUBLIC_URL, and no secrets/master_key; it does not look like a Dockify install"
fi

TMP="$(mktemp -d)"
STARTED=0 FINISHED=0 BACKUP_DIR=""
LEFT=() STILL=()
trap on_exit EXIT
trap 'exit 130' INT TERM

# Prompts read the terminal on fd 3, so `curl | sh` can still confirm. The test suite points the
# sandbox at a file of answers instead.
# Prompts go to fd 4: the terminal, or stderr in the sandbox.
TTY_IN=/dev/tty HAVE_TTY=0
[ -z "$ROOT" ] || TTY_IN="${DOCKIFY_UNINSTALL_TTY:-/nonexistent}"
if [ "$YES" = 0 ] && (: < "$TTY_IN") 2>/dev/null; then
  exec 3< "$TTY_IN"; HAVE_TTY=1
  if [ -z "$ROOT" ]; then exec 4> /dev/tty; else exec 4>&2; fi
fi

# The facts the plan needs. .env is read line by line, never sourced.
ENV_FILE="$DIR/.env"
PENDING_BACKUP=""
if [ ! -f "$ENV_FILE" ]; then
  # A re-run after the folder is gone: a backup marked cloudflare-pending still knows the tunnel.
  # Timestamped names sort by time; the glob sorts ascending, so the last match wins.
  for b in "$BACKUP_PARENT"/dockify-backup-*; do
    if [ -f "$b/cloudflare-pending" ] && [ -f "$b/.env" ]; then ENV_FILE="$b/.env"; PENDING_BACKUP="$b"; fi
  done
fi
DOMAIN="$(env_get DOCKIFY_PUBLIC_URL)"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%%/*}"
INGRESS="$(env_get DOCKIFY_INGRESS)"
CF_ACCOUNT="$(env_get DOCKIFY_CF_ACCOUNT_ID)"
CF_TUNNEL="$(env_get DOCKIFY_CF_TUNNEL_ID)"
CF_RECORD="$(env_get DOCKIFY_CF_DASHBOARD_RECORD_ID)"
[[ "$CF_ACCOUNT$CF_TUNNEL$CF_RECORD" =~ ^[A-Za-z0-9-]*$ ]] || die "$ENV_FILE has malformed Cloudflare ids"
[[ "$DOMAIN" =~ ^[a-z0-9.-]*$ ]] || DOMAIN=""

DOCKER=0
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then DOCKER=1; else DOCKER=2; fi
fi
STACK=() APPS=() VOLS=() NETS=() IMGS=() OWN=()
inventory

# ------------------------------------------------------------------ plan

say "Dockify uninstall"
note "install folder  ${DIR}$([ -d "$DIR" ] || echo ' (already gone)')"
[ -z "$DOMAIN" ] || note "dashboard       $DOMAIN ($([ "$INGRESS" = direct_tls ] && echo direct mode || echo tunnel mode))"
note "mode            $([ "$PURGE" = 1 ] && echo '--purge: data is deleted' || echo '--keep-data: data is kept')"

say "Will remove"
NOTHING=1
if [ "$DOCKER" = 1 ]; then
  item "${#STACK[@]}" "the Dockify stack: ${#STACK[@]} container(s) of compose project $PROJECT"
  item "${#APPS[@]}" "app containers Dockify deployed: ${#APPS[@]}"; list "${APPS[@]}"
fi
item "$(exists "$W_UNIT" "$W_FWBIN")" "dockify-firewall.service, /usr/local/sbin/dockify-firewall and their iptables rules"
item "$(exists "$W_WRAPPER")" "/usr/local/bin/dockify"
item "$(exists "$W_APT")" "/etc/apt/apt.conf.d/52dockify-docker"
item "$(exists "$W_AA")" "the AppArmor profile /etc/apparmor.d/dockify-buildkit"
if [ -n "$CF_TUNNEL" ]; then
  item 1 "Cloudflare tunnel $CF_TUNNEL and the DNS records pointing at $CF_TUNNEL.cfargotunnel.com"
  if [ -n "$(cf_token_source)" ]; then note "    using the Cloudflare token from $(cf_token_source)"
  elif [ "$HAVE_TTY" = 1 ]; then note "    asks for a Cloudflare token; without one it prints what to delete by hand"
  else note "    no Cloudflare token: it prints what to delete by hand"; fi
fi
if [ "$PURGE" = 1 ] && [ "$DOCKER" = 1 ]; then
  item "${#VOLS[@]}" "volumes, with every database and file stored in them: ${#VOLS[@]}"; list "${VOLS[@]}"
  item "${#NETS[@]}" "networks: ${#NETS[@]}"; list "${NETS[@]}"
  item "${#IMGS[@]}" "images Dockify built: ${#IMGS[@]}"
  item "${#OWN[@]}" "Dockify's own images: ${#OWN[@]}$(own_size). One another container uses stays"; list "${OWN[@]}"
fi
item "$(exists "$DIR")" "$DIR"
[ "$NOTHING" = 0 ] || note "nothing: Dockify is not installed here"

if [ "$PURGE" = 0 ] && [ "$DOCKER" = 1 ] && [ $(( ${#VOLS[@]} + ${#NETS[@]} )) -gt 0 ]; then
  say "Will keep (--keep-data)"
  note "volumes: ${#VOLS[@]}"; list "${VOLS[@]}"
  note "app networks: ${#NETS[@]}"; list "${NETS[@]}"
  note "delete them later with --purge, or by hand with docker volume rm and docker network rm"
fi
if [ "$BACKUP" = 1 ] && [ -d "$DIR/secrets" ]; then
  say "Backup"
  note "the master key, secrets/, .env and release.env are copied to $BACKUP_PARENT/dockify-backup-<time>/ (mode 0700) first"
fi
say "Never touched"
note "Docker, ufw and its rules, unattended-upgrades (20auto-upgrades) and Docker's apt repository"
left_behind
if [ "$DOCKER" = 0 ]; then warn "docker is not installed, so no containers, volumes or networks are checked"; fi
if [ "$DOCKER" = 2 ]; then warn "the Docker daemon is not running, so containers, volumes and networks cannot be checked or removed; start it (systemctl start docker) and run this again"; fi

if [ "$DRY" = 1 ]; then
  say "Dry run: nothing was changed"
  FINISHED=1; return 0
fi
if [ "$NOTHING" = 1 ] && [ -z "$PENDING_BACKUP" ]; then
  say "Nothing to do"
  FINISHED=1; return 0
fi

# ------------------------------------------------------------------ confirm

WORD="${DOMAIN:-uninstall}"
ask "Type $WORD to uninstall Dockify from this server: " "$WORD"
if [ "$PURGE" = 1 ]; then
  ask "--purge deletes ${#VOLS[@]} volume(s) with all their data. This cannot be undone. Type purge to confirm: " purge
  if [ "$BACKUP" = 1 ] && [ "$YES" = 0 ] && [ -d "$DIR/secrets" ]; then
    printf 'Keep a backup of the master key and secrets in %s? [Y/n] ' "$BACKUP_PARENT" >&4
    IFS= read -r a <&3 || a=""
    case "$a" in n|N|no|NO) BACKUP=0 ;; esac
  fi
fi
STARTED=1

# ------------------------------------------------------------------ 1. backup

if [ "$BACKUP" = 1 ] && [ -d "$DIR/secrets" ]; then
  say "Backing up the master key and secrets"
  BACKUP_DIR="$BACKUP_PARENT/dockify-backup-$(date -u +%Y%m%dT%H%M%SZ)"
  [ ! -e "$BACKUP_DIR" ] || BACKUP_DIR="$BACKUP_DIR-$$"
  mkdir -p "$BACKUP_PARENT"
  mkdir -m 0700 "$BACKUP_DIR"
  cp -pR "$DIR/secrets" "$BACKUP_DIR/secrets"
  for f in .env docker-compose.yml release/release.env; do
    [ ! -f "$DIR/$f" ] || cp -p "$DIR/$f" "$BACKUP_DIR/$(basename "$f")"
  done
  chown -R 0:0 "$BACKUP_DIR" 2>/dev/null || true
  chmod -R go-rwx "$BACKUP_DIR"
  chmod 0700 "$BACKUP_DIR"
  [ -s "$BACKUP_DIR/secrets/master_key" ] || [ ! -s "$DIR/secrets/master_key" ] || die "the master key did not copy to $BACKUP_DIR; nothing else was changed"
  [ -z "$CF_TUNNEL" ] || : > "$BACKUP_DIR/cloudflare-pending"
  note "saved to $BACKUP_DIR"
elif [ -n "$PENDING_BACKUP" ]; then
  BACKUP_DIR="$PENDING_BACKUP"
fi

# ------------------------------------------------------------------ 2. containers

if [ "$DOCKER" = 1 ]; then
  say "Stopping the Dockify stack"
  if [ "${#STACK[@]}" -gt 0 ]; then
    stop_stack
  else note "already stopped"; fi
  say "Removing app containers"
  mapfile -t APPS < <(containers)
  if [ "${#APPS[@]}" -gt 0 ]; then
    # --purge says every volume, an image's anonymous ones included.
    if [ "$PURGE" = 1 ]; then try "app containers: ${APPS[*]}" docker rm -fv "${APPS[@]}"; else try "app containers: ${APPS[*]}" docker rm -f "${APPS[@]}"; fi
    note "removed ${#APPS[@]}"
  else note "none left"; fi
elif [ "$DOCKER" = 2 ]; then
  LEFT+=("the Dockify containers, volumes and networks (the Docker daemon is not running)")
fi

# ------------------------------------------------------------------ 3. firewall

say "Removing the container firewall"
if [ -e "$W_UNIT" ] || [ -e "$W_FWBIN" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now dockify-firewall.service >/dev/null 2>&1 || true
  fi
  try "$W_UNIT" rm -f "$W_UNIT"
  try "$W_FWBIN" rm -f "$W_FWBIN"
  if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload >/dev/null 2>&1 || true; fi
  note "service and script removed"
else note "already gone"; fi
drop_rules

# ------------------------------------------------------------------ 4. wrapper and apt rule

say "Removing the dockify command, the apt rule and the AppArmor profile"
removed=0
# The BuildKit container that used the profile is gone with the stack, so it can be unloaded.
if [ -e "$W_AA" ] && [ -z "$ROOT" ] && command -v apparmor_parser >/dev/null 2>&1; then
  apparmor_parser -R "$W_AA" >/dev/null 2>&1 || true
fi
for f in "$W_WRAPPER" "$W_APT" "$W_AA"; do
  if [ -e "$f" ] || [ -L "$f" ]; then try "$f" rm -f "$f"; removed=1; fi
done
if [ "$removed" = 1 ]; then note "removed"; else note "already gone"; fi

# ------------------------------------------------------------------ 5. Cloudflare

if [ -n "$CF_TUNNEL" ]; then
  say "Cloudflare tunnel"
  if cf_cleanup; then
    [ -z "$BACKUP_DIR" ] || rm -f "$BACKUP_DIR/cloudflare-pending"
  else
    cf_manual
    LEFT+=("Cloudflare tunnel $CF_TUNNEL and its CNAME records (steps above)")
  fi
fi
if [ "$INGRESS" = direct_tls ]; then
  note "direct mode: ufw still allows 80 and 443. Close them with: ufw delete allow 80/tcp && ufw delete allow 443/tcp"
  [ -z "$DOMAIN" ] || note "delete the A or AAAA record for $DOMAIN at your DNS host if you no longer use it"
fi

# ------------------------------------------------------------------ 6. data

if [ "$DOCKER" = 1 ]; then
  inventory
  if [ "$PURGE" = 1 ]; then
    say "Deleting volumes, networks and images (--purge)"
    for v in "${VOLS[@]}"; do try "volume $v" docker volume rm -f "$v"; done
    for n in "${NETS[@]}"; do try "network $n" docker network rm "$n"; done
    for i in "${IMGS[@]}"; do try "image $i" docker image rm -f "$i"; done
    note "deleted ${#VOLS[@]} volume(s), ${#NETS[@]} network(s), ${#IMGS[@]} image(s)"
    # Never forced, so an image another container uses stays: these are public images anyone may run.
    gone=0
    for i in "${OWN[@]}"; do
      if docker image rm "$i" >/dev/null 2>"$TMP/err"; then gone=$((gone + 1)); else STILL+=("$i: $(tail -n1 "$TMP/err")"); fi
    done
    note "deleted $gone of Dockify's own image(s)"
  else
    # The stack's own networks hold no data; compose down usually removed them already.
    mapfile -t own < <(docker network ls --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Name}}' 2>/dev/null | sort -u)
    for n in "${own[@]}"; do [ -z "$n" ] || docker network rm "$n" >/dev/null 2>&1 || true; done
  fi
fi

# ------------------------------------------------------------------ 7. install folder

say "Removing $DIR"
if [ -d "$DIR" ]; then
  try "$DIR" rm -rf "$DIR"
  [ -e "$DIR" ] || note "removed"
else note "already gone"; fi

# ------------------------------------------------------------------ done

FINISHED=1
if [ "${#LEFT[@]}" -gt 0 ]; then
  say "Done, with leftovers"
  for l in "${LEFT[@]}"; do note "not removed: $l"; done
  note "fix the cause and run this again; it skips what is already gone"
else
  say "Dockify is uninstalled"
fi
if [ "$PURGE" = 0 ] && [ "$DOCKER" = 1 ] && [ $(( ${#VOLS[@]} + ${#NETS[@]} )) != 0 ]; then
  note "kept ${#VOLS[@]} volume(s) and ${#NETS[@]} network(s). Delete them later with: curl -fsSL https://dockify.sh/uninstall.sh | sh -s -- --purge"
  note "installing again on this server picks this data up, with the secrets from the backup below; keep that backup until then"
fi
if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
  note "backup of the master key and secrets: $BACKUP_DIR (root only). Keep it safe or delete it."
fi
say "Still on this server"
note "Docker, ufw and its rules, unattended-upgrades and Docker's apt repository: yours, and maybe in use"
if [ "$DOCKER" = 1 ] && [ "$PURGE" = 0 ] && [ "${#OWN[@]}" -gt 0 ]; then
  note "Dockify's own images: ${#OWN[@]}$(own_size), so installing again need not download them. --purge removes them"
fi
for s in "${STILL[@]}"; do note "not removed, another container may use it: $s"; done
left_behind
if [ "$REBOOT" = 1 ]; then
  note "rebooting now (--reboot)"
  systemctl reboot
else
  note "reboot to clear any firewall rule still loaded in the kernel: reboot (or run with --reboot)"
fi
}

# ------------------------------------------------------------------ helpers

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\n\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# The last value of KEY in the env file, or empty.
env_get() { [ -f "$ENV_FILE" ] || return 0; grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '\r"'"'" || true; }

# $1 count (0 means already gone), $2 text. Clears NOTHING when something is left to remove.
item() { if [ "$1" -gt 0 ] 2>/dev/null; then note "$2"; NOTHING=0; fi; }
list() { local x n=0; for x in "$@"; do [ -n "$x" ] || continue; n=$((n + 1)); [ "$n" -le 12 ] && note "    $x"; done; [ "$n" -le 12 ] || note "    and $((n - 12)) more"; }
exists() { local f; for f in "$@"; do if [ -e "$f" ] || [ -L "$f" ]; then echo 1; return; fi; done; echo 0; }

# Runs a removal; a failure is recorded as a leftover instead of stopping half way.
try() {
  local what="$1"; shift
  if ! "$@" >/dev/null 2>"$TMP/err"; then
    warn "could not remove $what: $(tail -n1 "$TMP/err")"
    LEFT+=("$what")
  fi
}

# $1 prompt, $2 the exact answer. Reads the terminal, so `curl | sh` can still confirm.
ask() {
  [ "$YES" = 0 ] || return 0
  [ "$HAVE_TTY" = 1 ] || die "no terminal to confirm on; pass --yes to run unattended. Nothing was changed."
  printf '\n%s' "$1" >&4
  local a=""
  IFS= read -r a <&3 || true
  a="$(printf '%s' "$a" | tr -d '[:space:]')"
  [ "$a" = "$2" ] || die "not confirmed. Nothing was changed."
}

names() { "$@" 2>/dev/null | sed '/^$/d' || true; }
containers() {
  { names docker ps -a --filter "label=dockify.managed=true" --format '{{.Names}}'
    names docker ps -a --filter "label=dockify.app" --format '{{.Names}}'; } | sort -u
}
inventory() {
  [ "$DOCKER" = 1 ] || return 0
  mapfile -t STACK < <(names docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}}' | sort -u)
  mapfile -t APPS < <(containers)
  mapfile -t VOLS < <({ names docker volume ls --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Name}}'
    names docker volume ls --filter "label=dockify.managed=true" --format '{{.Name}}'
    names docker volume ls --filter "label=dockify.app" --format '{{.Name}}'
    names docker volume ls --filter "name=dockify-data-" --format '{{.Name}}' | grep -E '^dockify-data-' || true; } | sort -u)
  mapfile -t NETS < <({ names docker network ls --filter "label=dockify.managed=true" --format '{{.Name}}'
    names docker network ls --filter "label=dockify.environment" --format '{{.Name}}'
    names docker network ls --filter "label=dockify.role=helpers" --format '{{.Name}}'
    names docker network ls --filter "name=dockify-" --format '{{.Name}}' | grep -E '^dockify-(env-.+|pv-.+|deploy|helpers)$' || true
    [ "$PURGE" = 0 ] || names docker network ls --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Name}}'; } | sort -u)
  mapfile -t IMGS < <(names docker image ls -q --filter "label=dockify.managed=true" | sort -u)
  mapfile -t OWN < <(own_images)
}

# The images the stack runs, as a digest reference with no tag (what `docker image rm` takes on either of
# Docker's image stores), and only those on this server. They come from the compose file and release.env,
# of this install and of any backup, so a --purge after a --keep-data still finds them.
own_images() {
  local f r repo
  for f in "$DIR/docker-compose.yml" "$DIR/release/release.env" "$BACKUP_PARENT"/dockify-backup-*/docker-compose.yml "$BACKUP_PARENT"/dockify-backup-*/release.env; do
    [ -f "$f" ] || continue
    sed -nE -e 's/^[[:space:]]*image:[[:space:]]*(&[a-z0-9_-]+[[:space:]]+)?//p' -e 's/^DOCKIFY_(CONTROL|WEB)_IMAGE=//p' "$f"
    # The versions an update left behind: every image of the control and web repositories is Dockify's.
    sed -nE 's/^DOCKIFY_(CONTROL|WEB)_IMAGE=([^@]+)@.*/\2/p' "$f" | while IFS= read -r repo; do
      names docker image ls --digests --format '{{.Repository}}@{{.Digest}}' "$repo"
    done
  done | tr -d '\r"' | sed -E 's/[[:space:]]+$//; s/^([^@]*):[^:/@]+@/\1@/' | grep -E '^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$' | sort -u | while IFS= read -r r; do
    docker image inspect "$r" >/dev/null 2>&1 && printf '%s\n' "$r"
  done
  return 0
}

# ", about N MB" for those images; shared layers count twice, so it reads as an upper bound. Empty when unknown.
own_size() {
  [ "${#OWN[@]}" -gt 0 ] || return 0
  docker image inspect --format '{{.Size}}' "${OWN[@]}" 2>/dev/null | awk '{ t += $1 } END { if (t > 0) printf ", about %.1f GB", t / 1000000000 }'
}

# What stays and why, in the plan and again at the end. Nothing here is Dockify's to change.
left_behind() {
  if [ -f "$DAEMON_JSON" ] && grep -q 'default-address-pools' "$DAEMON_JSON"; then
    note "$DAEMON_JSON: default-address-pools stays, added by the installer unless you set it yourself."
    note "  The file may hold your other settings and a change takes a Docker restart, so it is not edited."
    note "  It only decides where new Docker networks get addresses. To undo it: delete that key, then"
    note "  sudo systemctl restart docker (every container on this server stops for a few seconds)."
    [ ! -f "$DAEMON_JSON.before-dockify" ] || note "  The file as it was before Dockify: $DAEMON_JSON.before-dockify"
  fi
  note "images your apps pulled, such as nginx or a managed Postgres: Dockify cannot tell them from yours."
  note "  To remove every image no container uses: docker image prune -a"
}

# compose down when the files are there, then whatever is left of the project by its label.
stop_stack() {
  if [ -f "$DIR/docker-compose.yml" ] && [ -f "$DIR/.env" ]; then
    local args=(compose --project-directory "$DIR" -f "$DIR/docker-compose.yml" --env-file "$DIR/.env")
    [ ! -f "$DIR/release/release.env" ] || args+=(--env-file "$DIR/release/release.env")
    docker "${args[@]}" down --remove-orphans --timeout 30 >/dev/null 2>&1 || true
  fi
  local rest
  mapfile -t rest < <(names docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}}' | sort -u)
  [ "${#rest[@]}" = 0 ] || try "stack containers: ${rest[*]}" docker rm -f "${rest[@]}"
  note "stopped and removed"
}

# The rules dockify-firewall inserted, deleted from the running kernel. Best effort.
drop_rules() {
  local t
  for t in iptables ip6tables; do
    command -v "$t" >/dev/null 2>&1 || continue
    if [ "$t" = iptables ]; then
      del "$t" DOCKER-USER -d 169.254.0.0/16 -j DROP
      del "$t" DOCKER-USER -d 100.100.100.200/32 -j DROP
      del "$t" DOCKER-USER -d 168.63.129.16/32 -p tcp ! --dport 53 -j DROP
    else
      del "$t" DOCKER-USER -d fd00:ec2::254/128 -j DROP
      del "$t" DOCKER-USER -d fe80::/10 -j DROP
    fi
    del "$t" INPUT -i dk-+ -j DROP
    del "$t" INPUT -i dk-+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    del "$t" INPUT -i dk-deploy -p tcp --dport 80 -j ACCEPT
    del "$t" INPUT -i dk-deploy -p tcp --dport 443 -j ACCEPT
  done
}
del() { local t="$1" c="$2" i=0; shift 2; while [ "$i" -lt 20 ] && "$t" -C "$c" "$@" >/dev/null 2>&1; do "$t" -D "$c" "$@" >/dev/null 2>&1 || break; i=$((i + 1)); done; }

cf_token_source() {
  if [ -n "$CF_TOKEN_FILE" ]; then echo "$CF_TOKEN_FILE"
  elif [ -n "${DOCKIFY_CF_API_TOKEN:-}" ]; then echo "DOCKIFY_CF_API_TOKEN"
  elif [ -s "$DIR/secrets/cf_api_token" ]; then echo "$DIR/secrets/cf_api_token"
  elif [ -n "$PENDING_BACKUP" ] && [ -s "$PENDING_BACKUP/secrets/cf_api_token" ]; then echo "$PENDING_BACKUP/secrets/cf_api_token"
  fi
}

# Writes the token into a header file, so it never reaches argv. Returns 1 when there is none.
cf_header() {
  local tok="" src
  src="$(cf_token_source)"
  if [ "$src" = DOCKIFY_CF_API_TOKEN ]; then tok="$DOCKIFY_CF_API_TOKEN"
  elif [ -n "$src" ]; then [ -r "$src" ] || { warn "cannot read $src"; return 1; }; tok="$(tr -d '\r\n' < "$src")"
  elif [ "$HAVE_TTY" = 1 ]; then
    printf 'Cloudflare API token to delete the tunnel (Enter to skip and do it by hand): ' >&4
    stty -echo <&3 2>/dev/null || true
    IFS= read -r tok <&3 || tok=""
    stty echo <&3 2>/dev/null || true
    printf '\n' >&4
  fi
  [ -n "$tok" ] || return 1
  printf 'Authorization: Bearer %s\n' "$tok" > "$TMP/cf.hdr"
}
# $1 method, $2 path. Prints the body; the HTTP status lands in $TMP/cf.code.
cf() {
  # curl leaves the file alone when it never connects: the last answer must not read as this one's.
  rm -f "$TMP/cf.body"
  curl -sS --proto '=https' --max-time 30 -X "$1" -H @"$TMP/cf.hdr" -o "$TMP/cf.body" -w '%{http_code}' "$CF_API$2" > "$TMP/cf.code" 2>/dev/null || echo 000 > "$TMP/cf.code"
  cat "$TMP/cf.body" 2>/dev/null || true
}
cf_ok() { printf '%s' "$1" | jq -e '.success == true' >/dev/null 2>&1; }
# jq -r without the carriage returns a Windows jq adds (the test suite runs there too).
jqr() { jq -r "$@" | tr -d '\r'; }
cf_errs() { printf '%s' "$1" | jq -r '[.errors[]?.message] | join("; ")' 2>/dev/null || true; }

# Deletes the tunnel this install created and every CNAME that points at it. Returns 1 on anything
# it could not finish; cf_manual then prints the rest.
cf_cleanup() {
  if ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then warn "curl and jq are needed to call Cloudflare"; return 1; fi
  [ -n "$CF_ACCOUNT" ] || { warn "the Cloudflare account id is not in .env"; return 1; }
  cf_header || { note "no Cloudflare token"; return 1; }
  local R code name target zones z ids id failed=0 page=1 pages=1
  R="$(cf GET /user/tokens/verify)"; cf_ok "$R" || { warn "Cloudflare rejected the token: $(cf_errs "$R")"; return 1; }

  R="$(cf GET "/accounts/$CF_ACCOUNT/cfd_tunnel/$CF_TUNNEL")"; code="$(cat "$TMP/cf.code")"
  if [ "$code" = 404 ] || { cf_ok "$R" && [ "$(printf '%s' "$R" | jqr '.result.deleted_at // empty')" != "" ]; }; then
    note "tunnel already deleted"
  elif cf_ok "$R"; then
    name="$(printf '%s' "$R" | jqr '.result.name // empty')"
    case "$name" in
      dockify-*)
        cf DELETE "/accounts/$CF_ACCOUNT/cfd_tunnel/$CF_TUNNEL/connections" >/dev/null
        R="$(cf DELETE "/accounts/$CF_ACCOUNT/cfd_tunnel/$CF_TUNNEL")"
        if cf_ok "$R"; then note "deleted tunnel $name ($CF_TUNNEL)"; else warn "cannot delete the tunnel: $(cf_errs "$R")"; failed=1; fi ;;
      *) warn "tunnel $CF_TUNNEL is named '$name', not dockify-*; leaving it alone"; failed=1 ;;
    esac
  else
    warn "cannot read the tunnel: $(cf_errs "$R")"; failed=1
  fi

  # Every CNAME pointing at the tunnel is dead once it is gone: the dashboard record and any app
  # domain Dockify routed through it. Only exact matches on the unique tunnel target are deleted.
  target="$CF_TUNNEL.cfargotunnel.com" zones=""
  while [ "$page" -le "$pages" ] && [ "$page" -le 20 ]; do
    R="$(cf GET "/zones?per_page=50&page=$page")"
    cf_ok "$R" || { warn "cannot list zones: $(cf_errs "$R")"; return 1; }
    zones="$zones $(printf '%s' "$R" | jqr '.result[].id' | tr '\n' ' ')"
    pages="$(printf '%s' "$R" | jqr '.result_info.total_pages // 1')"
    page=$((page + 1))
  done
  local n=0
  for z in $zones; do
    R="$(cf GET "/zones/$z/dns_records?type=CNAME&content=$target&per_page=100")"
    cf_ok "$R" || { warn "cannot read DNS in zone $z: $(cf_errs "$R")"; failed=1; continue; }
    # shellcheck disable=SC2016 # $t is a jq variable
    ids="$(printf '%s' "$R" | jqr --arg t "$target" '.result[] | select(.type == "CNAME" and .content == $t) | .id')"
    for id in $ids; do
      R="$(cf DELETE "/zones/$z/dns_records/$id")"
      if cf_ok "$R"; then n=$((n + 1)); else warn "cannot delete DNS record $id: $(cf_errs "$R")"; failed=1; fi
    done
  done
  note "deleted $n DNS record(s) pointing at the tunnel"
  return "$failed"
}

cf_manual() {
  note "Delete these by hand in the Cloudflare dashboard:"
  note "  Zero Trust, Networks, Tunnels: the tunnel with id $CF_TUNNEL (named dockify-<host>-<id>)"
  note "  DNS: the CNAME ${DOMAIN:-for the dashboard} pointing at $CF_TUNNEL.cfargotunnel.com, and any other record with that target${CF_RECORD:+ (dashboard record id $CF_RECORD)}"
  note "  Or run this again with --cf-token-file PATH (Account:Cloudflare Tunnel:Edit, Zone:DNS:Edit)"
}

# shellcheck disable=SC2329 # the EXIT trap
on_exit() {
  local s=$?
  [ "${HAVE_TTY:-0}" = 0 ] || stty echo <&3 2>/dev/null || true
  if [ "$STARTED" = 1 ] && [ "$FINISHED" = 0 ]; then
    printf '\n\033[31mStopped before finishing.\033[0m Still on this server, as far as it got:\n' >&2
    [ -e "$DIR" ] && printf '  %s\n' "$DIR" >&2
    for f in "$W_WRAPPER" "$W_UNIT" "$W_FWBIN" "$W_APT" "$W_AA"; do [ ! -e "$f" ] || printf '  %s\n' "$f" >&2; done
    if [ "$DOCKER" = 1 ]; then
      printf '  %s container(s) labelled dockify.managed=true\n' "$(containers | wc -l | tr -d ' ')" >&2
    fi
    [ -z "$CF_TUNNEL" ] || printf '  maybe the Cloudflare tunnel %s\n' "$CF_TUNNEL" >&2
    for l in "${LEFT[@]}"; do printf '  %s\n' "$l" >&2; done
    [ -z "$BACKUP_DIR" ] || printf '  backup: %s\n' "$BACKUP_DIR" >&2
    printf '  Run the same command again; it skips what is already gone.\n' >&2
  fi
  rm -rf "${TMP:-/nonexistent-dockify-tmp}"
  exit "$s"
}

SELF="${BASH_SOURCE[0]:-$0}"
main "$@"
exit 0
