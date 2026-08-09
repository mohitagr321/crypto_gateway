#!/usr/bin/env bash
#
# Local development stack: Postgres + Redis + API + both panels.
#
# WHY THIS EXISTS
#   Starting the pieces by hand went wrong twice in ways that were slow to
#   diagnose, and this script exists to make both impossible:
#
#   1. MIGRATIONS. It applies EVERY file in sql/migrations/ in order, exactly as
#      deploy-crypto-gateway.sh does. A dev database that had 002 and 003 but not
#      004/005 produced 500s on /settings, /payouts and /account/onboarding that
#      looked like application bugs and were not.
#
#   2. NODE_ENV. The repo .env ships NODE_ENV=production. In production the app
#      refuses to boot with signup enabled and no SMTP — correct there, useless
#      here. This forces development mode, where verification and reset emails
#      are LOGGED (link included) instead of sent.
#
# Usage:
#   ./scripts/dev-up.sh            # start everything
#   ./scripts/dev-up.sh --down     # stop the node processes
#   ./scripts/dev-up.sh --reset-db # DROP and recreate the dev database first
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RUN_DIR="${TMPDIR:-/tmp}/crypto-gateway-dev"
mkdir -p "$RUN_DIR"

PG_SERVICE=postgres
PG_USER=gateway
PG_DB=gateway
API_PORT=4000
CLIENT_PORT=5174
ADMIN_PORT=5173

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

psql_db() { docker compose exec -T "$PG_SERVICE" psql -U "$PG_USER" -d "$1" "${@:2}"; }

stop_all() {
  say "Stopping dev processes"
  for name in api worker client admin; do
    if [ -f "$RUN_DIR/$name.pid" ]; then
      kill "$(cat "$RUN_DIR/$name.pid")" 2>/dev/null || true
      rm -f "$RUN_DIR/$name.pid"
    fi
  done
  # Belt and braces: anything still holding the ports.
  for port in $API_PORT $CLIENT_PORT $ADMIN_PORT; do
    pid="$(lsof -t -nP -iTCP:$port -sTCP:LISTEN 2>/dev/null || true)"
    [ -n "$pid" ] && kill $pid 2>/dev/null || true
  done
  echo "Stopped. (Postgres and Redis are left running — 'docker compose down' for those.)"
}

if [ "${1:-}" = "--down" ]; then stop_all; exit 0; fi

# ---------------------------------------------------------------------------
say "1/6  Docker services"
docker info >/dev/null 2>&1 || die "Docker is not running. Start Docker Desktop, then re-run."
docker compose up -d postgres redis >/dev/null 2>&1
for _ in $(seq 1 30); do
  if psql_db postgres -c 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
psql_db postgres -c 'SELECT 1' >/dev/null 2>&1 || die "Postgres did not become ready."
echo "Postgres and Redis are up."

# NOTE: the app reads REDIS_URL from .env. If that points at localhost:6379 there
# may be a HOST-NATIVE redis there rather than the container — flushing the
# container's Redis then has no effect on rate-limit buckets. See
# docs/deployment.md if a limiter appears permanently exhausted.

# ---------------------------------------------------------------------------
if [ "${1:-}" = "--reset-db" ]; then
  say "Resetting database $PG_DB (ALL DATA WILL BE LOST)"
  read -r -p "Type the database name to confirm: " confirm
  [ "$confirm" = "$PG_DB" ] || die "Not confirmed; nothing was dropped."
  psql_db postgres -q -c "DROP DATABASE IF EXISTS $PG_DB;" -c "CREATE DATABASE $PG_DB;"
  psql_db "$PG_DB" -v ON_ERROR_STOP=1 -q < sql/schema.sql
  echo "Fresh schema loaded."
fi

# ---------------------------------------------------------------------------
say "2/6  Schema"
if ! psql_db "$PG_DB" -t -A -c "SELECT to_regclass('payments')" 2>/dev/null | grep -q payments; then
  echo "No schema found — loading sql/schema.sql"
  psql_db "$PG_DB" -v ON_ERROR_STOP=1 -q < sql/schema.sql
fi

say "3/6  Migrations (all of them, in order — same as deploy)"
for mig in sql/migrations/*.sql; do
  [ -e "$mig" ] || continue
  case "$(basename "$mig")" in *_rollback.sql) continue ;; esac
  printf '  %-42s' "$(basename "$mig")"
  if psql_db "$PG_DB" -v ON_ERROR_STOP=1 -q < "$mig" >/dev/null 2>"$RUN_DIR/mig.err"; then
    echo "ok"
  else
    echo "FAILED"
    sed -n '1,5p' "$RUN_DIR/mig.err"
    die "Migration $(basename "$mig") failed — not starting the app."
  fi
done

# ---------------------------------------------------------------------------
say "4/6  Backend"
stop_all >/dev/null 2>&1 || true
(
  cd backend
  # NODE_ENV=development so emails are logged, not sent (see the header note).
  # Everything else still comes from the repo .env via dotenv.
  NODE_ENV=development \
  PORT="$API_PORT" \
  SIGNUP_ENABLED=true \
  LOG_LEVEL=info \
  PUBLIC_PANEL_URL="http://localhost:$CLIENT_PORT" \
  nohup npx tsx src/index.ts > "$RUN_DIR/api.log" 2>&1 &
  echo $! > "$RUN_DIR/api.pid"
)
for _ in $(seq 1 30); do
  curl -sf "http://localhost:$API_PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://localhost:$API_PORT/health" >/dev/null 2>&1 \
  || { sed -n '1,20p' "$RUN_DIR/api.log"; die "API did not start — see $RUN_DIR/api.log"; }
echo "API healthy on :$API_PORT"

# ---------------------------------------------------------------------------
# The BullMQ worker owns the repeatable ticks: expiry, settle (which also marks
# invoices paid) and subscription billing. Without it a subscription never bills
# and a paid invoice never leaves 'open' — both look like application bugs and
# are not, which is exactly the class of confusion this script exists to prevent.
#
# The blockchain listeners are deliberately NOT started here: they connect to a
# live chain, and a local stack should not need one to be useful.
say "5/6  Worker (repeatable jobs: expiry, settle, subscriptions)"
(
  cd backend
  NODE_ENV=development \
  LOG_LEVEL=info \
  PUBLIC_PANEL_URL="http://localhost:$CLIENT_PORT" \
  nohup npx tsx src/workers/index.ts > "$RUN_DIR/worker.log" 2>&1 &
  echo $! > "$RUN_DIR/worker.pid"
)
for _ in $(seq 1 20); do
  grep -q 'starting workers' "$RUN_DIR/worker.log" 2>/dev/null && break
  sleep 1
done
if grep -q 'starting workers' "$RUN_DIR/worker.log" 2>/dev/null; then
  echo "Worker running"
else
  warn "Worker did not report ready — see $RUN_DIR/worker.log (the API still works)"
fi

# ---------------------------------------------------------------------------
say "6/6  Panels"
( cd client-panel && nohup npx vite --port "$CLIENT_PORT" --strictPort > "$RUN_DIR/client.log" 2>&1 & echo $! > "$RUN_DIR/client.pid" )
( cd admin-panel  && nohup npx vite --port "$ADMIN_PORT"  --strictPort > "$RUN_DIR/admin.log"  2>&1 & echo $! > "$RUN_DIR/admin.pid" )
sleep 5

NETWORKS="$(curl -s "http://localhost:$API_PORT/api/v1/networks" || echo '?')"
# Kept to sed/tr rather than an inline python one-liner: nesting quotes through
# bash -> python -> f-string is a reliable source of syntax errors.
ASSETS="$(curl -s "http://localhost:$API_PORT/api/v1/assets" \
  | tr ',' '\n' | grep -o '"symbol": *"[A-Z]*"' | sed 's/.*"\([A-Z]*\)"/\1/' \
  | paste -sd' ' - 2>/dev/null || echo '?')"
# Fiat currencies this gateway can price in. Empty here usually means the rate
# provider was unreachable at boot, not that the config is wrong — see
# services/rateService.ts for what degrades and what refuses.
#
# Read ONLY the "currencies" array. Grepping the whole body for three-letter
# tokens also matches asset symbols — DAI is not a currency.
CURRENCIES="$(curl -s "http://localhost:$API_PORT/api/v1/rates" \
  | sed -n 's/.*"currencies":\[\([^]]*\)\].*/\1/p' | tr -d '"' | tr ',' ' ' \
  || echo '?')"

cat <<EOF

  Merchant panel + public site   http://localhost:$CLIENT_PORT
  Admin panel                    http://localhost:$ADMIN_PORT
  API                            http://localhost:$API_PORT/api/v1
  API docs                       http://localhost:$API_PORT/docs

  Networks   $NETWORKS
  Assets     $ASSETS
  Currencies $CURRENCIES

  Emails are NOT sent in development — they are written to the API log.
  Grab the newest verification or reset link with:

    grep -oE 'http://localhost:$CLIENT_PORT/(verify-email|reset-password)\?token=[a-f0-9]+' \\
      $RUN_DIR/api.log | tail -1

  Logs:  $RUN_DIR/{api,worker,client,admin}.log
  Stop:  ./scripts/dev-up.sh --down

EOF
