#!/usr/bin/env bash
# Builds the Peyvand web app with Docker and publishes it to server/data/www (served by the "web" service).
# Needs .env and the VAPID key from scripts/setup.sh.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
set -a
# shellcheck disable=SC1091
. "$ROOT/.env"
set +a

VAPID_PUBLIC_KEY=$(cat "$ROOT/server/data/sygnal/vapid_public.txt" 2>/dev/null || true)
if [ -z "$VAPID_PUBLIC_KEY" ]; then
  echo "No VAPID key yet: run scripts/setup.sh first. Building without push notifications." >&2
fi

docker run --rm -v "$ROOT/client:/app" -w /app \
  -e APP_ENV=production \
  -e APP_TITLE="${APP_TITLE:-Peyvand}" \
  -e BASE_URL="https://$APP_DOMAIN" \
  -e MATRIX_HOMESERVER="https://$MATRIX_DOMAIN" \
  -e PUSH_APP_ID="$PUSH_APP_ID" \
  -e VAPID_PUBLIC_KEY="$VAPID_PUBLIC_KEY" \
  node:24-bookworm sh -c '
    set -e
    [ -d node_modules ] || npm ci --no-audit --no-fund
    rm -rf dist
    npx vite build
    find dist -name "*.map" -delete'

test -f "$ROOT/client/dist/index.html"
mkdir -p "$ROOT/server/data/www"
rsync -a --delete "$ROOT/client/dist/" "$ROOT/server/data/www/"
echo "Published to server/data/www"
