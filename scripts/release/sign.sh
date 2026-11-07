#!/bin/sh
# Signs one release channel file with minisign, then verifies the signature before exiting 0.
#
#   sign.sh <manifest.json>            writes <manifest.json>.minisig
#
# The secret key comes ONLY from the environment, never from the repository:
#   MINISIGN_SECRET_KEY_FILE   path to the minisign secret key file, or
#   MINISIGN_SECRET_KEY        the key file's contents (written to a 0600 temp file, removed on exit)
#   MINISIGN_PASSWORD          the key's password, fed on stdin (unset: minisign asks, or the key has none)
# The public key that must verify the result:
#   MINISIGN_PUBLIC_KEY        a base64 key line or a path to a .pub file (default: deploy/release.pub)
#
# The trusted comment is "channel:<channel> version:<newest version> generated:<generatedAt>",
# read from the file itself, so a signature can never be paired with another channel or version.
# docs/RELEASING.md describes the key ceremony and the release.
set -eu

die() { printf 'sign.sh: %s\n' "$*" >&2; exit 1; }

[ "$#" -eq 1 ] || die "usage: sign.sh <manifest.json>"
MANIFEST=$1
[ -f "$MANIFEST" ] || die "no such file: $MANIFEST"
command -v minisign >/dev/null 2>&1 || die "minisign is not installed"

HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO_ROOT=$(cd "$HERE/../.." && pwd -P)

TMPKEY=""
cleanup() { if [ -n "$TMPKEY" ]; then rm -f "$TMPKEY"; fi; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# ------------------------------------------------------------------ read the manifest

field() {
  if command -v jq >/dev/null 2>&1; then
    jq -er "$1" "$MANIFEST"
  else
    node -e '
      const f = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const v = process.argv[2] === "version" ? (f.releases && f.releases[0] && f.releases[0].version) : f[process.argv[2]];
      if (typeof v !== "string" || v === "") process.exit(1);
      process.stdout.write(v);
    ' "$MANIFEST" "$2"
  fi
}
CHANNEL=$(field '.channel' channel) || die "$MANIFEST has no channel"
VERSION=$(field '.releases[0].version' version) || die "$MANIFEST has no releases[0].version"
GENERATED=$(field '.generatedAt' generatedAt) || die "$MANIFEST has no generatedAt"

case "$CHANNEL" in stable|beta) ;; *) die "unknown channel: $CHANNEL" ;; esac
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9_.]+)?$' || die "bad version: $VERSION"
printf '%s' "$GENERATED" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9]{2}:[0-9]{2})$' || die "bad generatedAt: $GENERATED"
COMMENT="channel:$CHANNEL version:$VERSION generated:$GENERATED"

# ------------------------------------------------------------------ the secret key

abspath() { (cd "$(dirname "$1")" && printf '%s/%s\n' "$(pwd -P)" "$(basename "$1")"); }

if [ -n "${MINISIGN_SECRET_KEY_FILE:-}" ]; then
  KEY=$MINISIGN_SECRET_KEY_FILE
  [ -f "$KEY" ] || die "MINISIGN_SECRET_KEY_FILE does not name a file"
elif [ -n "${MINISIGN_SECRET_KEY:-}" ]; then
  OLD_UMASK=$(umask)
  umask 077
  TMPKEY=$(mktemp "${TMPDIR:-/tmp}/dockify-sign.XXXXXX")
  umask "$OLD_UMASK"
  chmod 600 "$TMPKEY"
  printf '%s\n' "$MINISIGN_SECRET_KEY" > "$TMPKEY"
  KEY=$TMPKEY
else
  die "set MINISIGN_SECRET_KEY_FILE (a path) or MINISIGN_SECRET_KEY (the key file contents)"
fi

# A key inside any git work tree, and above all this one, is one `git add` away from being public.
KEY_ABS=$(abspath "$KEY") || die "cannot resolve the key path"
case "$KEY_ABS" in "$REPO_ROOT"/*) die "refusing a secret key inside the repository ($KEY_ABS)" ;; esac
if command -v git >/dev/null 2>&1; then
  if TOP=$(git -C "$(dirname "$KEY_ABS")" rev-parse --show-toplevel 2>/dev/null); then
    die "refusing a secret key inside a git work tree ($TOP)"
  fi
fi

# ------------------------------------------------------------------ the public key

PUB=${MINISIGN_PUBLIC_KEY:-$REPO_ROOT/deploy/release.pub}
if [ -f "$PUB" ]; then
  PUB=$(grep -v '^untrusted comment:' "$PUB" | tr -d '\r' | grep -v '^[[:space:]]*$' | tail -n 1)
fi
PUB=$(printf '%s' "$PUB" | tr -d ' \r\n')
[ -n "$PUB" ] || die "no public key: set MINISIGN_PUBLIC_KEY or fill deploy/release.pub"

# ------------------------------------------------------------------ sign, then verify

SIG="$MANIFEST.minisig"
rm -f "$SIG"
if [ -n "${MINISIGN_PASSWORD:-}" ]; then
  printf '%s\n' "$MINISIGN_PASSWORD" | minisign -S -s "$KEY" -m "$MANIFEST" -x "$SIG" -t "$COMMENT" >/dev/null
else
  minisign -S -s "$KEY" -m "$MANIFEST" -x "$SIG" -t "$COMMENT"
fi
[ -s "$SIG" ] || die "minisign wrote no signature"

OUT=$(minisign -V -m "$MANIFEST" -x "$SIG" -P "$PUB" 2>&1) || {
  rm -f "$SIG"
  die "the new signature does not verify against the public key; is the secret key the one deploy/release.pub names?"
}
printf '%s\n' "$OUT" | grep -Fqx "Trusted comment: $COMMENT" || { rm -f "$SIG"; die "the signed trusted comment is not \"$COMMENT\""; }

printf 'signed %s (%s)\n' "$SIG" "$COMMENT"
