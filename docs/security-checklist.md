# Production Security Checklist

A categorized checklist for operating the Crypto Payment Gateway (USDT / BEP20)
safely in production. Each item has a one-line rationale. Treat unchecked boxes
as launch blockers unless explicitly risk-accepted and documented.

---

## 1. API authentication & HMAC

- [ ] **API secret never leaves the client / is never logged** — the secret is
      returned exactly once, at creation. NOTE: `api_secret_hash` holds the
      envelope-ENCRYPTED secret, not a bcrypt hash, because HMAC verification
      must recompute from the raw value (see the design note in
      `middleware/auth.ts`). A leaked secret = full account takeover.
- [ ] **HMAC signature covers `"${timestamp}.${rawBody}"`** — binding the body
      prevents tampering with amounts or order IDs in transit.
- [ ] **Signature verified over the exact raw bytes** — re-serializing JSON
      changes key order/spacing and yields false negatives (or bypasses).
- [ ] **Constant-time comparison for signatures** (`timingSafeEqual` /
      `hash_equals` / `hmac.compare_digest`) — defeats timing side-channels.
- [ ] **Unknown / revoked API keys rejected early** — check `api_key_status =
      'active'` before doing crypto work.
- [ ] **Secrets rotated on suspicion and on staff offboarding** — regenerating
      revokes the old key immediately.

## 1b. Bearer (simple-mode) API keys

Bearer keys (`ak_live_…`) send the credential on every request, so they are
strictly weaker than HMAC. They are supported because merchants expect them —
these controls are what make that acceptable, and removing any one of them
should mean removing the mode.

- [ ] **Bearer keys never carry `payouts:write`** — enforced at issuance
      (`assertScopesAllowed` rejects it with a 400, not a silent downgrade) and
      again per request (`requireScope` on `POST /payouts`). A leaked token can
      take money in and read state; it cannot move funds out.
- [ ] **Token stored as SHA-256, not encrypted** — nothing needs to read it
      back, unlike the HMAC secret. A database read cannot be replayed into API
      access.
- [ ] **Mode confusion rejected, never downgraded** — an HMAC key presented
      without a signature, or a bearer token presented with one, is a 401. If
      either fell back to the other, omitting headers would be a bypass.
- [ ] **IP allowlist set for every bearer key** — this is the main containment
      for a token that leaks into a log, a screenshot or shell history. The
      panel warns when a bearer key exists with an empty allowlist.
- [ ] **Per-key rate limit active** (`API_KEY_RATE_LIMIT_MAX`) — keyed on the
      key id, not the IP, so it bounds a leaked key rather than a busy merchant.

## 1c. Endpoints an API key must never reach

- [ ] **`PUT /account/settings` is dashboard-session only** — it writes the
      payout wallet. An API key that can change where settlements are sent turns
      a leaked credential into a direct, irreversible loss. Enforced by
      `requireDashboardSession`.
- [ ] **`POST`/`DELETE /account/api-keys*` is dashboard-session only** — a key
      must not be able to mint or revoke keys (privilege escalation / lockout).
- [ ] **`POST /account/change-password` is dashboard-session only.**
- [ ] Verify after any refactor: a bearer key against each of the above returns
      **401**, and the payout wallet is unchanged afterwards.

## 1d. Self-registration

- [ ] **`SIGNUP_ENABLED` reviewed for this deployment** — false closes
      registration entirely (routes 404, panel hides the UI). Password reset
      stays available either way.
- [ ] **SMTP configured before enabling signup in production** — the app refuses
      to boot otherwise, because unverifiable accounts strand merchants silently.
- [ ] **Signup / resend / forgot-password rate limited per IP per hour**
      (`SIGNUP_RATE_LIMIT_MAX`) — these send mail to an attacker-chosen address
      and are a spam relay if open.
- [ ] **All signup responses are enumeration-safe** — register, resend and
      forgot-password return an identical 202 whether or not the address exists.
      A duplicate signup emails the real owner instead of answering the caller.
- [ ] **Verification and reset tokens are single-use, expiring and stored
      hashed** — consumption is one atomic `UPDATE … WHERE used_at IS NULL`, so
      two concurrent clicks cannot both succeed.
- [ ] **Merchant-supplied `websiteUrl` restricted to http/https** — `.url()`
      alone accepts `javascript:`, and the admin panel renders this value as a
      clickable link. That would be stored XSS against an operator session.
- [ ] **New signups reviewed periodically** — Admin → Clients → "Self-registered"
      filter. There is no approval gate by design; suspending is the kill switch.

## 2. Replay protection

- [ ] **Reject timestamp skew > 5 minutes** — bounds the replay window for
      captured requests.
- [ ] **Server clock NTP-synced** — a drifting server clock silently rejects
      valid requests or widens the replay window.
- [ ] **Idempotency-Key enforced on `POST /payments`** — a replayed create can't
      mint duplicate payments/charges.
- [ ] **(Optional) nonce cache in Redis for the skew window** — blocks exact
      replays inside the 5-minute window.

## 3. JWT & refresh tokens (dashboards)

- [ ] **Short-lived access tokens** (`JWT_EXPIRES_IN=15m`) — limits the blast
      radius of a stolen access token.
- [ ] **Refresh tokens rotated and revocable** (`JWT_REFRESH_EXPIRES_IN=7d`) —
      one-time-use rotation detects token theft.
- [ ] **`JWT_SECRET` is long, random, and unique per environment** — prevents
      token forgery; never reuse across staging/prod.
- [ ] **Tokens signed HS256/RS256 with `alg` pinned** — reject `alg: none` and
      algorithm-confusion attacks.
- [ ] **Refresh tokens stored httpOnly + Secure + SameSite** (if cookie-based) —
      keeps them out of reach of XSS.

## 4. Admin MFA (TOTP)

- [ ] **TOTP MFA required for all admin logins** (`users.mfa_enabled`) —
      passwords alone are insufficient for privileged accounts.
- [ ] **`mfa_secret` stored encrypted** (envelope-encrypted, see §5) — a DB dump
      must not yield working TOTP seeds.
- [ ] **MFA enforced server-side on every privileged action path** — never rely
      on the UI to gate `/admin/*`.
- [ ] **Backup/recovery codes issued and single-use** — avoids lockout without
      weakening the second factor.

## 5. Secret encryption (envelope / KMS / HSM)

- [ ] **`MASTER_ENCRYPTION_KEY` sourced from KMS/Vault in prod, not a static env
      var** — a leaked `.env` must not decrypt secrets.
- [ ] **Envelope encryption for mnemonic, `mfa_secret`, `webhook_secret`, hot
      privkeys** — per-record data keys wrapped by the master key limit exposure.
- [ ] **Master key access is audited and least-privilege** — only the services
      that must decrypt can call KMS decrypt.
- [ ] **HSM/KMS signing for high-value hot wallets where feasible** — raw key
      material never touches app memory.
- [ ] **Key rotation procedure defined and tested** — rotate master key and
      re-wrap data keys without downtime.

## 6. Private key handling (HD wallets)

- [ ] **Deposit private keys are NEVER persisted** — reconstructed on demand from
      mnemonic + `derivation_index`; nothing to steal from the DB.
- [ ] **HD derivation index is monotonic (the `hd_deposit_index` SEQUENCE, with
      the legacy `hd_counter` row as the pre-migration fallback) and race-safe**
      — `nextval()` never returns a value twice, and the UNIQUE
      `idx_wallets_deriv` on `wallets(derivation_index) WHERE type='deposit'` is
      the backstop that makes two payments sharing a deposit address impossible
      even if an allocator were wrong. Gaps are expected and harmless: nothing
      reads derivation indexes densely.
- [ ] **Master mnemonic read once at boot, encrypted, then cleared from memory**
      — minimizes the window it exists in plaintext.
- [ ] **Hot/cold split: only sweep-necessary balance stays hot** — central/gas
      wallets are hot; bulk funds move to cold storage.
- [ ] **`GAS_STATION_PRIVATE_KEY` and central hot key stored encrypted, scoped to
      the worker only** — the API service should not hold spend keys.
- [ ] **Withdrawal/payout limits + approvals for large amounts** — caps
      single-incident loss if a hot key is compromised.

## 7. Rate limiting & abuse

- [ ] **Global + per-key rate limits** (`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`)
      — blunts brute force and resource exhaustion.
- [ ] **Stricter limits on `/auth/login`** — slows credential stuffing.
- [ ] **429 with `Retry-After`** — well-behaved clients back off instead of
      hammering.
- [ ] **Idempotent create endpoints** — retries under rate limiting don't
      duplicate work.

## 8. Network & IP controls

- [ ] **Per-client IP whitelist enforced** (`clients.ip_whitelist`) — stolen keys
      are useless from an unlisted IP.
- [ ] **Admin panel restricted to VPN / office IPs / bastion** — shrinks the
      attack surface for privileged UIs.
- [ ] **Databases and Redis not publicly exposed** — bind to the internal
      network only; no `0.0.0.0` in prod.
- [ ] **Trust the correct client IP behind the proxy** (`X-Forwarded-For` from a
      trusted proxy only) — prevents IP spoofing of whitelists/rate limits.

## 9. Webhook security

- [ ] **Outbound webhooks signed with per-client `webhook_secret`** — recipients
      can prove authenticity.
- [ ] **Merchants verify the signature over the raw body, constant-time** —
      unsigned/forged callbacks are rejected.
- [ ] **Webhooks are HTTPS-only** — protects payload and signature in transit.
- [ ] **Delivery retried with backoff and capped** (`WEBHOOK_MAX_RETRIES`,
      `WEBHOOK_TIMEOUT_MS`) — resilient without amplifying load.
- [ ] **`webhook_logs` capture payload, signature, attempts, response** — full
      audit + safe replay.

## 10. Input validation

- [ ] **Schema-validate every request body/query/header** — reject malformed
      input before it reaches business logic.
- [ ] **Amounts validated as decimal strings, positive, within bounds** — no
      floats; blocks negative/overflow/dust abuse.
- [ ] **Validate BEP20 addresses (checksum) for payout wallets** — prevents
      sending funds to malformed/burn addresses.
- [ ] **Reject oversized payloads (body size limit)** — mitigates DoS via large
      requests.

## 11. SQL injection & data access

- [ ] **All queries parameterized / prepared** — no string concatenation of user
      input into SQL.
- [ ] **ORM/query-builder used safely (no raw interpolation)** — avoids
      accidental injection sinks.
- [ ] **Least-privilege DB roles** — the app role can `SELECT/INSERT/UPDATE` its
      tables but not `DROP`/alter schema.
- [ ] **Separate read-only role for reporting/analytics** — limits damage from a
      compromised reporting path.

## 12. Transport & CORS

- [ ] **TLS everywhere (HSTS enabled)** — no plaintext API/dashboard/webhook
      traffic.
- [ ] **Modern TLS config (1.2+/1.3, strong ciphers)** — avoids downgrade and
      weak-cipher attacks.
- [ ] **CORS allowlist for dashboards only; API not `*`** — prevents hostile
      sites from riding user sessions.
- [ ] **Security headers set** (CSP, X-Content-Type-Options, X-Frame-Options) —
      hardens the panels against XSS/clickjacking.

## 13. Audit logging & monitoring

- [ ] **Privileged actions written to `audit_logs`** (approvals, commission
      changes, key regen, manual payouts) — non-repudiation and forensics.
- [ ] **Logs are append-only / tamper-evident and shipped off-box** — an attacker
      on the host can't erase the trail.
- [ ] **No secrets/PII in logs** — signatures, keys, mnemonics never logged.
- [ ] **Alerting on anomalies** — failed-auth spikes, large/failed payouts,
      reorgs, webhook failure rate, gas-station depletion.
- [ ] **On-chain vs. DB balance reconciliation alert** — detects sweep/payout
      drift or theft early.

## 14. Dependency & supply-chain security

- [ ] **Automated dependency scanning in CI** (`npm audit`, Snyk/Dependabot) —
      catches known CVEs before deploy.
- [ ] **Lockfiles committed and builds reproducible** — prevents surprise
      transitive upgrades.
- [ ] **Container base images pinned and regularly rebuilt** — patches OS-level
      CVEs.
- [ ] **Secrets never baked into images** — passed via env/secret manager at
      runtime.

## 15. Blockchain-specific safety

- [ ] **`REQUIRED_CONFIRMATIONS` ≥ 12 before `confirmed`** — resists shallow
      reorgs on BSC.
- [ ] **Reorg-safe cursor + rolling re-scan** (`chain_cursor`) — dropped txs are
      detected and reverted (`reorged`), not treated as paid.
- [ ] **Exact-amount / underpayment handling** (`partial`, `amount_received`) —
      never fulfill on an underpayment.
- [ ] **Gas-station wallet isolated and balance-monitored** — a drained gas
      station stalls sweeps; isolation caps its blast radius.
- [ ] **Sweeps top up gas per-address just-in-time** (`GAS_TOPUP_BNB`) — avoids
      leaving spendable BNB scattered on deposit addresses.
- [ ] **`MIN_SWEEP_AMOUNT` guards dust sweeps** — prevents spending more gas than
      value swept.
- [ ] **Correct token contract + 18 decimals pinned** (`USDT_CONTRACT`,
      `USDT_DECIMALS`) — blocks fake-token and decimal-mismatch accounting bugs.

## 16. Backups, key rotation & recovery

- [ ] **Encrypted, tested DB backups with retention** — recover from corruption
      or ransomware.
- [ ] **Mnemonic backed up in cold/offline storage (e.g. HSM/paper/Shamir)** —
      losing it loses all deposit-address funds.
- [ ] **Documented, rehearsed key-rotation runbook** — rotate JWT/master/API
      secrets without service loss.
- [ ] **Disaster-recovery runbook + RTO/RPO defined** — restore the whole stack
      predictably.

## 17. Operational hardening

- [ ] **Containers run as non-root, read-only FS where possible** — limits
      post-exploitation.
- [ ] **Services split by privilege (api / worker / listener)** — the internet-
      facing `api` never holds spend keys.
- [ ] **Health checks + auto-restart** (compose `healthcheck`, `restart`) —
      recovers from crashes; supports safe scaling.
- [ ] **Change management: infra as code + peer review** — no undocumented,
      unreviewed prod changes.
