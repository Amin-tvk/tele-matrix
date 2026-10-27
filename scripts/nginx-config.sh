#!/usr/bin/env bash
# Prints the nginx config for this install, with the domains and ports from .env filled in.
# Usage: scripts/nginx-config.sh | sudo tee /etc/nginx/conf.d/peyvand.conf
#        add --http-only for the first run, before the certificates exist (see docs/nginx.md)
set -euo pipefail
cd "$(dirname "$0")/.."

get() {
  local value
  value=$(grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true)
  echo "${value:-$2}"
}

APP_DOMAIN=$(get APP_DOMAIN '')
MATRIX_DOMAIN=$(get MATRIX_DOMAIN '')
if [ -z "$APP_DOMAIN" ] || [ -z "$MATRIX_DOMAIN" ]; then
  echo "Set APP_DOMAIN and MATRIX_DOMAIN in .env first" >&2
  exit 1
fi

config=$(sed \
  -e "s/__APP_DOMAIN__/$APP_DOMAIN/g" \
  -e "s/__MATRIX_DOMAIN__/$MATRIX_DOMAIN/g" \
  -e "s/__WEB_PORT__/$(get WEB_LOCAL_PORT 18085)/g" \
  -e "s/__SYNAPSE_PORT__/$(get SYNAPSE_LOCAL_PORT 18008)/g" \
  -e "s/__SYGNAL_PORT__/$(get SYGNAL_LOCAL_PORT 18083)/g" \
  -e "s/__KETESA_PORT__/$(get KETESA_LOCAL_PORT 18082)/g" \
  server/nginx/peyvand.conf.template)

if [ "${1:-}" = "--http-only" ]; then
  # Only the port 80 block, so nginx starts before the certificates are issued
  echo "$config" | awk '/^# The Peyvand web app/{exit} {print}'
else
  echo "$config"
fi
