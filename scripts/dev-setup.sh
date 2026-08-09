#!/usr/bin/env bash
# =============================================================================
# One-time (safe to re-run) local dev setup for the crypto gateway.
#   - Uses Node 20 from nvm automatically (your default node is v14).
#   - Runs Postgres in Docker on host port 55432 (avoids your existing :5432).
#   - Uses your native Redis on :6379 (starts a Docker one only if missing).
#   - Loads the SQL schema, points .env at the DB, installs deps, seeds admin.
# Run:  bash scripts/dev-setup.sh
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_CONTAINER="cg-pg"
PG_PORT="55432"
DB_URL="postgres://gateway:gateway@localhost:${PG_PORT}/gateway"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m    ✓ %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m    ✗ %s\033[0m\n' "$1"; exit 1; }

# ---- Node 20 --------------------------------------------------------------
say "Selecting Node 20 (nvm)"
NODE_BIN="$HOME/.nvm/versions/node/v20.20.2/bin"
if [ ! -x "$NODE_BIN/node" ]; then
  NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/v2[0-9]* 2>/dev/null | sort -V | tail -1)/bin"
fi
[ -x "$NODE_BIN/node" ] || die "No Node >=20 found under ~/.nvm. Install with: nvm install 20"
export PATH="$NODE_BIN:$PATH"
ok "node $("$NODE_BIN/node" -v)"

# ---- Docker ---------------------------------------------------------------
say "Checking Docker"
docker info >/dev/null 2>&1 || die "Docker isn't running. Open Docker Desktop and retry."
ok "docker is up"

# ---- Postgres -------------------------------------------------------------
say "Postgres on :$PG_PORT (Docker container '$PG_CONTAINER')"
if docker ps -a --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
  docker start "$PG_CONTAINER" >/dev/null 2>&1 || true
  ok "reusing existing container"
else
  docker run -d --name "$PG_CONTAINER" \
    -e POSTGRES_USER=gateway -e POSTGRES_PASSWORD=gateway -e POSTGRES_DB=gateway \
    -p "${PG_PORT}:5432" postgres:16-alpine >/dev/null || die "could not start postgres"
  ok "created container"
fi

printf '    waiting for postgres to accept connections'
for _ in $(seq 1 60); do
  if docker exec "$PG_CONTAINER" pg_isready -U gateway >/dev/null 2>&1; then READY=1; break; fi
  printf '.'; sleep 1
done
printf '\n'
[ "${READY:-0}" = "1" ] || die "postgres did not become ready"
ok "postgres ready"

# ---- Schema (only if not already loaded) ----------------------------------
say "Loading SQL schema (idempotent)"
TBLS="$(docker exec -e PGPASSWORD=gateway "$PG_CONTAINER" psql -U gateway -d gateway -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null | tr -d '[:space:]')"
if [ "${TBLS:-0}" -lt 5 ]; then
  docker exec -i -e PGPASSWORD=gateway "$PG_CONTAINER" psql -U gateway -d gateway -v ON_ERROR_STOP=1 \
    < "$ROOT/sql/schema.sql" >/tmp/cg-schema.log 2>&1 || { tail -20 /tmp/cg-schema.log; die "schema load failed"; }
  ok "schema loaded"
else
  ok "schema already present ($TBLS tables)"
fi

# ---- Redis ----------------------------------------------------------------
say "Redis on :6379"
if nc -z -w1 localhost 6379 >/dev/null 2>&1; then
  ok "redis reachable (using your existing one)"
else
  docker rm -f cg-redis >/dev/null 2>&1 || true
  docker run -d --name cg-redis -p 6379:6379 redis:7-alpine >/dev/null || die "could not start redis"
  ok "started a Docker redis"
fi

# ---- Point .env at the DB -------------------------------------------------
say "Updating .env DATABASE_URL / REDIS_URL"
ENVF="$ROOT/.env"
[ -f "$ENVF" ] || cp "$ROOT/.env.example" "$ENVF"
# macOS sed in-place
sed -i '' -E "s#^DATABASE_URL=.*#DATABASE_URL=${DB_URL}#" "$ENVF"
sed -i '' -E "s#^REDIS_URL=.*#REDIS_URL=redis://localhost:6379#" "$ENVF"
ok "DATABASE_URL -> localhost:${PG_PORT}"

# ---- Install + seed -------------------------------------------------------
say "Installing backend deps"
( cd "$ROOT/backend" && npm install --no-audit --no-fund >/tmp/cg-npm.log 2>&1 ) \
  && ok "deps installed" || { tail -20 /tmp/cg-npm.log; die "npm install failed"; }

say "Seeding admin user"
( cd "$ROOT/backend" && npm run seed 2>&1 | grep -viE '^\s*$|^>|tsx' ) || die "seed failed"

# ---- Frontends (static nginx containers; --no-deps avoids the compose DB) --
say "Starting Admin + Merchant panels (Docker :5173 / :5174)"
docker compose up -d --no-deps admin-panel client-panel >/dev/null 2>&1 \
  && ok "panels up" || ok "panels not started (run: docker compose up -d --no-deps admin-panel client-panel)"

# ---- Done -----------------------------------------------------------------
say "Setup complete"
cat <<'EOF'
 To start the backend (api + worker + listener):

     bash scripts/dev-backend.sh

 Then open:
     Admin panel    ->  http://localhost:5173   (admin@example.com / Admin@12345)
     Merchant panel ->  http://localhost:5174
     API health     ->  http://localhost:4000/health
     API docs       ->  http://localhost:4000/docs
EOF
