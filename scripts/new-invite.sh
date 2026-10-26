#!/usr/bin/env bash
# Creates a sign-up (invite) token, like the Invites tab of the app's Server Admin panel.
# Usage: ADMIN_TOKEN=<an admin's access token> scripts/new-invite.sh [uses=1] [days=7]
# Get a token with:
#   curl -s -X POST http://127.0.0.1:18008/_matrix/client/v3/login -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"<admin>"},"password":"<password>"}'
set -euo pipefail
: "${ADMIN_TOKEN:?Set ADMIN_TOKEN to the access token of an admin}"
USES=${1:-1}
DAYS=${2:-7}
API=${SYNAPSE_URL:-http://127.0.0.1:18008}

EXPIRY=$(( ($(date +%s) + DAYS * 86400) * 1000 ))
curl -sf -X POST "$API/_synapse/admin/v1/registration_tokens/new" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"uses_allowed\":$USES,\"expiry_time\":$EXPIRY}" \
  | python3 -c 'import sys, json; print(json.load(sys.stdin)["token"])'
