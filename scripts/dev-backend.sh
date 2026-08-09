#!/usr/bin/env bash
# =============================================================================
# Start the backend: api + worker + listener together (Node 20, colored logs).
# Run:  bash scripts/dev-backend.sh      (Ctrl-C stops all three)
# Requires: bash scripts/dev-setup.sh has been run at least once.
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

NODE_BIN="$HOME/.nvm/versions/node/v20.20.2/bin"
if [ ! -x "$NODE_BIN/node" ]; then
  NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/v2[0-9]* 2>/dev/null | sort -V | tail -1)/bin"
fi
[ -x "$NODE_BIN/node" ] || { echo "No Node >=20 found under ~/.nvm"; exit 1; }
export PATH="$NODE_BIN:$PATH"

echo "Using node $("$NODE_BIN/node" -v)"
echo "Starting api (:4000) + worker + listener ... (Ctrl-C to stop all)"
cd "$ROOT/backend"
exec npm run dev:all
