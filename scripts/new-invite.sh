#!/usr/bin/env bash
# Creates a sign-up (invite) code, like the Invites tab of the app's Server Admin panel.
# Usage: scripts/new-invite.sh <admin username> [uses=1] [days=7]   (asks for the admin's password)
set -euo pipefail
cd "$(dirname "$0")/.."
ADMIN=${1:?Usage: scripts/new-invite.sh <admin username> [uses=1] [days=7]}
USES=${2:-1}
DAYS=${3:-7}
read -rsp "Password for $ADMIN: " PASSWORD
echo

# Runs inside the Synapse container, so nothing but Docker is needed on the host
docker compose exec -T -e ADMIN="$ADMIN" -e PASSWORD="$PASSWORD" -e USES="$USES" -e DAYS="$DAYS" synapse python - <<'PY'
import json, os, time, urllib.request

API = "http://localhost:8008"

def call(method, path, body=None, token=None):
    request = urllib.request.Request(API + path, method=method, data=json.dumps(body or {}).encode())
    request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request) as response:
        return json.load(response)

token = call("POST", "/_matrix/client/v3/login", {
    "type": "m.login.password",
    "identifier": {"type": "m.id.user", "user": os.environ["ADMIN"]},
    "password": os.environ["PASSWORD"],
})["access_token"]
try:
    expiry = int((time.time() + int(os.environ["DAYS"]) * 86400) * 1000)
    invite = call("POST", "/_synapse/admin/v1/registration_tokens/new",
                  {"uses_allowed": int(os.environ["USES"]), "expiry_time": expiry}, token)
    print(invite["token"])
finally:
    call("POST", "/_matrix/client/v3/logout", token=token)
PY
