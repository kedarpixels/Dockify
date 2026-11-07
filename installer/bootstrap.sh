#!/bin/sh
# Dockify bootstrap, served at https://dockify.sh/install.sh:
#
#   curl -fsSL https://dockify.sh/install.sh | sh
#
# POSIX sh, so it runs under any shell the pipe lands in. It downloads the full installer to a
# private temp folder, checks it against the published SHA-256, then runs it as root with bash.
# Flags pass straight through:  curl -fsSL https://dockify.sh/install.sh | sh -s -- --dry-run
# The installer asks for anything it still needs (the dashboard domain, a Cloudflare token) on the
# terminal, so the one-liner needs no arguments.
set -eu

BASE="${DOCKIFY_INSTALL_BASE:-https://dockify.sh}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'dockify: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v bash >/dev/null 2>&1 || die "bash is required"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"

case "$BASE" in https://*) ;; *) die "DOCKIFY_INSTALL_BASE must be https" ;; esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

say "Downloading the Dockify installer"
curl -fsSL --proto '=https' --tlsv1.2 "$BASE/installer.sh" -o "$TMP/installer.sh"
curl -fsSL --proto '=https' --tlsv1.2 "$BASE/installer.sh.sha256" -o "$TMP/installer.sh.sha256"

# The checksum file holds the hash alone or "hash  name"; compare the hash only.
want="$(cut -d' ' -f1 "$TMP/installer.sh.sha256")"
got="$(sha256sum "$TMP/installer.sh" | cut -d' ' -f1)"
[ -n "$want" ] && [ "$want" = "$got" ] || die "installer checksum mismatch, refusing to run it"

# The uninstaller rides along: install.sh copies $TMP/uninstall.sh into the install folder, where
# `dockify uninstall` runs it. Optional (the wrapper can fetch it later), but never unverified.
if curl -fsSL --proto '=https' --tlsv1.2 "$BASE/uninstaller.sh" -o "$TMP/uninstall.sh" 2>/dev/null \
  && curl -fsSL --proto '=https' --tlsv1.2 "$BASE/uninstaller.sh.sha256" -o "$TMP/uninstall.sh.sha256" 2>/dev/null; then
  want="$(cut -d' ' -f1 "$TMP/uninstall.sh.sha256")"
  got="$(sha256sum "$TMP/uninstall.sh" | cut -d' ' -f1)"
  [ -n "$want" ] && [ "$want" = "$got" ] || die "uninstaller checksum mismatch, refusing to run the installer"
else
  rm -f "$TMP/uninstall.sh" "$TMP/uninstall.sh.sha256"
fi

if [ "$(id -u)" = 0 ]; then
  exec bash "$TMP/installer.sh" "$@"
fi
command -v sudo >/dev/null 2>&1 || die "run as root, or install sudo"
say "Dockify needs root. sudo may ask for your password."
exec sudo bash "$TMP/installer.sh" "$@"
