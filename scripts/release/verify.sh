#!/bin/sh
# Verifies a published release channel file and its minisign signature, then lists its versions.
#
#   verify.sh <stable.json | beta.json | https URL of one> [public key]
#
# The signature is read from <file>.minisig (for a URL, <URL>.minisig is downloaded beside it).
# The public key is a base64 key line or a path to a .pub file; default MINISIGN_PUBLIC_KEY, else
# deploy/release.pub next to this script. Checks, in order: the signature over the exact bytes,
# then the schema number, and that the signed trusted comment names this file's channel and newest
# version (the same rules the control plane applies before it trusts a feed).
set -eu

die() { printf 'verify.sh: %s\n' "$*" >&2; exit 1; }

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || die "usage: verify.sh <channel.json | https URL> [public key line | .pub file]"
command -v minisign >/dev/null 2>&1 || die "minisign is not installed"

HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO_ROOT=$(cd "$HERE/../.." && pwd -P)
TMP=""
cleanup() { if [ -n "$TMP" ]; then rm -rf "$TMP"; fi; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

SRC=$1
case "$SRC" in
  https://*)
    command -v curl >/dev/null 2>&1 || die "curl is needed to fetch $SRC"
    TMP=$(mktemp -d "${TMPDIR:-/tmp}/dockify-verify.XXXXXX")
    curl -fsS --proto '=https' --max-filesize 524288 -o "$TMP/feed.json" "$SRC" || die "cannot fetch $SRC"
    curl -fsS --proto '=https' --max-filesize 4096 -o "$TMP/feed.json.minisig" "$SRC.minisig" || die "cannot fetch $SRC.minisig"
    FILE="$TMP/feed.json"
    ;;
  http://*) die "the feed must be https" ;;
  *) FILE=$SRC ;;
esac
[ -f "$FILE" ] || die "no such file: $FILE"
[ -f "$FILE.minisig" ] || die "no signature beside it: $FILE.minisig"

PUB=${2:-${MINISIGN_PUBLIC_KEY:-$REPO_ROOT/deploy/release.pub}}
if [ -f "$PUB" ]; then
  PUB=$(grep -v '^untrusted comment:' "$PUB" | tr -d '\r' | grep -v '^[[:space:]]*$' | tail -n 1)
fi
PUB=$(printf '%s' "$PUB" | tr -d ' \r\n')
[ -n "$PUB" ] || die "no public key given"

OUT=$(minisign -V -m "$FILE" -x "$FILE.minisig" -P "$PUB" 2>&1) || die "the signature does NOT verify against this key: $OUT"
COMMENT=$(printf '%s\n' "$OUT" | sed -n 's/^Trusted comment: //p' | head -n 1)

# Only signed bytes reach the parser.
if command -v jq >/dev/null 2>&1; then
  SCHEMA=$(jq -r '.schema' "$FILE")
  CHANNEL=$(jq -r '.channel' "$FILE")
  NEWEST=$(jq -r '.releases[0].version' "$FILE")
  GENERATED=$(jq -r '.generatedAt' "$FILE")
  LIST=$(jq -r '.releases[] | "  \(.version)  \(.date)  minFrom \(.minFrom)\(if .critical then "  critical" else "" end)\(if .security then "  security \(.security.level)" else "" end)"' "$FILE")
else
  INFO=$(node -e '
    const f = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const r = Array.isArray(f.releases) ? f.releases : [];
    console.log(String(f.schema));
    console.log(String(f.channel));
    console.log(String(r[0] && r[0].version));
    console.log(String(f.generatedAt));
    for (const x of r) console.log(`  ${x.version}  ${x.date}  minFrom ${x.minFrom}${x.critical ? "  critical" : ""}${x.security ? `  security ${x.security.level}` : ""}`);
  ' "$FILE") || die "the signed file is not JSON"
  SCHEMA=$(printf '%s\n' "$INFO" | sed -n 1p)
  CHANNEL=$(printf '%s\n' "$INFO" | sed -n 2p)
  NEWEST=$(printf '%s\n' "$INFO" | sed -n 3p)
  GENERATED=$(printf '%s\n' "$INFO" | sed -n 4p)
  LIST=$(printf '%s\n' "$INFO" | sed -n '5,$p')
fi

[ "$SCHEMA" = 2 ] || die "schema is $SCHEMA, expected 2"
case "$CHANNEL" in stable|beta) ;; *) die "unknown channel: $CHANNEL" ;; esac
has() { printf ' %s ' "$COMMENT" | grep -Fq " $1 "; }
has "channel:$CHANNEL" || die "the trusted comment ($COMMENT) does not name channel $CHANNEL"
has "version:$NEWEST" || die "the trusted comment ($COMMENT) does not name the newest version $NEWEST"

printf 'verified %s channel, newest %s, generated %s\n' "$CHANNEL" "$NEWEST" "$GENERATED"
printf 'trusted comment: %s\n' "$COMMENT"
printf 'releases:\n%s\n' "$LIST"
