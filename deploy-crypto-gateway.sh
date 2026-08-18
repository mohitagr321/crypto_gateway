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
#   • Runs api + worker + ALL FOUR chain listeners under PM2 (cg-* names):
#     BSC, Ethereum, Tron, Bitcoin. Every listener idles while its chain is
#     off, so the process set never has to change when a chain is enabled.
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
#   3. The super_admin password is NOT in this file. On the run that creates the
#      account the script mints a random one and prints it ONCE, at the end.
#      To choose it yourself, export it out-of-band before running:
#        export ADMIN_PASSWORD='...'      # never write it into this file
#      (Same for the address: export ADMIN_EMAIL='ops@yourco.tld'.)
#
# Run as a NORMAL sudo-capable user (NOT via `sudo`). Root is also fine.
###############################################################################
set -euo pipefail

# ─────────────────────────── EDIT THESE VALUES ──────────────────────────────
CLIENT_DOMAIN="pay.paycrypo.com"       # merchant panel + hosted checkout (/pay/:token)
ADMIN_DOMAIN="admin.paycrypo.com"      # admin console
API_DOMAIN="api.paycrypo.com"          # the hostname merchants call
LE_EMAIL="namit@ezulix.com"             # Let's Encrypt contact

# First-login admin (idempotent — only created if it doesn't exist yet).
#
# THE PASSWORD IS NOT HERE, AND MUST NEVER BE PUT HERE. This file is tracked in
# the repo (unlike the .env it writes) and it already names the live hosts, so a
# literal password in it is published. And this is not an ordinary account: a
# super_admin can repoint any merchant's payout_wallet and then settle that
# merchant's balance to it, and can broadcast a commission withdrawal from the
# central wallet to an address it supplies. A literal used to sit on this line,
# which made it a published key to other people's money — and it is NOT quoted
# here, because repeating it in a comment publishes it just as thoroughly as
# assigning it did. Treat that old value as BURNED: it is still in this repo's
# git history, and removing it from this file changes no password that was
# already set. Rotate the live super_admin by hand, then review audit_logs for
# payout.*, client.update and commission-withdraw rows.
# The password is now supplied out-of-band (export ADMIN_PASSWORD=...) or
# generated in step 8, and it is printed exactly once — on the run that creates
# the account, never again on a re-deploy.
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@ezulix.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
ADMIN_CREATED=false      # set true in step 8 only if the seed really created it
ADMIN_SEED_FAILED=false  # set true in step 8 if the seed ran and did not succeed
# ────────────────────────────────────────────────────────────────────────────

# Fixed settings (change only if you know why)
REPO_URL="https://github.com/mohitagr321/crypto_gateway.git"
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
# Checked here, not at step 8, so a bad value fails in the first seconds rather
# than after a ten-minute build. Empty is fine — step 8 generates a strong one.
if [ -n "$ADMIN_PASSWORD" ] && [ "${#ADMIN_PASSWORD}" -lt 12 ]; then
  die "ADMIN_PASSWORD is set but is under 12 characters. This account can repoint merchant payout wallets and withdraw commission to an arbitrary address — give it a long random value, or unset ADMIN_PASSWORD and let this script generate one."
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
  # Builds every verification / password-reset link in outbound email. Without
  # it the default is http://localhost:5174, so every merchant who signs up gets
  # a dead link pointing at their own machine — silently, with no error anywhere.
  set_env PUBLIC_PANEL_URL "https://${CLIENT_DOMAIN}"                "$ENV_FILE"
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
  # Builds every verification / password-reset link in outbound email. Without
  # it the default is http://localhost:5174, so every merchant who signs up gets
  # a dead link pointing at their own machine — silently, with no error anywhere.
  set_env PUBLIC_PANEL_URL "https://${CLIENT_DOMAIN}"                "$ENV_FILE"
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

# ── Seed the super_admin ─────────────────────────────────────────────────────
# The seed is idempotent: it creates the account or reports that it exists, and
# it NEVER changes an existing account's password. That is why we ask the DB
# first. A re-deploy must not print a password — the one it would print is not
# the one the account has, and a credential echoed on every deploy ends up in
# every terminal scrollback and CI log on the way to production.
#
# psql has already proven itself above (the migration loop dies on failure), so
# this lookup should always answer — but "should" is not good enough when the
# answer decides whether we print a credential, so its failure is handled
# explicitly below rather than being treated as "no such user".
echo "Seeding super_admin (idempotent) ..."
ADMIN_LOOKUP_OK=true
ADMIN_EXISTS="$(PGPASSWORD="$PG_PW" psql -h localhost -U "$PG_ROLE" -d "$PG_DB" \
  -v em="$ADMIN_EMAIL" -tAc "SELECT 1 FROM users WHERE email = :'em'")" \
  || ADMIN_LOOKUP_OK=false

if [ "$ADMIN_LOOKUP_OK" != true ]; then
  # This lookup is the ONLY thing that tells us whether a password we print is
  # actually the account's. seed.js exits 0 whether it CREATED the user or found
  # one already there, so a lookup that failed and fell through to the "create"
  # branch would mint a password, watch the seed skip, and print that password
  # as the first admin login — the exact wrong-credential-in-the-banner problem
  # this block exists to remove, just quieter. A swallowed error is how that
  # happens, so the failure is no longer swallowed (psql's own message is left
  # on stderr) and we neither seed nor issue anything when we cannot ask.
  ADMIN_PASSWORD=""
  ADMIN_SEED_FAILED=true
  warn "Could not ask the database whether ${ADMIN_EMAIL} exists (see the psql error above) — the admin seed was SKIPPED and no credentials were issued. Fix the database and re-run; the seed is idempotent."
elif [ -n "$ADMIN_EXISTS" ]; then
  echo "  super_admin ${ADMIN_EMAIL} already exists — password left untouched."
  [ -n "$ADMIN_PASSWORD" ] && \
    warn "ADMIN_PASSWORD was set but IGNORED: the seed never rewrites an existing account's password."
else
  if [ -n "$ADMIN_PASSWORD" ]; then
    echo "  Creating ${ADMIN_EMAIL} with the password from \$ADMIN_PASSWORD."
  else
    # 144 random bits. `openssl rand -hex` yields only [0-9a-f], so the fixed
    # tail guarantees an upper-case letter, a digit and a symbol — enough to
    # satisfy any policy the change-password screen imposes later. The tail adds
    # no entropy and is not meant to; the 36 hex characters carry all of it.
    ADMIN_PASSWORD="$(openssl rand -hex 18)-Aa9!"
    echo "  Creating ${ADMIN_EMAIL} with a generated password (printed once, at the end)."
  fi
  # Passed through the environment, never as argv — argv is world-readable in
  # `ps` on a shared box, the environment of a process is not.
  if SEED_ADMIN_EMAIL="$ADMIN_EMAIL" SEED_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
       node "$APP_DIR/backend/dist/seed.js"; then
    ADMIN_CREATED=true
  else
    # Non-fatal, as before: the rest of the deploy is still worth completing and
    # the seed is idempotent, so a re-run creates the admin once the DB is happy.
    # But no credentials are issued for an account that does not exist, and the
    # closing banner has to say that in as many words — an operator who is told
    # nothing here would reasonably assume the admin is simply the one from last
    # time, and only discover at the login screen that there is no admin at all.
    ADMIN_PASSWORD=""
    ADMIN_SEED_FAILED=true
    warn "Seed reported a problem — check output above. NO admin was created and no password was issued; fix the DB and re-run this script."
  fi
fi

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
say "10/12  Start api + worker + ALL FOUR listeners under PM2 (one instance each!)"
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
    // ERC20 (Ethereum) and BTC listeners. These were MISSING, and their absence
    // was a silent way to lose customer money: ETH_ENABLED / BTC_ENABLED are a
    // pure .env edit, isNetworkEnabled() then lets createPayment derive and
    // persist a REAL deposit address on that chain, and the customer pays into
    // an address no process on this box is watching. The deposit is never
    // recorded, never confirmed, never swept — it just sits at an HD address
    // nobody is looking at. Both entrypoints already exist in the build and
    // both idle exactly like cg-listener-tron while their chain is off
    // (ethListener.ts / bitcoinListener.ts), so there was never a reason to
    // omit them. One instance each, for the same cursor reason as above.
    { name: 'cg-listener-eth', cwd: '${APP_DIR}/backend', script: 'dist/blockchain/ethListener.js',
      instances: 1, env: { NODE_ENV: 'production' }, max_memory_restart: '600M' },
    { name: 'cg-listener-btc', cwd: '${APP_DIR}/backend', script: 'dist/blockchain/bitcoinListener.js',
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
# The ONLY place the admin password is ever printed, and only on the run that
# actually created the account. Built before the banner heredoc so the "already
# exists" case can say so in words instead of echoing a password that is not the
# account's — see the seeding block in step 8.
if [ "$ADMIN_CREATED" = true ]; then
  ADMIN_BANNER="  ⚠  FIRST ADMIN LOGIN — SHOWN ONCE. It is not stored anywhere and cannot be
     reprinted. Copy it into your password manager NOW, then change it at
     first login.

       ${ADMIN_EMAIL}
       ${ADMIN_PASSWORD}"
elif [ "$ADMIN_SEED_FAILED" = true ]; then
  # Covers both ways step 8 can decline to issue credentials: the seed ran and
  # failed, or the DB could not be asked at all. Deliberately does not claim
  # which — in the second case an admin may well exist from an earlier run, and
  # the honest statement is that THIS run learnt nothing and gave you nothing.
  ADMIN_BANNER="  ⚠  NO ADMIN CREDENTIALS WERE ISSUED. The seed did not complete (see step 8
     above), so this run neither created an account nor learnt the password of
     an existing one — do not assume you can log in to the admin panel.
     Fix the database error and re-run this script; the seed is idempotent."
else
  ADMIN_BANNER="  Admin login : ${ADMIN_EMAIL}
                (existing account — its password was NOT changed and is not
                 shown. Lost it? Use the admin panel's forgot-password flow if
                 SMTP is configured, or re-run this script with
                 ADMIN_EMAIL=you@yourco.tld to seed a second super_admin.)"
fi

cat <<EOF

┌───────────────────────────────────────────────────────────────────────────┐
  ✅ Crypto Payment Gateway deployed (coexisting with your other apps).

  Merchant / client panel : https://${CLIENT_DOMAIN}
  Admin panel             : https://${ADMIN_DOMAIN}
  API (dedicated host)    : https://${API_DOMAIN}/api/v1   (health: https://${API_DOMAIN}/health)

${ADMIN_BANNER}

  Isolation from your existing software:
    • Postgres DB/role : ${PG_DB} / ${PG_ROLE}   (its own DB — Zaplo untouched)
    • Redis logical DB : #${REDIS_DB}                    (others use #0)
    • API host port    : ${API_PORT}                 (Zaplo keeps 4000)
    • PM2 processes    : cg-api, cg-worker, cg-listener, cg-listener-tron,
                         cg-listener-eth, cg-listener-btc

  Networks — every chain below has its own listener process installed, so a
  chain can never be switched on with nothing watching it:
    • BEP20 (BSC)  : ALWAYS ON — the default for any payment created without
                     an explicit "network". Nothing about it changed.
    • TRC20 (Tron) : $(grep -qE '^TRON_ENABLED=true' "$ENV_FILE" && echo 'ENABLED' || echo 'off (TRON_ENABLED=false)')
                     cg-listener-tron is installed either way; while off it
                     idles and the API rejects network=TRC20.
                     To enable: docs/deployment.md §7b, then edit ${ENV_FILE}
                     and run: pm2 restart cg-api cg-worker cg-listener-tron
    • ERC20 (Eth)  : $(grep -qE '^ETH_ENABLED=true' "$ENV_FILE" && echo 'ENABLED' || echo 'off (ETH_ENABLED not true)')
                     Needs ETH_ENABLED=true AND ETH_HTTP_RPC — the API refuses
                     network=ERC20 unless both are set. Then:
                     pm2 restart cg-api cg-worker cg-listener-eth
    • BTC          : $(grep -qE '^BTC_ENABLED=true' "$ENV_FILE" && echo 'ENABLED' || echo 'off (BTC_ENABLED not true)')
                     Needs BTC_ENABLED=true. Then:
                     pm2 restart cg-api cg-worker cg-listener-btc

  Secrets + wallet keys live in:  ${ENV_FILE}   (chmod 600)
    ⚠  Back up HD_WALLET_MNEMONIC OFFLINE — losing it loses all deposit funds.
       The SAME mnemonic derives BEP20, ERC20, TRC20 and BTC deposit addresses.
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
    pm2 logs cg-listener-eth    # Ethereum chain listener (run ONLY one)
    pm2 logs cg-listener-btc    # Bitcoin chain listener (run ONLY one)
    pm2 restart cg-api cg-worker cg-listener cg-listener-tron cg-listener-eth cg-listener-btc
    sudo tail -f /var/log/apache2/cg-client_error.log

  Redeploy after pushing new commits to ${REPO_URL}:
    cd ${APP_DIR} && ./deploy-crypto-gateway.sh    # pulls latest, rebuilds, restarts
└───────────────────────────────────────────────────────────────────────────┘
EOF
