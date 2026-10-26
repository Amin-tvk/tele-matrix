#!/bin/sh
# Runs on every container start (nginx image entrypoint hook): copies the built app and fills in this
# deployment's settings, so changing a domain only needs a restart.
set -eu

: "${APP_DOMAIN:?Set APP_DOMAIN}"
: "${MATRIX_DOMAIN:?Set MATRIX_DOMAIN}"
PUSH_APP_ID=${PUSH_APP_ID:-com.example.peyvand.web}
VAPID_PUBLIC_KEY=$(cat /peyvand/vapid_public.txt 2>/dev/null || true)
if [ -z "$VAPID_PUBLIC_KEY" ]; then
  echo "peyvand: no VAPID key found, push notifications are off" >&2
fi

HTML=/usr/share/nginx/html
rm -rf "${HTML:?}"/*
cp -a /opt/peyvand/dist/. "$HTML"/

find "$HTML" -type f \( -name '*.js' -o -name '*.html' -o -name '*.json' -o -name '*.webmanifest' \) \
  -exec grep -l '__PEYVAND_' {} + 2>/dev/null \
  | xargs -r sed -i \
    -e "s#__PEYVAND_APP_DOMAIN__#${APP_DOMAIN}#g" \
    -e "s#__PEYVAND_MATRIX_DOMAIN__#${MATRIX_DOMAIN}#g" \
    -e "s#__PEYVAND_PUSH_APP_ID__#${PUSH_APP_ID}#g" \
    -e "s#__PEYVAND_VAPID_PUBLIC_KEY__#${VAPID_PUBLIC_KEY}#g"

echo "peyvand: app configured for https://${APP_DOMAIN} (homeserver https://${MATRIX_DOMAIN})"
