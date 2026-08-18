#!/usr/bin/env bash
# PayCrypo — fresh Ubuntu 24.04 deploy. Idempotent: safe to re-run.
#
#   1. put your secrets in ~/crypto-gateway.env   (see REQUIRED below)
#   2. point pay./admin./api.paycrypo.com at this box and let DNS settle
#   3. bash deploy-simple.sh
set -euo pipefail

CLIENT_DOMAIN="paycrypo.com"           # merchant panel + hosted checkout (apex)
ADMIN_DOMAIN="admin.paycrypo.com"
API_DOMAIN="api.paycrypo.com"
REPO="https://github.com/mohitagr321/crypto_gateway.git"
APP=/var/www/crypto-gateway
SRC_ENV="${SOURCE_ENV:-$HOME/crypto-gateway.env}"
PG_DB=gateway; PG_USER=gateway; API_PORT=4000
LE_EMAIL="${LE_EMAIL:-admin@paycrypo.com}"

say(){ printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

# REQUIRED in $SRC_ENV. Refuses to invent a mnemonic — losing it loses every
# deposit, so it must be a value you generated and backed up offline.
# Running the whole script as root is what breaks this deploy: $HOME becomes
# /root, .env is written root:root 600, and PM2 then runs as ubuntu and cannot
# read a single variable — the app restart-loops reporting every var Required.
# sudo is called where it is actually needed, and nowhere else.
[ "$(id -u)" -ne 0 ] || die "Do not run this with sudo. Run it as your normal user: bash $(basename "$0")"

[ -f "$SRC_ENV" ] || die "Missing $SRC_ENV. It must contain HD_WALLET_MNEMONIC, CENTRAL_WALLET_ADDRESS, GAS_STATION_PRIVATE_KEY."
grep -q '^HD_WALLET_MNEMONIC=' "$SRC_ENV" || die "$SRC_ENV has no HD_WALLET_MNEMONIC."
sudo -n true 2>/dev/null || die "passwordless sudo is not working — fix that first (see /etc/sudoers.d/90-cloud-init-users)."

say "1/9  Packages"
sudo apt-get update -y
sudo apt-get install -y git curl ca-certificates gnupg build-essential rsync \
  postgresql postgresql-contrib redis-server apache2 certbot python3-certbot-apache

say "2/9  Node >= 20 + PM2"
node_major(){ command -v node >/dev/null && node -v | cut -d. -f1 | tr -d v || echo 0; }
if [ "$(node_major)" -lt 20 ]; then
  # Ubuntu's own nodejs first — on 26.04 it is already >= 20, and NodeSource does
  # not publish for every release the moment it ships. Falling straight to their
  # setup script on an unsupported codename adds a broken apt source and then
  # fails, which is a worse state than not having tried.
  sudo apt-get install -y nodejs npm || true
  if [ "$(node_major)" -lt 20 ]; then
    sudo apt-get remove -y nodejs npm || true
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - || \
      die "Could not install Node 20 from Ubuntu or NodeSource. Install it by hand, then re-run."
    sudo apt-get install -y nodejs
  fi
fi
[ "$(node_major)" -ge 20 ] || die "Node is $(node -v) — the backend requires >= 20."
command -v pm2 >/dev/null || sudo npm install -g pm2
node -v

say "3/9  Postgres role + database"
sudo systemctl enable --now postgresql
PG_PW="$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$PG_USER'" | grep -q 1 && echo KEEP || openssl rand -hex 24)"
if [ "$PG_PW" = KEEP ]; then
  echo "role $PG_USER exists — reusing it and its password from $APP/.env"
  PG_PW="$(sudo grep -oP '(?<=postgres://'"$PG_USER"':)[^@]+' "$APP/.env" 2>/dev/null || true)"
  [ -n "$PG_PW" ] || die "role exists but no password recoverable from $APP/.env — set it by hand."
else
  sudo -u postgres psql -c "CREATE ROLE $PG_USER LOGIN PASSWORD '$PG_PW';"
fi
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$PG_DB'" | grep -q 1 \
  || sudo -u postgres createdb -O "$PG_USER" "$PG_DB"
sudo -u postgres psql -d "$PG_DB" -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext;'

say "4/9  Redis"
sudo systemctl enable --now redis-server

say "5/9  Code"
sudo mkdir -p "$APP"; sudo chown -R "$USER":"$USER" "$APP"
if [ -d "$APP/.git" ]; then git -C "$APP" fetch --all -q && git -C "$APP" reset --hard origin/master -q
else git clone -q "$REPO" "$APP"; fi

say "6/9  .env"
ENV="$APP/.env"
if [ ! -f "$ENV" ]; then install -m600 "$SRC_ENV" "$ENV"; fi
set_env(){ grep -q "^$1=" "$ENV" && sed -i "s|^$1=.*|$1=$2|" "$ENV" || echo "$1=$2" >> "$ENV"; }
set_env NODE_ENV production
set_env PORT "$API_PORT"
set_env DATABASE_URL "postgres://$PG_USER:$PG_PW@localhost:5432/$PG_DB"
set_env REDIS_URL "redis://localhost:6379/0"
# Builds every verification / password-reset link in outbound email. Without it
# the default is http://localhost:5174 and every signup gets a dead link.
set_env PUBLIC_PANEL_URL "https://$CLIENT_DOMAIN"
grep -q '^JWT_SECRET=.\{16,\}' "$ENV" || set_env JWT_SECRET "$(openssl rand -hex 32)"
grep -qE '^MASTER_ENCRYPTION_KEY=[0-9a-fA-F]{64}$' "$ENV" || set_env MASTER_ENCRYPTION_KEY "$(openssl rand -hex 32)"
chown "$USER":"$USER" "$ENV" 2>/dev/null || sudo chown "$USER":"$USER" "$ENV"
chmod 600 "$ENV"

# Verify the env actually landed and is readable BY THIS USER before spending
# five minutes building against it. The failure this catches is silent: the app
# boots, dotenv finds nothing, and every var reports "Required" as though the
# file had never been written.
[ -r "$ENV" ] || die "$ENV is not readable by $USER — check ownership."
missing=""
for v in DATABASE_URL REDIS_URL JWT_SECRET MASTER_ENCRYPTION_KEY BSC_HTTP_RPC \
         USDT_CONTRACT HD_WALLET_MNEMONIC CENTRAL_WALLET_ADDRESS; do
  grep -q "^$v=." "$ENV" || missing="$missing $v"
done
[ -z "$missing" ] || die "$ENV is missing required values:$missing
Add them to $SRC_ENV and re-run."
echo "env ok — all required values present and readable by $USER"

say "7/9  Migrations (every file, in order — order matters)"
export PGPASSWORD="$PG_PW"
psql -h localhost -U "$PG_USER" -d "$PG_DB" -tAc "SELECT to_regclass('payments')" | grep -q payments \
  || psql -h localhost -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -q -f "$APP/sql/schema.sql"
for m in "$APP"/sql/migrations/*.sql; do
  case "$m" in *_rollback.sql) continue;; esac
  printf '  %-46s' "$(basename "$m")"
  psql -h localhost -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -q -f "$m" >/dev/null 2>&1 \
    && echo ok || { echo FAILED; die "migration $(basename "$m") failed"; }
done
unset PGPASSWORD

say "8/9  Build + PM2"
cd "$APP/backend" && npm ci --omit=dev --no-audit --no-fund && npm install --no-save typescript @types/node && npx tsc && npm prune --omit=dev
for p in client-panel admin-panel; do
  cd "$APP/$p" && npm ci --no-audit --no-fund
  VITE_API_BASE_URL="https://$API_DOMAIN/api/v1" npm run build
done
cd "$APP"
pm2 delete cg-api cg-worker cg-listener cg-listener-tron cg-listener-eth cg-listener-btc >/dev/null 2>&1 || true
pm2 start "$APP/backend/dist/index.js" --name cg-api           --cwd "$APP/backend"
pm2 start "$APP/backend/dist/workers/index.js" --name cg-worker        --cwd "$APP/backend"
# ONE instance each — every listener is the sole writer of its own chain cursor.
pm2 start "$APP/backend/dist/blockchain/listener.js" --name cg-listener      --cwd "$APP/backend"
pm2 start "$APP/backend/dist/blockchain/tronListener.js" --name cg-listener-tron --cwd "$APP/backend"
pm2 start "$APP/backend/dist/blockchain/ethListener.js" --name cg-listener-eth  --cwd "$APP/backend"
pm2 start "$APP/backend/dist/blockchain/bitcoinListener.js" --name cg-listener-btc  --cwd "$APP/backend"
pm2 save; sudo env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null

say "9/9  Apache + TLS"
sudo a2enmod proxy proxy_http headers rewrite ssl >/dev/null
vhost(){ sudo tee "/etc/apache2/sites-available/$1.conf" >/dev/null <<EOF
<VirtualHost *:80>
  ServerName $1
  $2
</VirtualHost>
EOF
sudo a2ensite "$1" >/dev/null; }
vhost "$CLIENT_DOMAIN" "DocumentRoot $APP/client-panel/dist
  <Directory $APP/client-panel/dist>
    Require all granted
    FallbackResource /index.html
  </Directory>"
vhost "$ADMIN_DOMAIN" "DocumentRoot $APP/admin-panel/dist
  <Directory $APP/admin-panel/dist>
    Require all granted
    FallbackResource /index.html
  </Directory>"
# www -> apex. Not cosmetic: a visitor typing www.paycrypo.com otherwise gets
# Apache's default page, or a cert error once TLS is on.
vhost "www.$CLIENT_DOMAIN" "Redirect permanent / https://$CLIENT_DOMAIN/"
vhost "$API_DOMAIN" "ProxyPreserveHost On
  ProxyPass        / http://127.0.0.1:$API_PORT/
  ProxyPassReverse / http://127.0.0.1:$API_PORT/"
sudo apache2ctl configtest && sudo systemctl reload apache2
sudo certbot --apache --non-interactive --agree-tos -m "$LE_EMAIL" \
  -d "$CLIENT_DOMAIN" -d "www.$CLIENT_DOMAIN" -d "$ADMIN_DOMAIN" -d "$API_DOMAIN" || \
  echo "certbot failed — check DNS has propagated, then: sudo certbot --apache"

cat <<EOF

  Merchant + checkout   https://$CLIENT_DOMAIN
  Admin console         https://$ADMIN_DOMAIN
  API                   https://$API_DOMAIN/api/v1

  Seed the first admin (pick your own password, it is printed once):
    cd $APP/backend && node dist/scripts/seed-admin.js --email you@paycrypo.com --password '<strong>'

  Logs: pm2 logs      Status: pm2 status
EOF
