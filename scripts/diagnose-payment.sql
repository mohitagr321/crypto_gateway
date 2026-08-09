-- ============================================================================
-- diagnose-payment.sql
-- Track a merchant's payment end-to-end: payment -> confirm -> sweep -> payout.
-- Usage on the server:
--   psql "postgres://gateway:...@localhost:5432/gateway" -f diagnose-payment.sql
-- or paste block-by-block into psql.
-- Change the email below if needed.
-- ============================================================================
\set merchant_email 'test@gmail.com'

\echo '========== 1) CLIENT / MERCHANT ROW =========='
-- Is the client approved? Is a payout_wallet configured? (both required for payout)
SELECT c.id            AS client_id,
       u.email,
       c.business_name,
       c.status        AS client_status,      -- must be 'approved' for payouts
       c.payout_wallet,                        -- must be set for any payout
       c.webhook_url,
       c.created_at
  FROM clients c
  JOIN users u ON u.id = c.user_id
 WHERE u.email = :'merchant_email';

\echo '========== 2) PAYMENTS FOR THIS MERCHANT (latest 20) =========='
-- Watch the `status` column. Lifecycle:
--   waiting -> confirming -> confirmed -> swept   (+ payout row created)
-- amount_received should equal what was actually sent on-chain.
SELECT p.id            AS payment_id,
       p.order_id,
       p.amount,
       p.amount_received,
       p.status,
       p.confirmations,
       p.required_confirmations,
       p.tx_hash,
       p.confirmed_at,
       p.created_at
  FROM payments p
  JOIN clients c ON c.id = p.client_id
  JOIN users   u ON u.id = c.user_id
 WHERE u.email = :'merchant_email'
 ORDER BY p.created_at DESC
 LIMIT 20;

\echo '========== 3) ON-CHAIN TXNS FOR THIS MERCHANTS PAYMENTS =========='
-- incoming = deposit detected; sweep = moved to central; payout = sent to merchant;
-- gas_funding = BNB topped up. status: pending|confirmed|reorged|failed.
SELECT bt.payment_id,
       bt.direction,
       bt.status,
       bt.amount,
       bt.confirmations,
       bt.block_number,
       bt.tx_hash,
       bt.from_address,
       bt.to_address,
       bt.created_at
  FROM blockchain_transactions bt
  JOIN payments p ON p.id = bt.payment_id
  JOIN clients  c ON c.id = p.client_id
  JOIN users    u ON u.id = c.user_id
 WHERE u.email = :'merchant_email'
 ORDER BY bt.created_at DESC
 LIMIT 40;

\echo '========== 4) PAYOUTS FOR THIS MERCHANT =========='
-- If EMPTY -> no payout was ever created (auto-payout disabled, no payout_wallet,
-- client not approved, or net=0). If present but status='failed' -> read `error`.
SELECT po.id            AS payout_id,
       po.payment_id,
       po.gross_amount,
       po.commission_amount,
       po.net_amount,
       po.to_address,
       po.status,        -- pending|processing|sent|confirmed|failed
       po.type,          -- auto|manual
       po.tx_hash,
       po.error,         -- populated on failure — THIS is usually the root cause
       po.created_at
  FROM payouts po
  JOIN clients c ON c.id = po.client_id
  JOIN users   u ON u.id = c.user_id
 WHERE u.email = :'merchant_email'
 ORDER BY po.created_at DESC
 LIMIT 20;

\echo '========== 5) COMPUTED BALANCE (what the panel shows as available) =========='
-- available = SUM(amount_received for confirmed/swept) - SUM(gross for active payouts)
WITH c AS (
  SELECT c.id FROM clients c JOIN users u ON u.id = c.user_id
   WHERE u.email = :'merchant_email'
)
SELECT
  (SELECT COALESCE(SUM(amount_received),0) FROM payments
     WHERE client_id = (SELECT id FROM c)
       AND status IN ('confirmed','swept'))                    AS confirmed_credit,
  (SELECT COALESCE(SUM(gross_amount),0) FROM payouts
     WHERE client_id = (SELECT id FROM c)
       AND status IN ('pending','processing','sent','confirmed')) AS paid_out,
  (SELECT COALESCE(SUM(amount),0) FROM payments
     WHERE client_id = (SELECT id FROM c)
       AND status IN ('waiting','confirming','partial'))       AS pending_incoming;

\echo '========== 6) ACTIVE COMMISSION (could zero-out a small payout) =========='
WITH c AS (
  SELECT c.id FROM clients c JOIN users u ON u.id = c.user_id
   WHERE u.email = :'merchant_email'
)
SELECT type, value, tiers, network_fee_payer, is_active, created_at
  FROM commissions
 WHERE client_id = (SELECT id FROM c) AND is_active = true;
