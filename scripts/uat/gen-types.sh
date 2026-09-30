#!/usr/bin/env bash
# Regenerate src/types/supabase.ts from the live UAT schema.
#
#   scripts/uat/gen-types.sh          write the file
#   scripts/uat/gen-types.sh --check  fail if the committed file is stale
#
# UAT is the source of truth for the shape, because it is the database that has
# every migration applied. Production is behind; generating from it would bake
# in the old schema.
set -euo pipefail
cd "$(dirname "$0")/../.."

UAT_REF=jgijsurgbciuopicqceo
PROD_REF=gwncamipwckpknxpiksv
PW=$(cat "$HOME/.store-ops-uat-db-password")
ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$PW")
URL="postgresql://postgres.${UAT_REF}:${ENC}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres"

case "$URL" in
  *"$PROD_REF"*) echo "REFUSING: connection string references the production project"; exit 2;;
esac

OUT=src/types/supabase.ts
TMP=$(mktemp)
{
  echo "// GENERATED FILE — DO NOT EDIT."
  echo "//"
  echo "// Produced by scripts/uat/gen-types.sh from the live UAT schema."
  echo "// Regenerate after every migration:  npm run types:generate"
  echo "//"
  echo "// Hand-written interfaces drift. src/types/retail.ts described shop_traffic"
  echo "// as thai_count/foreigner_count for eight migrations after 010 reshaped it"
  echo "// into one row per nationality, and the compiler cheerfully agreed — which"
  echo "// is how two screens stayed broken without anyone noticing."
  echo ""
  supabase gen types typescript --db-url "$URL" 2>/dev/null
} > "$TMP"

if [ "${1:-}" = "--check" ]; then
  if ! diff -q "$TMP" "$OUT" >/dev/null 2>&1; then
    echo "FAIL: $OUT is stale — the schema has moved since it was generated."
    echo "      Run: npm run types:generate"
    echo ""
    diff "$OUT" "$TMP" | head -40 || true
    rm -f "$TMP"
    exit 1
  fi
  rm -f "$TMP"
  echo "OK: $OUT matches the live schema."
else
  mv "$TMP" "$OUT"
  echo "Wrote $OUT ($(wc -l < "$OUT" | tr -d ' ') lines)."
fi
