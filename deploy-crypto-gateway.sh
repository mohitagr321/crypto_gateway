#!/usr/bin/env bash
###############################################################################
# Crypto Payment Gateway (USDT/BEP20) — bare-metal deploy for an Ubuntu server
# that ALREADY runs other software (e.g. Zaplo) behind Apache2.
#
# Designed to COEXIST with what you already have:
#   • Reuses your existing PostgreSQL, Redis, Apache2 and certbot.
#   • Creates its OWN Postgres database + role  ->  gateway / gateway
#   • Uses an ISOLATED Redis logical DB (#1)    ->  Zaplo/others keep #0
#   • Runs its API on port 4100                 ->  Zaplo keeps 4000
#   • Runs api + worker + BSC listener + Tron listener under PM2 (cg-* names)
#
# HOW TO USE
#   The code is pulled from GitHub (Ezulix/CryptoPay). Secrets are NEVER in the
#   repo — you provide them once, out-of-band, on the server.
#
#   1. Put your REAL production env (mnemonic / central wallet / gas key, from
#      .env.example) on the server at:   ~/crypto-gateway.env
#      e.g. from your Mac:
#        scp ./.env  youruser@server:~/crypto-gateway.env
#      (override the path by exporting SOURCE_ENV=/path/to/env before running.)
#
#   2. Get this script (it lives in the repo) and run it:
#        curl -fsSLO https://raw.githubusercontent.com/Ezulix/CryptoPay/main/deploy-crypto-gateway.sh
#        chmod +x deploy-crypto-gateway.sh
#        # if the repo is PRIVATE, export a read token first:
#        #   export GITHUB_TOKEN=ghp_xxx
#        ./deploy-crypto-gateway.sh
#
# Run as a NORMAL sudo-capable user (NOT via `sudo`). Root is also fine.
###############################################################################
set -euo pipefail

# ─────────────────────────── EDIT THESE VALUES ──────────────────────────────
CLIENT_DOMAIN="pay.ezulix.com"          # merchant / client panel
ADMIN_DOMAIN="admin-pay.ezulix.com"     # admin panel
API_DOMAIN="pay-api.ezulix.com"             # dedicated API hostname (merchants call this)
LE_EMAIL="namit@ezulix.com"             # Let's Encrypt contact

# First-login admin (idempotent — only created if it doesn't exist yet).
ADMIN_EMAIL="admin@ezulix.com"
ADMIN_PASSWORD="ChangeMe@12345"
# ────────────────────────────────────────────────────────────────────────────

# Fixed settings (change only if you know why)
REPO_URL="https://github.com/Ezulix/CryptoPay.git"
# Only needed if the repo is PRIVATE. Export it in your shell before running
# (export GITHUB_TOKEN=ghp_xxx) — do NOT hardcode it here / commit it.
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
# Where your filled production env lives on the server (contains wallet secrets).
SOURCE_ENV="${SOURCE_ENV:-$HOME/crypto-gateway.env}"

APP_DIR="/var/www/crypto-gateway"       # where the app lives + is served from
API_PORT="4100"                         # host port for the API (Zaplo owns 4000)
REDIS_DB="1"                            # isolated Redis logical DB (others use 0)
PG_DB="gateway"
PG_ROLE="gateway"
RUN_USER="$(whoami)"
RUN_HOME="$HOME"

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠  %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

# Update-or-append a KEY=VALUE line in an env file (no sed escaping headaches).
set_env() {
  local key="$1" val="$2" file="$3"
  [ -f "$file" ] || : > "$file"
  if grep -qE "^${key}=" "$file"; then
    grep -vE "^${key}=" "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
  fi
  printf '%s=%s\n' "$key" "$val" >> "$file"
}

# Like set_env, but NEVER overwrites a key that is already present. Used for
# opt-in feature config (e.g. the TRON_* block): a re-deploy must not reset an
# operator's TRON_ENABLED=true or wipe the Tron hot-wallet key they pasted in.
default_env() {
  local key="$1" val="$2" file="$3"
  [ -f "$file" ] || : > "$file"
  grep -qE "^${key}=" "$file" || printf '%s=%s\n' "$key" "$val" >> "$file"
}

# ── Preflight ────────────────────────────────────────────────────────────────
command -v sudo >/dev/null || die "sudo is required (apt-get install -y sudo)."
[ "$(id -u)" -eq 0 ] && echo "ℹ  Running as root — OK." || sudo -v || die "This user cannot sudo."
# On a FIRST deploy we need your filled env (with wallet secrets) somewhere the
# script can read it — either already at $APP_DIR/.env, or at $SOURCE_ENV.
if [ ! -f "$APP_DIR/.env" ] && [ ! -f "$SOURCE_ENV" ]; then
  die "No env found. Put your production env at $SOURCE_ENV (see .env.example) — it must contain HD_WALLET_MNEMONIC / CENTRAL_WALLET_ADDRESS / GAS_STATION_PRIVATE_KEY. Then re-run."
fi
if [ ! -f "$APP_DIR/.env" ] && ! grep -q '^HD_WALLET_MNEMONIC=' "$SOURCE_ENV"; then
  die "$SOURCE_ENV is missing HD_WALLET_MNEMONIC — is it a complete production env?"
fi

###############################################################################
say "1/12  Base packages"
###############################################################################
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -y
sudo apt-get install -y git curl ca-certificates gnupg build-essential rsync \
                        lsb-release apt-transport-https openssl

###############################################################################
say "2/12  Node.js 20 + PM2 (reused if already present from other apps)"
###############################################################################
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
command -v pm2 >/dev/null || sudo npm install -g pm2
node -v; npm -v; pm2 -v

###############################################################################
say "3/12  PostgreSQL (reuse existing; install only if absent)"
###############################################################################
if ! command -v psql >/dev/null && ! systemctl list-unit-files | grep -q '^postgresql'; then
  sudo apt-get install -y postgresql postgresql-contrib
else
  # Ensure contrib is present for pgcrypto/citext extensions the schema needs.
  sudo apt-get install -y postgresql-contrib || true
fi
sudo systemctl enable --now postgresql

# Decide the DB password: reuse the one already in the deployed .env on re-runs,
# otherwise generate a fresh one.
if [ -f "$APP_DIR/.env" ]; then
  PG_PW="$(grep -oP '://'"${PG_ROLE}"':\K[^@]+' "$APP_DIR/.env" | head -1)"
  [ -n "$PG_PW" ] || die "Could not read existing DB password from $APP_DIR/.env"
  echo "Reusing existing database password from $APP_DIR/.env"
else
  PG_PW="$(openssl rand -hex 24)"
fi

# Role + database (idempotent), then sync the role password to PG_PW.
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${PG_ROLE}'" | grep -q 1; then
  sudo -u postgres psql -c "ALTER ROLE ${PG_ROLE} LOGIN PASSWORD '${PG_PW}';"
else
  sudo -u postgres psql -c "CREATE ROLE ${PG_ROLE} LOGIN PASSWORD '${PG_PW}';"
fi
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${PG_DB}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE ${PG_DB} OWNER ${PG_ROLE};"
# pgcrypto/citext are 'trusted' in PG16 but create them as superuser to be safe.
sudo -u postgres psql -d "${PG_DB}" -c 'CREATE EXTENSION IF NOT EXISTS "pgcrypto";'
sudo -u postgres psql -d "${PG_DB}" -c 'CREATE EXTENSION IF NOT EXISTS "citext";'

###############################################################################
say "4/12  Redis (reuse existing; install only if absent)"
###############################################################################
if ! command -v redis-cli >/dev/null && ! systemctl list-unit-files | grep -q '^redis'; then
  sudo apt-get install -y redis-server
fi
sudo systemctl enable --now redis-server 2>/dev/null || sudo systemctl enable --now redis 2>/dev/null || true
redis-cli ping || die "Redis is not responding."

###############################################################################
say "5/12  Fetch the code into $APP_DIR (git clone / pull)"
###############################################################################
sudo mkdir -p "$(dirname "$APP_DIR")"
sudo chown "$RUN_USER":"$RUN_USER" "$(dirname "$APP_DIR")" 2>/dev/null || true
TOKEN_URL="https://${GITHUB_TOKEN}@github.com/Ezulix/CryptoPay.git"
if [ -d "$APP_DIR/.git" ]; then
  echo "Repo already present — pulling latest."
  if [ -n "$GITHUB_TOKEN" ]; then
    # Pass the token only for this fetch — it is never written to .git/config.
    git -C "$APP_DIR" pull --ff-only "$TOKEN_URL" || warn "git pull skipped (local changes?)."
  else
    git -C "$APP_DIR" pull --ff-only || warn "git pull skipped (local changes?)."
  fi
elif [ -n "$GITHUB_TOKEN" ]; then
  git clone "$TOKEN_URL" "$APP_DIR"
  git -C "$APP_DIR" remote set-url origin "$REPO_URL"   # strip token from stored remote
else
  git clone "$REPO_URL" "$APP_DIR"   # works only if the repo is PUBLIC
fi

###############################################################################
say "6/12  Production .env (wallet values reused; secrets fresh on first run)"
###############################################################################
ENV_FILE="$APP_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  # Seed from your out-of-band production env (never in git), then override
  # infra/secrets. $SOURCE_ENV was verified to exist + hold the mnemonic above.
  cp "$SOURCE_ENV" "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  set_env NODE_ENV     production                                     "$ENV_FILE"
  set_env PORT         "$API_PORT"                                    "$ENV_FILE"
  set_env APP_BASE_URL "https://${CLIENT_DOMAIN}"                     "$ENV_FILE"
  set_env DATABASE_URL "postgres://${PG_ROLE}:${PG_PW}@localhost:5432/${PG_DB}" "$ENV_FILE"
  set_env REDIS_URL    "redis://localhost:6379/${REDIS_DB}"          "$ENV_FILE"
  # Fresh secrets — only ever generated here, on first deploy (DB is empty, so
  # rotating MASTER_ENCRYPTION_KEY is safe; nothing is encrypted-at-rest yet).
  set_env JWT_SECRET            "$(openssl rand -hex 32)"            "$ENV_FILE"
  set_env MASTER_ENCRYPTION_KEY "$(openssl rand -hex 32)"           "$ENV_FILE"

  echo "Wrote $ENV_FILE (wallet values preserved, infra + secrets set)."
else
  # Re-run: keep the live .env, but make sure infra values still point right.
  set_env PORT         "$API_PORT"                                    "$ENV_FILE"
  set_env APP_BASE_URL "https://${CLIENT_DOMAIN}"                     "$ENV_FILE"
  set_env DATABASE_URL "postgres://${PG_ROLE}:${PG_PW}@localhost:5432/${PG_DB}" "$ENV_FILE"
  set_env REDIS_URL    "redis://localhost:6379/${REDIS_DB}"          "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "$ENV_FILE already existed — kept secrets, refreshed infra URLs."
fi

# ── TRC20 / Tron block (opt-in, OFF by default) ──────────────────────────────
# Written with default_env so a re-deploy never clobbers a live Tron config.
# TRON_ENABLED=false means the Tron listener idles and the API rejects
# network=TRC20 — a BEP20-only gateway behaves exactly as it always has.
# To turn TRC20 on, see docs/deployment.md §7b, then:
#   nano $APP_DIR/.env   ->  TRON_ENABLED=true + TRON_CENTRAL_WALLET_PRIVATE_KEY
#   pm2 restart cg-api cg-worker cg-listener-tron
default_env TRON_ENABLED                    false                                "$ENV_FILE"
default_env TRON_FULL_HOST                  "https://api.trongrid.io"            "$ENV_FILE"
default_env TRON_API_KEY                    ""                                   "$ENV_FILE"
default_env TRON_USDT_CONTRACT              "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" "$ENV_FILE"
default_env TRON_USDT_DECIMALS              6                                    "$ENV_FILE"
default_env TRON_REQUIRED_CONFIRMATIONS     19                                   "$ENV_FILE"
default_env TRON_HD_DERIVATION_PATH         "m/44'/195'/0'/0"                    "$ENV_FILE"
default_env TRON_CENTRAL_WALLET_ADDRESS     ""                                   "$ENV_FILE"
default_env TRON_CENTRAL_WALLET_PRIVATE_KEY ""                                   "$ENV_FILE"
default_env TRON_GAS_STATION_PRIVATE_KEY    ""                                   "$ENV_FILE"
default_env TRON_MIN_SWEEP_AMOUNT           "1.0"                                "$ENV_FILE"
default_env TRON_GAS_TOPUP_TRX              30                                   "$ENV_FILE"
default_env TRON_FEE_LIMIT_TRX              100                                  "$ENV_FILE"
chmod 600 "$ENV_FILE"

###############################################################################
say "7/12  Build the backend (api + worker + both listeners share one build)"
###############################################################################
cd "$APP_DIR/backend"
npm install
npm run build

###############################################################################
say "8/12  Database schema (first init only) + seed admin"
###############################################################################
# Apply schema.sql only if the DB has not been initialised (schema is not
# re-runnable — it uses plain CREATE TABLE).
HAS_SCHEMA="$(PGPASSWORD="$PG_PW" psql -h localhost -U "$PG_ROLE" -d "$PG_DB" -tAc "SELECT to_regclass('public.users')" 2>/dev/null || true)"
if [ -z "$HAS_SCHEMA" ] || [ "$HAS_SCHEMA" = "" ]; then
  echo "Loading sql/schema.sql ..."
  PGPASSWORD="$PG_PW" psql -h localhost -U "$PG_ROLE" -d "$PG_DB" -v ON_ERROR_STOP=1 -f "$APP_DIR/sql/schema.sql"
else
  echo "Schema already present (public.users exists) — skipping schema load."
fi

# Apply every migration in sql/migrations/ in filename order.
#
# WHY THIS IS NOT OPTIONAL: schema.sql above runs on FIRST INIT ONLY, so an
# already-deployed gateway never picks up later schema changes. Migration 004
# re-keys chain_cursor from `id = 1` to `network`, and the listener code in this
# build queries `WHERE network = 'BEP20'`. Shipping the code without the
# migration would break the *existing, working* BEP20 listener — so migrations
# must run BEFORE PM2 restarts anything (step 10).
#
# Every migration is written to be idempotent (IF NOT EXISTS / ON CONFLICT /
# guarded DO blocks), so re-running them on every deploy is a safe no-op.
say "8b/12  Apply SQL migrations (idempotent)"
for mig in "$APP_DIR"/sql/migrations/*.sql; do
  [ -e "$mig" ] || continue
  case "$(basename "$mig")" in
    *_rollback.sql) continue ;;   # rollbacks are manual-only, never auto-applied
  esac
  echo "  -> $(basename "$mig")"
  PGPASSWORD="$PG_PW" psql -h localhost -U "$PG_ROLE" -d "$PG_DB" \
    -v ON_ERROR_STOP=1 -f "$mig" >/dev/null \
    || die "Migration $(basename "$mig") FAILED — not starting the app. Fix the DB first."
done
echo "Migrations applied."

echo "Seeding super_admin (idempotent) ..."
SEED_ADMIN_EMAIL="$ADMIN_EMAIL" SEED_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  node "$APP_DIR/backend/dist/seed.js" || warn "Seed reported a problem — check output above."

###############################################################################
say "9/12  Build the two panels (API URL baked per-domain at build time)"
###############################################################################
cd "$APP_DIR/client-panel"
npm install
VITE_API_BASE_URL="https://${API_DOMAIN}/api/v1" \
VITE_BSCSCAN_URL="https://bscscan.com" \
  npm run build

cd "$APP_DIR/admin-panel"
npm install
VITE_API_BASE_URL="https://${API_DOMAIN}/api/v1" \
  npm run build

# Make the built SPAs readable by Apache (www-data).
chmod -R a+rX "$APP_DIR/client-panel/dist" "$APP_DIR/admin-panel/dist"
# Ensure the path down to the dist dirs is traversable by www-data.
sudo chmod a+rX /var/www "$APP_DIR" "$APP_DIR/client-panel" "$APP_DIR/admin-panel"

###############################################################################
say "10/12  Start api + worker + both listeners under PM2 (one instance each!)"
###############################################################################
cat > "$APP_DIR/ecosystem.config.js" <<EOF
module.exports = {
  apps: [
    { name: 'cg-api',      cwd: '${APP_DIR}/backend', script: 'dist/index.js',
      env: { NODE_ENV: 'production' }, max_memory_restart: '600M' },
    { name: 'cg-worker',   cwd: '${APP_DIR}/backend', script: 'dist/workers/index.js',
      env: { NODE_ENV: 'production' }, max_memory_restart: '600M' },
    // Exactly ONE listener instance (authoritative reorg cursor).
    { name: 'cg-listener', cwd: '${APP_DIR}/backend', script: 'dist/blockchain/listener.js',
      instances: 1, env: { NODE_ENV: 'production' }, max_memory_restart: '600M' },
    // TRC20 (Tron) listener — also exactly ONE instance (it advances the TRC20
    // chain_cursor and promotes payments; two would double-poll TronGrid and
    // burn the API rate limit for no benefit).
    //
    // Safe to run unconditionally: with TRON_ENABLED=false it logs one line and
    // idles without polling or constructing a Tron client. That way enabling
    // TRC20 later is an .env edit + restart, not a redeploy.
    { name: 'cg-listener-tron', cwd: '${APP_DIR}/backend', script: 'dist/blockchain/tronListener.js',
      instances: 1, env: { NODE_ENV: 'production' }, max_memory_restart: '600M' },
  ],
};
EOF

# startOrRestart, not start: on a re-deploy `pm2 start` treats already-running
# apps as an error and can skip NEW apps in the same file — which would silently
# leave cg-listener-tron down after an upgrade. startOrRestart starts what is
# missing and restarts what is already there.
pm2 startOrRestart "$APP_DIR/ecosystem.config.js" --update-env
pm2 save
sudo env PATH="$PATH" pm2 startup systemd -u "$RUN_USER" --hp "$RUN_HOME" >/dev/null 2>&1 || true
pm2 save
sleep 4
pm2 status

echo "Local API health check:"
curl -fsS "http://127.0.0.1:${API_PORT}/health" && echo "  API OK" || warn "API not up yet — pm2 logs cg-api"

###############################################################################
say "11/12  Apache2 vhosts (static SPA + /api/v1 reverse proxy)"
###############################################################################
sudo apt-get install -y apache2
sudo a2enmod proxy proxy_http headers rewrite ssl http2 >/dev/null

make_vhost() {
  local domain="$1" docroot="$2" tag="$3"
  sudo tee "/etc/apache2/sites-available/${tag}.conf" >/dev/null <<EOF
<VirtualHost *:80>
    ServerName ${domain}
    DocumentRoot ${docroot}

    <Directory ${docroot}>
        Options -Indexes +FollowSymLinks
        AllowOverride None
        Require all granted
        FallbackResource /index.html
    </Directory>

    ProxyPreserveHost On
    ProxyRequests Off

    # REST API -> gateway API on 127.0.0.1:${API_PORT}
    ProxyPass        /api/v1  http://127.0.0.1:${API_PORT}/api/v1
    ProxyPassReverse /api/v1  http://127.0.0.1:${API_PORT}/api/v1
    ProxyPass        /health  http://127.0.0.1:${API_PORT}/health
    ProxyPassReverse /health  http://127.0.0.1:${API_PORT}/health

    ErrorLog  \${APACHE_LOG_DIR}/${tag}_error.log
    CustomLog \${APACHE_LOG_DIR}/${tag}_access.log combined
</VirtualHost>
EOF
  sudo a2ensite "${tag}.conf" >/dev/null
}

make_vhost "$CLIENT_DOMAIN" "$APP_DIR/client-panel/dist" "cg-client"
make_vhost "$ADMIN_DOMAIN"  "$APP_DIR/admin-panel/dist"  "cg-admin"

# Dedicated API host — pure reverse proxy to the gateway API (no static files).
sudo tee "/etc/apache2/sites-available/cg-api.conf" >/dev/null <<EOF
<VirtualHost *:80>
    ServerName ${API_DOMAIN}

    ProxyPreserveHost On
    ProxyRequests Off

    # Everything on this host is the API (REST under /api/v1, plus /health, /docs).
    ProxyPass        /  http://127.0.0.1:${API_PORT}/
    ProxyPassReverse /  http://127.0.0.1:${API_PORT}/

    ErrorLog  \${APACHE_LOG_DIR}/cg-api_error.log
    CustomLog \${APACHE_LOG_DIR}/cg-api_access.log combined
</VirtualHost>
EOF
sudo a2ensite "cg-api.conf" >/dev/null

sudo apache2ctl configtest
sudo systemctl reload apache2

# Firewall: make sure HTTP/HTTPS are open (harmless if already allowed).
if command -v ufw >/dev/null; then sudo ufw allow 80/tcp >/dev/null 2>&1 || true; sudo ufw allow 443/tcp >/dev/null 2>&1 || true; fi

###############################################################################
say "12/12  HTTPS certificates (Let's Encrypt, one cert covering both domains)"
###############################################################################
sudo apt-get install -y certbot python3-certbot-apache
if sudo certbot --apache -d "${CLIENT_DOMAIN}" -d "${ADMIN_DOMAIN}" -d "${API_DOMAIN}" \
      -m "${LE_EMAIL}" --agree-tos --non-interactive --redirect; then
  echo "HTTPS is live for all three domains."
else
  warn "Certbot failed — usually DNS for one of the domains isn't pointing at this"
  warn "server yet. The sites work over HTTP for now. Re-run once DNS is ready:"
  echo  "     sudo certbot --apache -d ${CLIENT_DOMAIN} -d ${ADMIN_DOMAIN} -d ${API_DOMAIN} -m ${LE_EMAIL} --agree-tos --redirect"
fi

###############################################################################
cat <<EOF

┌───────────────────────────────────────────────────────────────────────────┐
  ✅ Crypto Payment Gateway deployed (coexisting with your other apps).

  Merchant / client panel : https://${CLIENT_DOMAIN}
  Admin panel             : https://${ADMIN_DOMAIN}
  API (dedicated host)    : https://${API_DOMAIN}/api/v1   (health: https://${API_DOMAIN}/health)

  First admin login (CHANGE THE PASSWORD after first login):
    ${ADMIN_EMAIL}  /  ${ADMIN_PASSWORD}

  Isolation from your existing software:
    • Postgres DB/role : ${PG_DB} / ${PG_ROLE}   (its own DB — Zaplo untouched)
    • Redis logical DB : #${REDIS_DB}                    (others use #0)
    • API host port    : ${API_PORT}                 (Zaplo keeps 4000)
    • PM2 processes    : cg-api, cg-worker, cg-listener, cg-listener-tron

  Networks:
    • BEP20 (BSC)  : ALWAYS ON — the default for any payment created without
                     an explicit "network". Nothing about it changed.
    • TRC20 (Tron) : $(grep -qE '^TRON_ENABLED=true' "$ENV_FILE" && echo 'ENABLED' || echo 'off (TRON_ENABLED=false)')
                     cg-listener-tron is installed either way; while off it
                     idles and the API rejects network=TRC20.
                     To enable: docs/deployment.md §7b, then edit ${ENV_FILE}
                     and run: pm2 restart cg-api cg-worker cg-listener-tron

  Secrets + wallet keys live in:  ${ENV_FILE}   (chmod 600)
    ⚠  Back up HD_WALLET_MNEMONIC OFFLINE — losing it loses all deposit funds.
       The SAME mnemonic derives both BEP20 and TRC20 deposit addresses.
    ⚠  Keep the gas-station wallet funded with BNB or sweeps/payouts stall.
    ⚠  If TRC20 is on, keep the Tron wallet funded with TRX too — a TRC20
       transfer burns ~13-30 TRX without staked energy. Out of TRX = every
       TRC20 sweep and payout fails. Watch it in Admin -> Wallet Balances.

  Manage:
    pm2 status
    pm2 logs cg-api             # API
    pm2 logs cg-worker          # confirm / sweep / payout / webhook jobs
    pm2 logs cg-listener        # BSC chain listener (run ONLY one)
    pm2 logs cg-listener-tron   # Tron chain listener (run ONLY one)
    pm2 restart cg-api cg-worker cg-listener cg-listener-tron
    sudo tail -f /var/log/apache2/cg-client_error.log

  Redeploy after pushing new commits to ${REPO_URL}:
    cd ${APP_DIR} && ./deploy-crypto-gateway.sh    # pulls latest, rebuilds, restarts
└───────────────────────────────────────────────────────────────────────────┘
EOF
