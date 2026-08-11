-- =============================================================================
-- Crypto Payment Gateway — PostgreSQL schema (USDT on BEP20 + TRC20)
-- Production-oriented. Run with: psql "$DATABASE_URL" -f sql/schema.sql
--
-- MULTI-NETWORK: every `network` column holds 'BEP20' (BSC) or 'TRC20' (Tron)
-- and defaults to 'BEP20'. An existing BEP20-only database reaches this shape via
-- sql/migrations/004_multi_network_trc20.sql — do NOT re-run this file over one.
--
-- THIS FILE IS THE FULLY-MIGRATED SHAPE. It must produce a database identical to
-- schema.sql + every sql/migrations/*.sql applied in order. When you add a
-- migration, fold it in here too, and check with:
--
--   pg -d a -q < sql/schema.sql
--   pg -d b -q < sql/schema.sql; for m in sql/migrations/[0-9]*[!k].sql; do pg -d b -q < "$m"; done
--   diff <(pg_dump --schema-only … -d a) <(pg_dump --schema-only … -d b)
--
-- Column ORDER matters to that diff: a migration's ADD COLUMN appends, so
-- columns a migration introduced belong at the END of their table here.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";      -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";         -- case-insensitive email

-- ---------- enums ------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE client_status     AS ENUM ('pending','approved','suspended','rejected');
  CREATE TYPE user_status       AS ENUM ('active','disabled');
  CREATE TYPE api_key_status    AS ENUM ('active','revoked');
  CREATE TYPE wallet_type       AS ENUM ('deposit','central','payout','gas');
  CREATE TYPE payment_status    AS ENUM ('waiting','confirming','confirmed','partial','failed','expired','swept');
  CREATE TYPE commission_type   AS ENUM ('percentage','fixed','tiered');
  CREATE TYPE fee_payer         AS ENUM ('client','admin');
  -- `unresolved` (migration 015): the broadcast threw, and we do not know
  -- whether the transaction reached the chain. It is a LIVE status — it holds
  -- the merchant's reservation exactly like `sent` — and it is terminal for
  -- automation. `failed` is a RELEASE, and releasing on "unknown" is how the
  -- same money got sent twice. Only a human, having checked the explorer, moves
  -- an unresolved row on.
  CREATE TYPE payout_status     AS ENUM ('pending','processing','sent','confirmed','failed','unresolved');
  CREATE TYPE payout_type       AS ENUM ('auto','manual');
  CREATE TYPE tx_direction      AS ENUM ('incoming','sweep','payout','gas_funding');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- roles ------------------------------------------------------------
CREATE TABLE roles (
  id           SERIAL PRIMARY KEY,
  name         TEXT UNIQUE NOT NULL,              -- super_admin | ops | merchant
  permissions  JSONB NOT NULL DEFAULT '[]',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO roles (name, permissions) VALUES
  ('super_admin', '["*"]'),
  ('ops',         '["clients:read","transactions:read","payouts:trigger","webhooks:read"]'),
  ('merchant',    '["self"]')
ON CONFLICT (name) DO NOTHING;

-- ---------- users (admins + merchant logins) ---------------------------------
CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          CITEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  role_id        INT NOT NULL REFERENCES roles(id),
  status         user_status NOT NULL DEFAULT 'active',
  -- Proven via an emailed token. Self-registered merchants start false; anything
  -- an operator provisions is created verified (there is no link to click).
  email_verified BOOLEAN NOT NULL DEFAULT false,
  mfa_enabled    BOOLEAN NOT NULL DEFAULT false,
  mfa_secret     TEXT,                            -- encrypted TOTP secret
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_role ON users(role_id);

COMMENT ON COLUMN users.email_verified IS
  'TRUE once the address has been proven via an emailed token. Accounts that '
  'predate migration 007 were backfilled TRUE — they were provisioned by an '
  'operator out of band and were never sent a verification link.';

-- ---------- user_tokens (email verification + password reset) ----------------
-- Single-use and expiring. Only the SHA-256 of the token is stored — the raw
-- value exists solely inside the emailed link, so a database read cannot be
-- replayed into an account takeover.
CREATE TABLE user_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('email_verify','password_reset')),
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_user_tokens_hash ON user_tokens(token_hash);
-- Issuing a fresh token invalidates the outstanding ones for that purpose.
CREATE INDEX idx_user_tokens_open
  ON user_tokens(user_id, purpose) WHERE used_at IS NULL;
CREATE INDEX idx_user_tokens_expiry ON user_tokens(expires_at);

COMMENT ON TABLE user_tokens IS
  'Single-use, expiring tokens for email verification and password reset. '
  'token_hash = sha256(raw token); the raw token is never persisted.';

-- ---------- clients (merchants) ----------------------------------------------
CREATE TABLE clients (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_name  TEXT NOT NULL,
  status         client_status NOT NULL DEFAULT 'pending',
  webhook_url    TEXT,
  webhook_secret TEXT,                            -- per-client HMAC secret (encrypted)
  payout_wallet  TEXT,                            -- BEP20 (0x…) address for settlements
  payout_wallet_trc20 TEXT,                       -- TRC20 (T…) address; NULL = TRC20 payouts not enabled
  -- ENFORCED in middleware/auth.ts: when non-empty, an API request whose source
  -- IP is not listed is rejected. Empty = no IP restriction.
  ip_whitelist   TEXT[] NOT NULL DEFAULT '{}',
  -- Asset this merchant prefers to receive; NULL = settle in kind.
  preferred_payout_asset TEXT,
  -- Opt-in. FALSE = a wrong-asset deposit is recovered and left for the merchant
  -- to decide about; converting without consent realises a price and a fee on
  -- their behalf.
  auto_convert_unexpected BOOLEAN NOT NULL DEFAULT false,
  max_slippage_bps INT NOT NULL DEFAULT 100
                     CHECK (max_slippage_bps BETWEEN 1 AND 5000),
  -- 'self' = registered through the public panel; 'admin' = POST /admin/clients.
  signup_source  TEXT NOT NULL DEFAULT 'admin'
                   CHECK (signup_source IN ('admin','self')),
  website_url    TEXT,
  country        TEXT,
  -- Set once payout wallet + API key + webhook URL all exist; hides the
  -- get-started checklist.
  onboarding_completed_at TIMESTAMPTZ,
  approved_by    UUID REFERENCES users(id),       -- NULL when self-approved by email verification
  approved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Added by migration 011, so it belongs last (see the file header).
  -- UI default when pricing in fiat. Every payment and invoice stores its OWN
  -- currency, so changing this cannot restate anything already issued.
  default_fiat_currency TEXT,
  -- Added by migration 013. Separate from payout_wallet even though both are 0x
  -- addresses: a merchant may settle Ethereum somewhere other than BSC, and
  -- reusing the BEP20 wallet would send funds to an address never nominated for
  -- this chain.
  payout_wallet_erc20 TEXT,
  -- Added by migration 014. Bitcoin addresses share no format with any other
  -- chain here, so there is no cross-chain reuse hazard — it is separate for the
  -- same reason as the others: settlement destinations are per chain.
  payout_wallet_btc TEXT,
  -- Same rule as the inline CHECK above, under the name migration 010 gives it.
  -- Both exist on a migrated database, so both must exist here; neither is
  -- redundant to drop unilaterally without also amending 010.
  CONSTRAINT clients_slippage_check CHECK (max_slippage_bps BETWEEN 1 AND 5000)
);
CREATE INDEX idx_clients_status ON clients(status);
CREATE INDEX idx_clients_user   ON clients(user_id);
CREATE INDEX idx_clients_signup_source ON clients(signup_source);

COMMENT ON COLUMN clients.payout_wallet IS
  'BEP20 (0x…) settlement address. See payout_wallet_trc20 for Tron.';
COMMENT ON COLUMN clients.payout_wallet_trc20 IS
  'TRC20 (base58 T…) settlement address. NULL = merchant has not enabled TRC20 payouts.';
COMMENT ON COLUMN clients.preferred_payout_asset IS
  'Asset this merchant prefers to receive. NULL = settle each payment in the '
  'asset it arrived as. Drives conversion of unexpected deposits.';
COMMENT ON COLUMN clients.payout_wallet_erc20 IS
  'Ethereum (0x…) settlement address. NULL = ERC20 payouts not enabled. '
  'Separate from payout_wallet even though both are 0x addresses: a merchant '
  'may settle Ethereum somewhere other than BSC, and reusing the BEP20 wallet '
  'would send funds to an address never nominated for this chain.';
COMMENT ON COLUMN clients.payout_wallet_btc IS
  'Bitcoin settlement address (bech32 bc1…/tb1…, or legacy). NULL = BTC payouts '
  'not enabled.';
COMMENT ON COLUMN clients.default_fiat_currency IS
  'UI default only. Every payment and invoice stores its own currency, so '
  'changing this cannot restate an existing document.';
COMMENT ON COLUMN clients.auto_convert_unexpected IS
  'Opt-in. FALSE means a wrong-asset deposit is recovered to the central wallet '
  'and left for the merchant to decide about. Converting without consent '
  'realises a price and a fee on their behalf.';
COMMENT ON COLUMN clients.max_slippage_bps IS
  'Ceiling on swap slippage, in basis points (100 = 1%). A swap quoted worse '
  'than this is abandoned rather than executed.';
COMMENT ON COLUMN clients.signup_source IS
  '''self'' = merchant registered themselves through the public panel; '
  '''admin'' = provisioned via POST /admin/clients. Pre-existing rows are admin.';
COMMENT ON COLUMN clients.onboarding_completed_at IS
  'Set once the merchant has a payout wallet, an API key and a webhook URL. '
  'Drives whether the get-started checklist is still shown.';

-- ---------- api_keys ---------------------------------------------------------
-- A client may hold several active keys. Two auth modes coexist:
--   'hmac'   — api_key is a public id (pk_live_…); requests carry X-Timestamp +
--              X-Signature and api_secret_hash holds the ENVELOPE-ENCRYPTED raw
--              secret (see middleware/auth.ts for why it is not a bcrypt hash).
--   'simple' — api_key is a masked display prefix (ak_live_…); the value the
--              merchant sends in X-Api-Key IS the secret, and only its SHA-256
--              is stored in token_hash. Nothing needs to read it back, so it is
--              hashed rather than encrypted.
CREATE TABLE api_keys (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  api_key        TEXT UNIQUE NOT NULL,            -- public id / display prefix
  api_secret_hash TEXT,                           -- hmac mode only; secret shown once
  token_hash     TEXT,                            -- simple mode only; sha256(bearer token)
  auth_mode      TEXT NOT NULL DEFAULT 'hmac'
                   CHECK (auth_mode IN ('hmac','simple')),
  -- What the key may do. Simple-mode keys are issued WITHOUT 'payouts:write' so
  -- a leaked bearer token cannot initiate a settlement.
  scopes         TEXT[] NOT NULL
                   DEFAULT ARRAY['payments:read','payments:write','payouts:write']::TEXT[],
  label          TEXT,
  status         api_key_status NOT NULL DEFAULT 'active',
  last_used_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ,
  -- Each mode must carry its own credential material.
  CONSTRAINT api_keys_mode_material_check CHECK (
    (auth_mode = 'hmac'   AND api_secret_hash IS NOT NULL) OR
    (auth_mode = 'simple' AND token_hash      IS NOT NULL)
  )
);
CREATE INDEX idx_api_keys_client ON api_keys(client_id);
CREATE INDEX idx_api_keys_key    ON api_keys(api_key) WHERE status = 'active';
CREATE UNIQUE INDEX idx_api_keys_token_hash
  ON api_keys(token_hash) WHERE token_hash IS NOT NULL;

COMMENT ON COLUMN api_keys.auth_mode IS
  '''hmac'' = signed requests (X-Timestamp + X-Signature). ''simple'' = the '
  'X-Api-Key header value is itself the bearer secret.';
COMMENT ON COLUMN api_keys.token_hash IS
  'sha256 of the simple-mode bearer token. NULL for hmac keys.';
COMMENT ON COLUMN api_keys.scopes IS
  'Permitted operations. Simple-mode keys are issued WITHOUT payouts:write so a '
  'leaked bearer token cannot initiate a settlement.';

-- ---------- wallets ----------------------------------------------------------
-- Deposit addresses are HD-derived (BIP-44). Private keys are NEVER stored raw:
-- derivation_index + master mnemonic (in KMS/env) reconstructs the key on demand.
CREATE TABLE wallets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID REFERENCES clients(id) ON DELETE SET NULL,
  address           TEXT UNIQUE NOT NULL,
  network           TEXT NOT NULL DEFAULT 'BEP20', -- BEP20 (0x…) | TRC20 (T…)
  type              wallet_type NOT NULL,
  derivation_index  BIGINT,                       -- for HD deposit wallets
  encrypted_privkey TEXT,                         -- only for hot central/gas wallets (envelope-encrypted)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Derivation indexes are drawn from ONE hd_counter across both networks, so an
-- index is never reused between chains and stays globally unique here.
CREATE UNIQUE INDEX idx_wallets_deriv ON wallets(derivation_index) WHERE type = 'deposit';
CREATE INDEX idx_wallets_type ON wallets(type);
CREATE INDEX idx_wallets_network ON wallets(network);

-- Monotonic counter for HD derivation indexes (avoids reuse / races).
-- Shared by BOTH networks: BEP20 derives at m/44'/60'/0'/0/<i> and TRC20 at
-- m/44'/195'/0'/0/<i>, so the same <i> yields two unrelated, disjoint keys.
CREATE TABLE hd_counter (
  id           INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  next_index   BIGINT NOT NULL DEFAULT 0
);
INSERT INTO hd_counter (id, next_index) VALUES (1, 0) ON CONFLICT DO NOTHING;

-- ---------- payment_links (hosted checkout) ----------------------------------
-- A shareable URL a merchant sends to a customer: open it, pick a coin, pay.
-- `token` is a CAPABILITY — it appears in URLs pasted into chats, so it grants
-- the ability to pay and nothing else. The public endpoints expose the business
-- name and amount, never the merchant's id, email, wallet or balance.
CREATE TABLE payment_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  token         TEXT UNIQUE NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  amount        NUMERIC(38,18),        -- NULL = customer enters the amount
  asset         TEXT,                  -- NULL = customer chooses
  network       TEXT,                  -- NULL = customer chooses
  reusable      BOOLEAN NOT NULL DEFAULT true,
  max_uses      INT,                   -- NULL = unlimited
  use_count     INT NOT NULL DEFAULT 0,
  expires_at    TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','disabled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Added by migration 011, so these belong last (see the file header).
  -- A fiat-priced link stores the FIAT price; the crypto amount is computed when
  -- the CUSTOMER starts a payment, so an invoice left unpaid for days settles at
  -- the price current when it is actually paid. Mutually exclusive with `amount`.
  fiat_currency TEXT,
  fiat_amount   NUMERIC(38,18),
  CONSTRAINT payment_links_amount_check   CHECK (amount IS NULL OR amount > 0),
  CONSTRAINT payment_links_max_uses_check CHECK (max_uses IS NULL OR max_uses > 0),
  CONSTRAINT payment_links_one_price_check CHECK (
    NOT (amount IS NOT NULL AND fiat_amount IS NOT NULL)
    AND (fiat_amount IS NULL OR (fiat_currency IS NOT NULL AND fiat_amount > 0))
  )
);
CREATE INDEX idx_payment_links_client ON payment_links(client_id, created_at DESC);
CREATE INDEX idx_payment_links_token_active ON payment_links(token) WHERE status = 'active';

COMMENT ON TABLE payment_links IS
  'Shareable hosted-checkout URLs. `token` is a capability: holding it allows '
  'paying, and nothing else — no merchant identity or balance is ever exposed.';
COMMENT ON COLUMN payment_links.amount IS
  'NULL = customer enters the amount. Never zero.';
COMMENT ON COLUMN payment_links.fiat_amount IS
  'Price in fiat. The crypto amount is computed when the CUSTOMER starts a '
  'payment, not when the link is created — so an invoice left unpaid for days '
  'is still settled at the price current when it is actually paid.';
COMMENT ON COLUMN payment_links.use_count IS
  'Incremented in the SAME transaction that creates a payment, under a row lock, '
  'so a single-use link cannot be spent twice by concurrent opens.';

-- ---------- payments ---------------------------------------------------------
CREATE TABLE payments (
  id                    TEXT PRIMARY KEY,          -- pay_<ulid>
  client_id             UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  order_id              TEXT NOT NULL,             -- merchant's reference
  description           TEXT,
  amount                NUMERIC(38,18) NOT NULL,   -- expected amount, in `asset`
  amount_received       NUMERIC(38,18) NOT NULL DEFAULT 0,
  currency              TEXT NOT NULL DEFAULT 'USDT',  -- kept in sync with `asset` (public API shape)
  -- Token symbol, scoped to `network`: (network, asset) identifies one entry in
  -- backend/src/blockchain/assets.ts. USDT-BEP20 and USDT-TRC20 are DIFFERENT
  -- assets — different contracts, different decimals (18 vs 6).
  asset                 TEXT NOT NULL DEFAULT 'USDT',
  network               TEXT NOT NULL DEFAULT 'BEP20'
                          CHECK (network IN ('BEP20','TRC20','ERC20','BTC')),
  deposit_address       TEXT NOT NULL,
  wallet_id             UUID NOT NULL REFERENCES wallets(id),
  status                payment_status NOT NULL DEFAULT 'waiting',
  confirmations         INT NOT NULL DEFAULT 0,
  required_confirmations INT NOT NULL DEFAULT 12,
  tx_hash               TEXT,
  expires_at            TIMESTAMPTZ NOT NULL,
  confirmed_at          TIMESTAMPTZ,
  -- Set when started from a hosted checkout link; NULL = created via the API.
  -- Also the authorisation for the PUBLIC status endpoint: only link-created
  -- payments are readable without credentials.
  payment_link_id       UUID REFERENCES payment_links(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ---- Locked fiat quote (NULL = priced directly in crypto) ----
  -- Added by migration 011, so these belong last (see the file header).
  -- Written ONCE at creation and never recomputed: a customer who opened a
  -- checkout for "₹5,000" owes the crypto amount quoted then, not whatever the
  -- market has done since. An audit record of a decision, not a cache.
  fiat_currency         TEXT,                      -- ISO-4217 the merchant priced in
  fiat_amount           NUMERIC(38,18),            -- what they asked for, in that currency
  fiat_rate             NUMERIC(38,18),            -- price of 1 `asset` in `fiat_currency`
  rate_source           TEXT,                      -- e.g. 'coingecko', 'coingecko:stale'
  rate_locked_at        TIMESTAMPTZ,               -- when the rate was FETCHED upstream
  UNIQUE (client_id, order_id),
  -- Fully priced in fiat or not at all: a half-populated quote cannot be audited.
  CONSTRAINT payments_fiat_complete_check CHECK (
    (fiat_currency IS NULL AND fiat_amount IS NULL AND fiat_rate IS NULL)
    OR
    (fiat_currency IS NOT NULL AND fiat_amount > 0 AND fiat_rate > 0)
  )
);
CREATE INDEX idx_payments_client   ON payments(client_id);
CREATE INDEX idx_payments_status   ON payments(status);
CREATE INDEX idx_payments_address  ON payments(deposit_address);
CREATE INDEX idx_payments_expires  ON payments(expires_at) WHERE status IN ('waiting','confirming');
-- The settle tick's late-deposit reaper reads the on-chain balance of deposit
-- addresses whose payment recently EXPIRED, so funds that arrive after expiry
-- stop being invisible. idx_payments_expires deliberately excludes `expired`,
-- and without this the reaper would walk every payment that ever expired, once
-- a minute, forever.
CREATE INDEX idx_payments_expired_recent
  ON payments(expires_at DESC) WHERE status = 'expired';
CREATE INDEX idx_payments_created  ON payments(created_at DESC);
-- Each per-network listener scans its own (network, status) slice.
CREATE INDEX idx_payments_network_status ON payments(network, status);
-- "Has this merchant ever taken a payment?" — the onboarding checklist.
CREATE INDEX idx_payments_client_created ON payments(client_id, created_at DESC);
-- Backs the per-asset balance guard, which runs inside the payout advisory lock.
CREATE INDEX idx_payments_client_network_asset_status
  ON payments(client_id, network, asset, status);
-- Keeps the balance read inside the payout advisory lock cheap (migration 005).
CREATE INDEX idx_payments_client_network_status
  ON payments(client_id, network, status);
CREATE INDEX idx_payments_link ON payments(payment_link_id)
  WHERE payment_link_id IS NOT NULL;

COMMENT ON COLUMN payments.asset IS
  'Token symbol, scoped to this row''s network: (network, asset) identifies one '
  'entry in blockchain/assets.ts. Fixed at creation and never changed.';
COMMENT ON COLUMN payments.payment_link_id IS
  'Set when the payment was started from a hosted checkout link. NULL means it '
  'was created through the API. Also the authorisation for the PUBLIC status '
  'endpoint: only link-created payments are readable without credentials.';
COMMENT ON COLUMN payments.fiat_rate IS
  'Price of one unit of `asset` in `fiat_currency`, frozen at creation. NEVER '
  'recomputed: the customer owes what they were quoted. An audit record, not a cache.';
COMMENT ON COLUMN payments.rate_source IS
  'Where the rate came from, including whether it was served stale. A stale '
  'quote is allowed by design but must never be silent.';

-- ---------- invoices ---------------------------------------------------------
-- Merchant invoices with line items, emailable, paid/unpaid tracked.
--
-- ONE CAPABILITY, NOT TWO: an invoice mints no public token of its own. It owns
-- a single-use payment_links row, and THAT token is the only thing the customer
-- holds — the same public surface and the same rate limiters as hosted checkout.
--
-- OVERDUE IS NOT A STATUS. It is derived from due_date at read time, so no job
-- has to age a row and no row can be stuck waiting for a clock.
CREATE TABLE invoices (
  id              TEXT PRIMARY KEY,                -- inv_<ulid>
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- Sequential WITHIN a merchant, so their books have no holes where another
  -- merchant's invoices went.
  number          TEXT NOT NULL,
  seq             BIGINT NOT NULL,
  customer_name   TEXT,
  customer_email  TEXT,
  currency        TEXT NOT NULL,                   -- fiat denomination of the document
  subtotal        NUMERIC(38,18) NOT NULL DEFAULT 0,
  tax_amount      NUMERIC(38,18) NOT NULL DEFAULT 0,
  total           NUMERIC(38,18) NOT NULL DEFAULT 0,
  notes           TEXT,
  due_date        DATE,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','open','paid','void')),
  payment_link_id UUID REFERENCES payment_links(id) ON DELETE SET NULL,
  payment_id      TEXT REFERENCES payments(id) ON DELETE SET NULL,
  asset           TEXT,                            -- NULL = customer chooses
  network         TEXT,
  -- Recurring provenance: set when minted by a subscription tick, not a human.
  subscription_id UUID,
  cycle_number    INT,
  issued_at       TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invoices_number_unique UNIQUE (client_id, seq),
  CONSTRAINT invoices_total_check CHECK (total >= 0),
  CONSTRAINT invoices_cycle_pairing_check CHECK (
    (subscription_id IS NULL AND cycle_number IS NULL)
    OR (subscription_id IS NOT NULL AND cycle_number IS NOT NULL)
  )
);
CREATE INDEX idx_invoices_client ON invoices(client_id, created_at DESC);
CREATE INDEX idx_invoices_status ON invoices(status) WHERE status = 'open';
CREATE INDEX idx_invoices_payment ON invoices(payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX idx_invoices_link ON invoices(payment_link_id) WHERE payment_link_id IS NOT NULL;

-- THE DOUBLE-BILL GUARD, and the load-bearing constraint of recurring billing.
-- The subscription tick is a repeatable job, and repeatable jobs fire twice: a
-- worker restarts mid-tick, two race, a retry replays. Without this, a replay
-- bills the same cycle again and the customer gets two demands for one month.
-- Correctness comes from the database, not from the worker being careful.
CREATE UNIQUE INDEX uq_invoices_subscription_cycle
  ON invoices(subscription_id, cycle_number)
  WHERE subscription_id IS NOT NULL;

COMMENT ON TABLE invoices IS
  'Merchant invoices with line items. The customer-facing capability is the '
  'token of the invoice''s single-use payment_links row — invoices mint no '
  'public token of their own.';
COMMENT ON COLUMN invoices.status IS
  'draft/open/paid/void. "Overdue" is DERIVED from due_date at read time, never '
  'stored — no job has to age a row into it.';

CREATE TABLE invoice_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  -- Fractional quantities are real (2.5 hours, 0.5 kg) — not an INT.
  quantity     NUMERIC(38,18) NOT NULL DEFAULT 1,
  unit_price   NUMERIC(38,18) NOT NULL DEFAULT 0,
  -- quantity * unit_price, STORED: a line's historical value must not move when
  -- arithmetic conventions change.
  amount       NUMERIC(38,18) NOT NULL DEFAULT 0,
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invoice_items_quantity_check CHECK (quantity > 0),
  CONSTRAINT invoice_items_unit_price_check CHECK (unit_price >= 0)
);
CREATE INDEX idx_invoice_items_invoice ON invoice_items(invoice_id, sort_order);

-- Per-merchant numbering. Incremented with UPDATE ... RETURNING inside the
-- creating transaction, which serialises concurrent creates on the row lock —
-- a global sequence would leak volume, and MAX(seq)+1 would race.
CREATE TABLE invoice_counters (
  client_id  UUID PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  next_seq   BIGINT NOT NULL DEFAULT 1
);

COMMENT ON TABLE invoice_counters IS
  'Per-merchant invoice numbering. Incremented with UPDATE ... RETURNING inside '
  'the creating transaction, which serialises concurrent creates on the row lock.';

-- ---------- subscriptions ----------------------------------------------------
-- Recurring plans: one invoice per cycle, minted by the subscription tick.
--
-- BILLING DATES DO NOT DRIFT — next_run_at advances by exactly one interval from
-- its own previous value, never from now(), so a worker outage does not move
-- every future billing date.
--
-- A BACKLOG IS PARKED, NOT FLUSHED — at most one invoice per subscription per
-- tick, and one that falls more than max_cycles_behind behind goes to
-- needs_attention instead of emptying a burst of invoices into an inbox.
CREATE TABLE subscriptions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  description      TEXT,
  customer_name    TEXT,
  customer_email   TEXT,
  -- Price per cycle. Fiat when `currency` is a fiat code; the rate is locked per
  -- INVOICE, so each cycle is quoted at its own date.
  currency         TEXT NOT NULL,
  amount           NUMERIC(38,18) NOT NULL CHECK (amount > 0),
  asset            TEXT,                           -- NULL = customer chooses
  network          TEXT,
  interval_unit    TEXT NOT NULL
                     CHECK (interval_unit IN ('day','week','month','year')),
  interval_count   INT NOT NULL DEFAULT 1
                     CHECK (interval_count BETWEEN 1 AND 366),
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','paused','canceled','needs_attention')),
  next_run_at      TIMESTAMPTZ NOT NULL,
  total_cycles     INT CHECK (total_cycles IS NULL OR total_cycles > 0),
  cycles_billed    INT NOT NULL DEFAULT 0,
  max_cycles_behind INT NOT NULL DEFAULT 3
                     CHECK (max_cycles_behind BETWEEN 1 AND 60),
  due_days         INT NOT NULL DEFAULT 7 CHECK (due_days BETWEEN 0 AND 365),
  auto_send        BOOLEAN NOT NULL DEFAULT true,
  last_invoice_id  TEXT REFERENCES invoices(id) ON DELETE SET NULL,
  last_run_at      TIMESTAMPTZ,
  canceled_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Auto-send with nowhere to send it silently does nothing every cycle.
  CONSTRAINT subscriptions_autosend_needs_email_check
    CHECK (auto_send = false OR customer_email IS NOT NULL)
);
CREATE INDEX idx_subscriptions_due ON subscriptions(next_run_at) WHERE status = 'active';
CREATE INDEX idx_subscriptions_client ON subscriptions(client_id, created_at DESC);

COMMENT ON TABLE subscriptions IS
  'Recurring billing plans. One invoice per cycle, minted by the subscription '
  'tick. next_run_at advances by one interval from its own value so billing '
  'dates never drift.';
COMMENT ON COLUMN subscriptions.next_run_at IS
  'Advanced by exactly one interval from its PREVIOUS value, never from now(), '
  'so a worker outage does not move every future billing date.';
COMMENT ON COLUMN subscriptions.max_cycles_behind IS
  'Beyond this many missed cycles the subscription parks in needs_attention '
  'rather than emitting a burst of invoices. Nothing is skipped silently.';

ALTER TABLE invoices ADD CONSTRAINT invoices_subscription_fkey
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE SET NULL;

-- ---------- blockchain_transactions ------------------------------------------
CREATE TABLE blockchain_transactions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id     TEXT REFERENCES payments(id) ON DELETE SET NULL,
  direction      tx_direction NOT NULL,
  tx_hash        TEXT NOT NULL,
  from_address   TEXT NOT NULL,
  to_address     TEXT NOT NULL,
  amount         NUMERIC(38,18) NOT NULL,
  token          TEXT NOT NULL DEFAULT 'USDT',   -- USDT | BNB (gas) | TRX (energy)
  asset          TEXT NOT NULL DEFAULT 'USDT',   -- which ledger asset this credits
  network        TEXT NOT NULL DEFAULT 'BEP20',
  block_number   BIGINT,
  confirmations  INT NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending|confirmed|reorged|failed
  log_index      INT,
  raw            JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX idx_btx_payment ON blockchain_transactions(payment_id);
CREATE INDEX idx_btx_to      ON blockchain_transactions(to_address);
CREATE INDEX idx_btx_block   ON blockchain_transactions(block_number);
CREATE INDEX idx_btx_network ON blockchain_transactions(network);
CREATE INDEX idx_btx_network_asset ON blockchain_transactions(network, asset);
-- The operator's commission position is `collected sweeps - client owed`, read
-- per (network, asset) on every admin dashboard load. This is the expensive leg:
-- idx_btx_network_asset does not cover the direction/status predicate.
CREATE INDEX idx_btx_sweep_network_asset
  ON blockchain_transactions(network, asset)
  WHERE direction = 'sweep' AND status = 'confirmed';

-- ---------- unexpected_deposits (wrong-asset recovery) -----------------------
-- A known asset that arrived at a deposit address expecting a DIFFERENT one.
-- NOT a balance and never summed into one: crediting it to the payment would
-- put the wrong asset into a withdrawable balance at 1:1.
CREATE TABLE unexpected_deposits (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  payment_id       TEXT REFERENCES payments(id) ON DELETE SET NULL,
  network          TEXT NOT NULL,
  asset            TEXT NOT NULL,          -- what actually arrived
  amount           NUMERIC(38,18) NOT NULL,
  expected_asset   TEXT,                   -- what the payment was waiting for
  deposit_address  TEXT NOT NULL,
  -- The HD index is what makes these recoverable at all (see recover.ts).
  derivation_index BIGINT,
  tx_hash          TEXT NOT NULL,
  log_index        INT NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'detected'
                     CHECK (status IN ('detected','sweeping','swept','converting','converted','failed')),
  sweep_tx_hash    TEXT,
  converted_to     TEXT,
  converted_amount NUMERIC(38,18),
  swap_tx_hash     TEXT,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One row per on-chain transfer, however often the WS path and the reconciler
  -- both see it.
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX idx_unexpected_client ON unexpected_deposits(client_id, created_at DESC);
CREATE INDEX idx_unexpected_status ON unexpected_deposits(status)
  WHERE status IN ('detected','sweeping','converting');

COMMENT ON TABLE unexpected_deposits IS
  'Known assets that arrived at a deposit address expecting a DIFFERENT asset. '
  'Not a balance and never summed into one — crediting these to the payment '
  'would put the wrong asset into a withdrawable balance at 1:1.';
COMMENT ON COLUMN unexpected_deposits.derivation_index IS
  'HD index of the receiving address. This is what makes the funds recoverable '
  'at all — the private key is derived from it (see backend/src/recover.ts).';

-- ---------- commissions (versioned; full audit trail) ------------------------
CREATE TABLE commissions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  type           commission_type NOT NULL,         -- percentage | fixed | tiered
  value          NUMERIC(38,18) NOT NULL,          -- percent (e.g. 1.5) or a fixed amount in `asset`; 0 when tiered
  -- Denomination of every AMOUNT in this row: the fixed `value`, and each tier's
  -- bounds and fixed value (migration 015). NULL only for a pure percentage
  -- rate, which genuinely has no denomination — 1% of a gross is 1% whatever the
  -- gross is in. Without this column the number was applied verbatim to whatever
  -- asset the payment arrived in, so a `fixed 1` meaning one dollar took one
  -- whole Bitcoin off a BTC settlement. computeSplit refuses to apply an
  -- amount-denominated commission to a settlement in a different asset; there is
  -- no price oracle here and reinterpreting the number is the bug.
  asset          TEXT,
  -- Chain this commission applies to. NULL = every chain. getActiveCommission
  -- picks the most specific active row: (network, asset), then network, then
  -- asset, then client-wide.
  network        TEXT,
  -- When type = 'tiered', this holds an ordered array of slabs, each:
  --   { "minAmount": "0", "maxAmount": "10", "type": "fixed", "value": "1" }
  --   { "minAmount": "10", "maxAmount": "1000", "type": "percentage", "value": "1" }
  --   { "minAmount": "1000", "maxAmount": null, "type": "percentage", "value": "0.5" }
  -- maxAmount = null means unbounded (must be the last slab).
  tiers          JSONB,
  network_fee_payer fee_payer NOT NULL DEFAULT 'client',
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- An amount-denominated commission must say what it is in. A bare number is
  -- what turned a one-dollar fee into one Bitcoin.
  CONSTRAINT chk_commissions_denomination
    CHECK (type = 'percentage' OR asset IS NOT NULL)
);
CREATE INDEX idx_commissions_client_active ON commissions(client_id) WHERE is_active;
-- getActiveCommission filters on (client_id, network, asset) among active rows.
CREATE INDEX idx_commissions_client_scope
  ON commissions(client_id, network, asset) WHERE is_active;

-- ---------- payouts / settlements --------------------------------------------
CREATE TABLE payouts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  payment_id     TEXT REFERENCES payments(id) ON DELETE SET NULL,
  gross_amount   NUMERIC(38,18) NOT NULL,
  commission_amount NUMERIC(38,18) NOT NULL DEFAULT 0,
  network_fee    NUMERIC(38,18) NOT NULL DEFAULT 0,
  net_amount     NUMERIC(38,18) NOT NULL,          -- what the client receives
  to_address     TEXT NOT NULL,
  network        TEXT NOT NULL DEFAULT 'BEP20',    -- chain this payout settles on
  asset          TEXT NOT NULL DEFAULT 'USDT',     -- asset settled; never crosses assets
  tx_hash        TEXT,
  status         payout_status NOT NULL DEFAULT 'pending',
  type           payout_type NOT NULL DEFAULT 'auto',
  triggered_by   UUID REFERENCES users(id),
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ---- Idempotency: what stops a retry from paying twice (migration 005) ----
  -- executePayout pins the transaction BEFORE broadcasting — pick the nonce,
  -- sign, store the bytes, then send. A throw does not mean the transfer
  -- failed (a dropped RPC connection and a confirmation timeout both throw), so
  -- a retry must re-broadcast these exact bytes rather than sign a new
  -- transfer. Even a re-sign cannot double-pay: the nonce is fixed and a chain
  -- mines at most one transaction per nonce.
  nonce          BIGINT,
  signed_tx      TEXT,
  broadcast_at   TIMESTAMPTZ
);
CREATE INDEX idx_payouts_client  ON payouts(client_id);
CREATE INDEX idx_payouts_client_network_asset_status
  ON payouts(client_id, network, asset, status);
-- Keeps the balance read inside the payout advisory lock cheap (migration 005).
CREATE INDEX idx_payouts_client_network_status
  ON payouts(client_id, network, status);
CREATE INDEX idx_payouts_status  ON payouts(status);
CREATE INDEX idx_payouts_network ON payouts(network);
CREATE INDEX idx_payouts_network_asset_status ON payouts(network, asset, status);

-- One live payout per payment, enforced by the database (migration 015).
--
-- The settle tick recreates a payout when it sees none in a live status. When a
-- broadcast payout was wrongly released as `failed`, that guard minted a SECOND
-- payout with a fresh nonce and no stored signed bytes, so every re-broadcast
-- defence in chainBroadcast.ts fell through vacuously and both transactions
-- landed. This index is the backstop for a predicate that forgets a status.
-- `failed` is excluded because a payout that provably never reached the wire is
-- meant to be retried by creating a fresh row; manual payouts carry no
-- payment_id and are unconstrained.
CREATE UNIQUE INDEX uq_payouts_active_payment
  ON payouts(payment_id)
  WHERE payment_id IS NOT NULL AND status <> 'failed';

-- The operator queue: "what is stuck and needs a human?", ordered by age.
CREATE INDEX idx_payouts_needs_operator
  ON payouts(created_at)
  WHERE status IN ('unresolved', 'processing');

COMMENT ON COLUMN payouts.asset IS
  'Asset settled. Balances are per (client, network, asset) — a USDC payout can '
  'never draw on a USDT balance.';
COMMENT ON COLUMN payouts.nonce IS
  'EVM account nonce this payout is pinned to; NULL on nonce-less chains. A '
  'chain mines at most one transaction per nonce, so a retry cannot double-pay.';
COMMENT ON COLUMN payouts.signed_tx IS
  'Raw signed transaction hex. A retry re-broadcasts these exact bytes rather '
  'than signing a new transfer.';
COMMENT ON COLUMN payouts.broadcast_at IS
  'When a broadcast was first ATTEMPTED. Non-null means a transaction may exist '
  'on-chain even if the row says failed — never blind-retry such a row.';

-- ---------- admin_withdrawals (admin commission withdrawals) -----------------
CREATE TABLE admin_withdrawals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amount        NUMERIC(38,18) NOT NULL,
  to_address    TEXT NOT NULL,
  network       TEXT NOT NULL DEFAULT 'BEP20',
  asset         TEXT NOT NULL DEFAULT 'USDT',
  tx_hash       TEXT,
  status        payout_status NOT NULL DEFAULT 'pending',
  triggered_by  UUID REFERENCES users(id),
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Same idempotency pins as payouts (migration 005): same signing key, same
  -- central wallet, same double-spend on retry if they are absent.
  nonce         BIGINT,
  signed_tx     TEXT,
  broadcast_at  TIMESTAMPTZ
);
CREATE INDEX idx_admin_withdrawals_status ON admin_withdrawals(status);
CREATE INDEX idx_admin_withdrawals_network_asset_status
  ON admin_withdrawals(network, asset, status);

-- ---------- webhook_logs -----------------------------------------------------
CREATE TABLE webhook_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  payment_id     TEXT REFERENCES payments(id) ON DELETE SET NULL,
  event          TEXT NOT NULL,                    -- payment.confirmed, etc.
  url            TEXT NOT NULL,
  payload        JSONB NOT NULL,
  signature      TEXT NOT NULL,
  attempt        INT NOT NULL DEFAULT 1,
  status_code    INT,
  success        BOOLEAN NOT NULL DEFAULT false,
  response_body  TEXT,
  next_retry_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_webhook_logs_payment ON webhook_logs(payment_id);
CREATE INDEX idx_webhook_logs_client  ON webhook_logs(client_id, created_at DESC);

-- ---------- audit_logs -------------------------------------------------------
CREATE TABLE audit_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id  UUID REFERENCES users(id),
  actor_type     TEXT NOT NULL DEFAULT 'user',     -- user | system | api
  action         TEXT NOT NULL,                    -- commission.update, client.approve...
  entity_type    TEXT,
  entity_id      TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}',
  ip             INET,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_actor  ON audit_logs(actor_user_id, created_at DESC);

-- ---------- assets (enable/display state ONLY) -------------------------------
-- Contract addresses and decimals live in backend/src/blockchain/assets.ts and
-- are deliberately NOT stored here: a wrong contract credits payments against a
-- token nobody sent, and wrong decimals mis-scale every amount by orders of
-- magnitude. Neither belongs behind an admin toggle.
CREATE TABLE assets (
  network      TEXT NOT NULL,
  symbol       TEXT NOT NULL,
  display_name TEXT,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  sort_order   INT NOT NULL DEFAULT 100,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (network, symbol)
);
INSERT INTO assets (network, symbol, display_name, sort_order) VALUES
  ('BEP20', 'USDT', 'Tether USD',        10),
  ('BEP20', 'USDC', 'USD Coin',          20),
  ('BEP20', 'BUSD', 'Binance USD',       30),
  ('BEP20', 'DAI',  'Dai Stablecoin',    40),
  ('TRC20', 'USDT', 'Tether USD',        10),
  ('TRC20', 'USDC', 'USD Coin',          20),
  ('TRC20', 'USDD', 'Decentralized USD', 30)
ON CONFLICT DO NOTHING;

-- Native coins (migration 012). Seeded DISABLED: accepting one also requires
-- ACCEPT_NATIVE_COINS=true, because a native sweep pays its fee out of the
-- balance it is moving rather than being funded by the gas station, and getting
-- that wrong strands funds at a deposit address instead of failing loudly.
INSERT INTO assets (network, symbol, display_name, enabled, sort_order) VALUES
  ('BEP20', 'BNB', 'BNB',  false, 90),
  ('TRC20', 'TRX', 'TRON', false, 90)
ON CONFLICT (network, symbol) DO NOTHING;

-- Ethereum (migration 013). NOTE the decimals these imply, verified on-chain:
-- USDT 6, USDC 6, DAI 18. Ethereum USDT is NOT 18 dp like its BSC cousin.
INSERT INTO assets (network, symbol, display_name, enabled, sort_order) VALUES
  ('ERC20', 'USDT', 'Tether USD',     true,  10),
  ('ERC20', 'USDC', 'USD Coin',       true,  20),
  ('ERC20', 'DAI',  'Dai Stablecoin', true,  40),
  ('ERC20', 'ETH',  'Ether',          false, 90)
ON CONFLICT (network, symbol) DO NOTHING;

-- Bitcoin (migration 014). ENABLED, unlike the other native coins: BTC is the
-- only asset this chain has, so gating it behind ACCEPT_NATIVE_COINS — a flag
-- about accepting a chain's GAS currency — would gate the entire network.
INSERT INTO assets (network, symbol, display_name, enabled, sort_order) VALUES
  ('BTC', 'BTC', 'Bitcoin', true, 10)
ON CONFLICT (network, symbol) DO NOTHING;

COMMENT ON TABLE assets IS
  'Enable/display state for assets, including the native coins BNB and TRX. '
  'Contract addresses and decimals live in backend/src/blockchain/assets.ts and '
  'are NOT configurable here — a wrong value in either is a fund-loss bug. '
  'Native coins additionally require ACCEPT_NATIVE_COINS=true; a row here is '
  'never sufficient to start accepting one.';

-- ---------- processed blocks (reorg-safe cursor, one row per network) --------
-- BEP20: the last block the BSC reconciler safely scanned.
-- TRC20: advisory only — the Tron listener is timestamp/address driven (TronGrid
--        exposes no block-range TRC20 query), so it records progress here for
--        observability but does not resume from it.
CREATE TABLE chain_cursor (
  network            TEXT PRIMARY KEY,
  last_scanned_block BIGINT NOT NULL DEFAULT 0
);
INSERT INTO chain_cursor (network, last_scanned_block) VALUES
  ('BEP20', 0),
  ('TRC20', 0),
  -- Ethereum (migration 013). `ERC20` is the token log scanner; `ERC20_NATIVE`
  -- is the block scanner for ETH itself, since natives emit no Transfer log.
  ('ERC20', 0),
  ('ERC20_NATIVE', 0),
  -- Bitcoin (migration 014). Advisory only: the listener is address-driven, so
  -- this records the tip for observability but is never resumed from.
  ('BTC', 0)
ON CONFLICT DO NOTHING;

-- ---------- updated_at trigger ----------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','clients','payments','payouts',
                           'invoices','subscriptions','assets','payment_links',
                           'unexpected_deposits'] LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_updated BEFORE UPDATE ON %1$s
       FOR EACH ROW EXECUTE FUNCTION set_updated_at();', t);
  END LOOP;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
