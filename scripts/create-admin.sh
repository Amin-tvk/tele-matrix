#!/usr/bin/env bash
# Creates a server admin account. Admins get the Server Admin panel in the app and access to /admin/.
# Usage: scripts/create-admin.sh <username>   (asks for the password)
set -euo pipefail
cd "$(dirname "$0")/.."
USERNAME=${1:?Usage: scripts/create-admin.sh <username>}

docker compose exec synapse \
  register_new_matrix_user -c /data/homeserver.yaml --admin -u "$USERNAME" http://localhost:8008
