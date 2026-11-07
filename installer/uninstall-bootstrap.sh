#!/bin/sh
# Dockify uninstall bootstrap, served at https://dockify.sh/uninstall.sh:
#
#   curl -fsSL https://dockify.sh/uninstall.sh | sh
#
# POSIX sh, like the install bootstrap. It downloads the full uninstaller to a private temp folder,
# checks it against the published SHA-256, then runs it as root with bash. Flags pass straight
# through:  curl -fsSL https://dockify.sh/uninstall.sh | sh -s -- --dry-run
# The uninstaller shows its plan and asks for confirmation on the terminal before it changes anything.
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

say "Downloading the Dockify uninstaller"
curl -fsSL --proto '=https' --tlsv1.2 "$BASE/uninstaller.sh" -o "$TMP/uninstaller.sh"
curl -fsSL --proto '=https' --tlsv1.2 "$BASE/uninstaller.sh.sha256" -o "$TMP/uninstaller.sh.sha256"

want="$(cut -d' ' -f1 "$TMP/uninstaller.sh.sha256")"
got="$(sha256sum "$TMP/uninstaller.sh" | cut -d' ' -f1)"
[ -n "$want" ] && [ "$want" = "$got" ] || die "uninstaller checksum mismatch, refusing to run it"

if [ "$(id -u)" = 0 ]; then
  exec bash "$TMP/uninstaller.sh" "$@"
fi
command -v sudo >/dev/null 2>&1 || die "run as root, or install sudo"
say "Dockify needs root. sudo may ask for your password."
exec sudo bash "$TMP/uninstaller.sh" "$@"
