#!/usr/bin/env bash
# Generates every server config and secret into server/data from .env.
# Safe to run again: files that already exist are kept, so secrets are never replaced.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DATA="$ROOT/server/data"
TEMPLATES="$ROOT/server/templates"
SYNAPSE_IMAGE=matrixdotorg/synapse:v1.163.2
SYNAPSE_UID=991

if [ ! -f "$ROOT/.env" ]; then
  echo "Missing .env: copy .env.example to .env and fill it in first." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
. "$ROOT/.env"
set +a

for name in APP_DOMAIN MATRIX_DOMAIN ADMIN_EMAIL PUSH_APP_ID; do
  if [ -z "${!name:-}" ]; then
    echo "Set $name in .env" >&2
    exit 1
  fi
done
CINNY_DOMAIN=${CINNY_DOMAIN:-}

command -v docker >/dev/null || { echo "Docker is required" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

mkdir -p "$DATA/synapse" "$DATA/sygnal" "$DATA/postgres" "$DATA/www" "$DATA/nginx"

secret() { openssl rand -hex 32; }

# Replaces {{NAME}} with the value of the NAME variable
render() {
  local template=$1 output=$2
  if [ -f "$output" ]; then
    echo "  kept     ${output#"$ROOT"/}"
    return
  fi
  local content
  content=$(cat "$template")
  for name in APP_DOMAIN MATRIX_DOMAIN CINNY_DOMAIN ADMIN_EMAIL PUSH_APP_ID POSTGRES_PASSWORD \
    REGISTRATION_SHARED_SECRET MACAROON_SECRET_KEY FORM_SECRET CINNY_SERVER_NAME CINNY_BLOCK; do
    content=${content//"{{$name}}"/${!name:-}}
  done
  printf '%s\n' "$content" > "$output"
  echo "  created  ${output#"$ROOT"/}"
}

echo "Generating configs in server/data"

# Database password, reused by Synapse
if [ -f "$DATA/postgres.env" ]; then
  POSTGRES_PASSWORD=$(sed -n 's/^POSTGRES_PASSWORD=//p' "$DATA/postgres.env")
  echo "  kept     server/data/postgres.env"
else
  POSTGRES_PASSWORD=$(secret)
  cat > "$DATA/postgres.env" <<ENV
POSTGRES_USER=synapse
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_DB=synapse
POSTGRES_INITDB_ARGS=--encoding=UTF-8 --lc-collate=C --lc-ctype=C
ENV
  chmod 600 "$DATA/postgres.env"
  echo "  created  server/data/postgres.env"
fi

REGISTRATION_SHARED_SECRET=$(secret)
MACAROON_SECRET_KEY=$(secret)
FORM_SECRET=$(secret)
render "$TEMPLATES/homeserver.yaml.tmpl" "$DATA/synapse/homeserver.yaml"
chmod 600 "$DATA/synapse/homeserver.yaml"
[ -f "$DATA/synapse/log.config" ] || cp "$TEMPLATES/log.config" "$DATA/synapse/log.config"

# The server's identity key. Losing it breaks federation with other servers
if [ ! -f "$DATA/synapse/signing.key" ]; then
  docker run --rm --entrypoint python "$SYNAPSE_IMAGE" -c \
    "import sys; from signedjson.key import generate_signing_key, write_signing_keys; \
write_signing_keys(sys.stdout, [generate_signing_key('a_' + __import__('secrets').token_hex(2))])" \
    > "$DATA/synapse/signing.key"
  echo "  created  server/data/synapse/signing.key"
fi
chown -R "$SYNAPSE_UID:$SYNAPSE_UID" "$DATA/synapse" 2>/dev/null \
  || echo "  warning: run as root (or chown -R $SYNAPSE_UID:$SYNAPSE_UID server/data/synapse) so Synapse can write"

# Web Push (VAPID) key pair: the private key stays in Sygnal, the public key is built into the client
if [ ! -f "$DATA/sygnal/vapid_private.pem" ]; then
  openssl ecparam -name prime256v1 -genkey -noout -out "$DATA/sygnal/vapid_private.pem" 2>/dev/null
  chmod 644 "$DATA/sygnal/vapid_private.pem"
  echo "  created  server/data/sygnal/vapid_private.pem"
fi
openssl ec -in "$DATA/sygnal/vapid_private.pem" -pubout -outform DER 2>/dev/null \
  | tail -c 65 | base64 -w0 | tr '/+' '_-' | tr -d '=' > "$DATA/sygnal/vapid_public.txt"
render "$TEMPLATES/sygnal.yaml.tmpl" "$DATA/sygnal/sygnal.yaml"

render "$TEMPLATES/ketesa.json.tmpl" "$DATA/ketesa.json"
render "$TEMPLATES/cinny.json.tmpl" "$DATA/cinny.json"

CINNY_SERVER_NAME=""
CINNY_BLOCK=""
if [ -n "$CINNY_DOMAIN" ]; then
  CINNY_SERVER_NAME=" $CINNY_DOMAIN"
  CINNY_BLOCK=$(CINNY_DOMAIN=$CINNY_DOMAIN; c=$(cat "$TEMPLATES/host-nginx-cinny.conf.tmpl"); printf '%s' "${c//"{{CINNY_DOMAIN}}"/$CINNY_DOMAIN}")
fi
render "$TEMPLATES/host-nginx.conf.tmpl" "$DATA/nginx/peyvand.conf"

cat <<DONE

Done. Next steps:
  1. docker compose -f server/compose.yml up -d
  2. scripts/build-client.sh
  3. sudo cp server/data/nginx/peyvand.conf /etc/nginx/conf.d/ && sudo nginx -t && sudo systemctl reload nginx
  4. scripts/create-admin.sh <username>
DONE
