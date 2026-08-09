/**
 * Environment loading + validation.
 *
 * Every process (api, worker, listener, seed) imports this module first.
 * All env vars declared in the project `.env.example` contract are validated
 * here with zod. Missing/invalid values fail fast at boot — never at request time.
 */
import path from 'path';
import dotenv from 'dotenv';
import { Wallet } from 'ethers';
import { z } from 'zod';

// Load env from the process cwd first (e.g. backend/.env if you keep one), then
// fall back to the monorepo root .env (../../../.env resolves from both src/config
// and dist/config). dotenv never overrides already-set vars, so env injected by
// docker compose (env_file) always wins and a missing file is a harmless no-op.
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

// Coerce common boolean spellings to a real boolean.
const boolish = z
  .union([z.string(), z.boolean()])
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
  });

const numberish = (def?: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return def;
      const n = typeof v === 'number' ? v : Number(v);
      return n;
    })
    .pipe(z.number());

const EnvSchema = z.object({
  // ---- Core ----
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: numberish(4000),
  APP_BASE_URL: z.string().url().default('http://localhost:4000'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // ---- Postgres ----
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // ---- Redis ----
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  // ---- Auth / crypto ----
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  // 32-byte key expressed as 64 hex chars.
  MASTER_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'MASTER_ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),

  // ---- Blockchain (BSC / BEP20) ----
  BSC_HTTP_RPC: z.string().url(),
  // Optional: empty disables the live WS subscription (the HTTP polling
  // reconciler remains the source of truth). A bad/unreachable WS URL degrades
  // to polling instead of crashing — see blockchain/listener.ts.
  BSC_WS_RPC: z.string().optional().default(''),
  BSC_CHAIN_ID: numberish(56),
  USDT_CONTRACT: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'USDT_CONTRACT must be a 0x address'),
  USDT_DECIMALS: numberish(18),
  REQUIRED_CONFIRMATIONS: numberish(12),
  PAYMENT_EXPIRY_MINUTES: numberish(30),

  // ---- Blockchain (Ethereum / ERC20) ----
  // ERC20 is OPT-IN, and needs an RPC as well as the flag: there is no usable
  // free default the way BSC has one. `eth.drpc.org` does serve the queries this
  // gateway makes (verified), but a settlement path on a free public endpoint is
  // a dependency worth paying to remove — an Alchemy/Infura URL goes here.
  ETH_ENABLED: boolish.default(false),
  ETH_HTTP_RPC: z.string().optional().default(''),
  ETH_WS_RPC: z.string().optional().default(''),
  ETH_CHAIN_ID: numberish(1),
  // Overridable for the same reason TRON_USDT_CONTRACT is: a testnet's USDT is
  // a different address, and testing a sweep with real funds is the only way to
  // prove it. Mainnet's value is the default. Every OTHER Ethereum asset stays
  // mainnet-only.
  ETH_USDT_CONTRACT: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'ETH_USDT_CONTRACT must be a 0x address')
    .default('0xdAC17F958D2ee523a2206206994597C13D831ec7'),
  ETH_USDT_DECIMALS: numberish(6),
  // Ethereum reorgs are shallower than BSC's in practice, but blocks are ~12s
  // so this is ~2.5 minutes of depth rather than BSC's ~7 seconds.
  ETH_REQUIRED_CONFIRMATIONS: numberish(12),
  ETH_REORG_DEPTH: numberish(12),
  // Separate keys from BSC's on purpose. They CAN be the same key (the address
  // is identical — both chains use coin type 60), but an operator who wants
  // Ethereum funds in a different hot wallet must be able to say so.
  ETH_CENTRAL_WALLET_ADDRESS: z.string().optional().default(''),
  ETH_CENTRAL_WALLET_PRIVATE_KEY: z.string().optional().default(''),
  ETH_GAS_STATION_PRIVATE_KEY: z.string().optional().default(''),
  // Dust floor. Far higher than BSC's because Ethereum gas genuinely can cost
  // more than the payment: sweeping 5 USDT at 40 gwei is a loss.
  ETH_MIN_SWEEP_AMOUNT: z.string().default('20'),
  // Dynamic gas. The top-up is ESTIMATED per sweep rather than fixed, and a
  // sweep whose fee would exceed this ceiling is DEFERRED (the settle tick
  // re-drives it) rather than failed — the funds are safe where they are.
  ETH_MAX_SWEEP_FEE_ETH: z.string().default('0.01'),
  // Head-room over the estimate, absorbing a base-fee rise before broadcast.
  ETH_GAS_BUFFER_PERCENT: numberish(25),

  // ---- Blockchain (Tron / TRC20) ----
  // TRC20 is OPT-IN. With TRON_ENABLED=false (the default) none of the values
  // below are read, no Tron client is constructed, and the API rejects
  // network=TRC20 — a BEP20-only deployment behaves exactly as it did before.
  TRON_ENABLED: boolish.default(false),
  TRON_FULL_HOST: z.string().url().default('https://api.trongrid.io'),
  // TronGrid rate-limits hard without a key. Optional, but strongly advised.
  TRON_API_KEY: z.string().optional().default(''),
  // USDT on Tron mainnet. NOTE: 6 decimals, not 18 like BSC.
  TRON_USDT_CONTRACT: z
    .string()
    .regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/, 'TRON_USDT_CONTRACT must be a base58 T... address')
    .default('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'),
  TRON_USDT_DECIMALS: numberish(6),
  // Tron solidifies (irreversibly finalises) a block after ~19 blocks / ~57s.
  // Promoting at solidification is what makes TRC20 deposits reorg-safe.
  TRON_REQUIRED_CONFIRMATIONS: numberish(19),

  // ---- Bitcoin ----
  // OPT-IN, but unlike every other chain it needs NOTHING bought: Blockstream's
  // Esplora and mempool.space are keyless on both mainnet and testnet.
  BTC_ENABLED: boolish.default(false),
  // 'mainnet' | 'testnet'. Chooses the address prefixes (bc1/tb1) AND the
  // default API host, so the two can never disagree — a testnet key signing
  // against a mainnet index is the kind of mistake that spends real coins.
  BTC_NETWORK: z.enum(['mainnet', 'testnet']).default('mainnet'),
  // Esplora-compatible API. Empty picks the right Blockstream host for
  // BTC_NETWORK. mempool.space is a drop-in alternative.
  BTC_API_URL: z.string().optional().default(''),
  // Bitcoin blocks are ~10 minutes. 2 is ~20 minutes and is the usual floor for
  // a payment gateway; raise it for larger amounts.
  BTC_REQUIRED_CONFIRMATIONS: numberish(2),
  // Fee target, in blocks. Esplora returns a sat/vB estimate per target; 6 is
  // roughly an hour and is a reasonable default for settlement that is not
  // time-critical. Lower = faster and dearer.
  BTC_FEE_TARGET_BLOCKS: numberish(6),
  // Floor on the fee rate, in sat/vB. Esplora occasionally returns an estimate
  // below the relay minimum, which produces a transaction no node will accept.
  BTC_MIN_FEE_RATE: numberish(2),
  // Ceiling, in sat/vB. A fee spike above this DEFERS a sweep rather than
  // overpaying — same reasoning as the Ethereum gas ceiling.
  BTC_MAX_FEE_RATE: numberish(200),
  // Central wallet. Bitcoin has no "gas station": there is nothing to fund an
  // address with, because a sweep always pays out of what it moves.
  BTC_CENTRAL_WALLET_ADDRESS: z.string().optional().default(''),
  // HD index of the central wallet, derived from the SAME mnemonic as deposits.
  // Deposit indexes start at 0 and count up, so a high index keeps the central
  // wallet permanently clear of them.
  BTC_CENTRAL_DERIVATION_INDEX: numberish(2_000_000_000),
  // BIP-84 (native segwit, bc1q…). Not BIP-44: segwit inputs are ~40% smaller,
  // and on a chain where the fee IS the size that is a direct saving.
  BTC_DERIVATION_PATH: z.string().default("m/84'/0'/0'/0"),
  // Dust floor for a sweep, in BTC. Below this a sweep can cost more than it
  // moves — the same trade as ETH_MIN_SWEEP_AMOUNT.
  BTC_MIN_SWEEP_AMOUNT: z.string().default('0.0001'),

  // ---- Accepted assets (per network) ----
  // Comma-separated symbol allowlist, e.g. "USDC,BUSD". USDT is ALWAYS accepted
  // on an enabled network and does not need listing — every existing
  // integration depends on it, and an allowlist typo must not be able to switch
  // it off. Contract addresses and decimals are NOT configurable here: they live
  // in blockchain/assets.ts because a wrong value there is a fund-loss bug.
  // An asset on a disabled network is inert, so this is safe to pre-fill.
  ASSETS_BEP20: z.string().optional().default(''),
  ASSETS_TRC20: z.string().optional().default(''),
  ASSETS_ERC20: z.string().optional().default(''),

  // ---- Native coins (BNB, TRX) ----
  // A SECOND gate on top of the allowlists above, for the same reason
  // TRON_ENABLED exists: accepting a native coin changes how settlement works
  // rather than adding another token.
  //
  // A token deposit is swept by FUNDING the address with gas from the gas
  // station. A native deposit has to pay its own fee OUT OF the balance being
  // swept — the inverse flow — and if that arithmetic is wrong the funds strand
  // at an address instead of failing loudly. Listing 'BNB' in ASSETS_BEP20 is
  // therefore not enough on its own; switching this on has to be deliberate.
  ACCEPT_NATIVE_COINS: boolish.default(false),
  // Extra native left at a BEP20 deposit address beyond the exact fee, as a
  // multiplier on the gas price. The sweep pins gasPrice and gasLimit so the fee
  // is exact, but pinning too low means the transaction never mines.
  NATIVE_SWEEP_GAS_BUMP: z.string().default('1.25'),
  // Hard ceiling on how much TRX a native Tron sweep will leave behind for
  // bandwidth when the account has no free allowance. Purely a safety valve —
  // the adapter reserves the actual measured cost, usually zero.
  TRON_NATIVE_SWEEP_RESERVE_TRX: z.string().default('2'),

  // ---- Fiat pricing / exchange rates ----
  // Fiat currencies a merchant may price in. A payment's crypto amount is
  // computed from these ONCE, at creation, and then frozen.
  FIAT_CURRENCIES: z.string().default('USD,INR,EUR'),
  // Public CoinGecko. The free tier needs no key and rate-limits by IP, which is
  // exactly why the cache below exists rather than being an optimisation.
  RATE_PROVIDER_URL: z.string().url().default('https://api.coingecko.com/api/v3/simple/price'),
  // Optional. A demo/pro key raises the upstream limit; unset is fully supported.
  COINGECKO_API_KEY: z.string().optional().default(''),
  RATE_PROVIDER_TIMEOUT_MS: numberish(6000),
  // How long a fetched rate is considered FRESH. Stablecoins move slowly, so a
  // minute is generous while still bounding how many upstream calls a busy
  // gateway makes.
  RATE_FRESH_SECONDS: numberish(60),
  // How long past freshness a cached rate may still be SERVED while a refresh
  // happens in the background. This window is the whole point: a provider
  // outage degrades a quote to a slightly old price instead of failing payment
  // creation outright. Beyond it, quoting is refused rather than guessed.
  RATE_MAX_STALE_SECONDS: numberish(86_400),

  // ---- HD wallet ----
  HD_WALLET_MNEMONIC: z.string().min(1, 'HD_WALLET_MNEMONIC is required'),
  HD_DERIVATION_PATH: z.string().default("m/44'/60'/0'/0"),
  // Tron BIP-44 coin type is 195 (BSC/ETH is 60). The SAME mnemonic is reused;
  // the coin type keeps the two address spaces completely disjoint.
  TRON_HD_DERIVATION_PATH: z.string().default("m/44'/195'/0'/0"),

  // ---- Tron central / gas wallets ----
  // Mirrors the BSC pair: the private key is the source of truth for where swept
  // TRC20 funds live; the address is informational (see tronAdapter).
  TRON_CENTRAL_WALLET_ADDRESS: z.string().optional().default(''),
  TRON_CENTRAL_WALLET_PRIVATE_KEY: z.string().optional().default(''),
  TRON_GAS_STATION_PRIVATE_KEY: z.string().optional().default(''),

  // ---- Central / gas wallets ----
  CENTRAL_WALLET_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'CENTRAL_WALLET_ADDRESS must be a 0x address'),
  // The hot key that CONTROLS the central collection wallet. Sweeps deposit funds
  // into its address and payouts are signed by it, so both always agree. If unset,
  // we fall back to GAS_STATION_PRIVATE_KEY (single-hot-key setup).
  CENTRAL_WALLET_PRIVATE_KEY: z.string().optional().default(''),
  GAS_STATION_PRIVATE_KEY: z.string().optional().default(''),

  // ---- Settlement ----
  AUTO_PAYOUT_ENABLED: boolish.default(false),
  MIN_SWEEP_AMOUNT: z.string().default('1.0'),
  GAS_TOPUP_BNB: z.string().default('0.0008'),
  // Tron settlement. A TRC20 transfer from a fresh address burns ~13-30 TRX when
  // the sender has no staked energy, so the top-up is orders of magnitude larger
  // than the BNB one. Stake energy on the gas station to cut this materially.
  TRON_MIN_SWEEP_AMOUNT: z.string().default('1.0'),
  TRON_GAS_TOPUP_TRX: z.string().default('30'),
  // Hard ceiling on fee burn per TRC20 transfer (safety valve, in TRX).
  TRON_FEE_LIMIT_TRX: z.string().default('100'),

  // ---- Webhooks ----
  WEBHOOK_MAX_RETRIES: numberish(8),
  WEBHOOK_TIMEOUT_MS: numberish(8000),

  // ---- Merchant self-registration ----
  // The kill switch. With SIGNUP_ENABLED=false the public /auth/register,
  // /auth/verify-email and password-reset routes all return 404 and the panel
  // hides its signup UI, leaving the operator-provisioned flow as the only way in.
  SIGNUP_ENABLED: boolish.default(true),
  // Where the merchant-facing panel is served. Used ONLY to build the links in
  // outbound email — APP_BASE_URL points at the API, which is a different host.
  PUBLIC_PANEL_URL: z.string().url().default('http://localhost:5174'),
  EMAIL_VERIFY_TTL_HOURS: numberish(24),
  PASSWORD_RESET_TTL_MINUTES: numberish(60),
  // Commission applied to a self-registered merchant at signup. An operator can
  // change it afterwards from the admin panel; the point is that a merchant is
  // never silently on 0%.
  SIGNUP_DEFAULT_COMMISSION_PERCENT: z.string().default('1'),

  // ---- Outbound email (SMTP) ----
  // Self-registration needs email: verification links and password resets are
  // the only proof of address ownership. Leave SMTP_HOST empty in development —
  // emailService then LOGS the rendered message (link included) instead of
  // sending, so the whole flow is testable with no mail server. In production
  // with SIGNUP_ENABLED=true, SMTP_HOST and SMTP_FROM are required (see the
  // superRefine below) — booting without them would strand every new signup on
  // an unverified account with no way to proceed.
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: numberish(587),
  SMTP_SECURE: boolish.default(false), // true for implicit TLS on 465
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASSWORD: z.string().optional().default(''),
  SMTP_FROM: z.string().optional().default(''),
  // Shown in email footers and templates.
  // Keep in sync with VITE_BRAND_NAME in the panels (client-panel/src/lib/brand.ts).
  // A verification email from one name about a checkout branded with another
  // reads exactly like a phish.
  BRAND_NAME: z.string().default('SecuriPay'),
  SUPPORT_EMAIL: z.string().optional().default(''),

  // ---- Rate limiting ----
  RATE_LIMIT_WINDOW_MS: numberish(60000),
  RATE_LIMIT_MAX: numberish(120),
  // Signup / password-reset attempts per IP per hour. Deliberately tiny — these
  // routes send mail to attacker-chosen addresses, so they are a spam vector.
  SIGNUP_RATE_LIMIT_MAX: numberish(5),
  // Requests per API key per rate-limit window. A simple-mode key is a bearer
  // token; if one leaks, this is what bounds the damage before it is revoked.
  API_KEY_RATE_LIMIT_MAX: numberish(600),

  // ---- Reorg safety ----
  // Not in .env.example explicitly; how deep behind head we re-scan for reorgs.
  REORG_DEPTH: numberish(15),
})
  // Same fail-fast principle as TRC20 below: an Ethereum deployment with no RPC
  // would mint deposit addresses it can never watch, and one with no key could
  // never sweep them. Both are silent fund-stranding failures at request time.
  .superRefine((e, ctx) => {
    if (!e.ETH_ENABLED) return;
    if (!e.ETH_HTTP_RPC) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ETH_HTTP_RPC'],
        message:
          'ETH_ENABLED=true requires ETH_HTTP_RPC — Ethereum has no usable default ' +
          'endpoint, and without one the gateway would hand out deposit addresses ' +
          'it cannot watch. An Alchemy/Infura URL is the production answer; ' +
          'https://eth.drpc.org works for evaluation.',
      });
    }
    if (!e.ETH_CENTRAL_WALLET_PRIVATE_KEY && !e.ETH_GAS_STATION_PRIVATE_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ETH_CENTRAL_WALLET_PRIVATE_KEY'],
        message:
          'ETH_ENABLED=true requires ETH_CENTRAL_WALLET_PRIVATE_KEY (or ' +
          'ETH_GAS_STATION_PRIVATE_KEY) — without it ERC20 deposits could not be ' +
          'swept or settled.',
      });
    }
  })
  // Fail fast if TRC20 is switched on without the wallet it needs to settle.
  // Booting half-configured would let the gateway hand out Tron deposit
  // addresses it can neither sweep nor pay out from — funds would strand.
  .superRefine((e, ctx) => {
    if (!e.TRON_ENABLED) return;
    if (!e.TRON_CENTRAL_WALLET_PRIVATE_KEY && !e.TRON_GAS_STATION_PRIVATE_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TRON_CENTRAL_WALLET_PRIVATE_KEY'],
        message:
          'TRON_ENABLED=true requires TRON_CENTRAL_WALLET_PRIVATE_KEY (or TRON_GAS_STATION_PRIVATE_KEY) — ' +
          'without it TRC20 deposits could not be swept or settled.',
      });
    }
  })
  // Same fail-fast principle applied to signup: a production gateway that
  // accepts registrations but cannot send the verification email would collect
  // accounts that can never be activated, with no visible error anywhere.
  .superRefine((e, ctx) => {
    if (e.NODE_ENV !== 'production' || !e.SIGNUP_ENABLED) return;
    if (!e.SMTP_HOST) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMTP_HOST'],
        message:
          'SIGNUP_ENABLED=true in production requires SMTP_HOST — without it no ' +
          'verification email can be sent and every new signup would be stranded. ' +
          'Set SIGNUP_ENABLED=false to run operator-provisioned only.',
      });
    }
    if (!e.SMTP_FROM) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMTP_FROM'],
        message:
          'SIGNUP_ENABLED=true in production requires SMTP_FROM (the sender address).',
      });
    }
  });

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  // Print a readable list of problems and exit — never boot with bad config.
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

// ---- Central wallet resolution -------------------------------------------
// The signing key is the source of truth for WHERE swept funds live: sweeps go
// to this address and payouts spend from it. Derive the address from the key so
// the two can never diverge (the mismatch bug where sweeps landed in one wallet
// but payouts tried to spend from another).
const centralWalletPrivateKey =
  env.CENTRAL_WALLET_PRIVATE_KEY || env.GAS_STATION_PRIVATE_KEY || '';
let centralWalletAddress = env.CENTRAL_WALLET_ADDRESS;
if (centralWalletPrivateKey) {
  try {
    const derived = new Wallet(centralWalletPrivateKey).address;
    if (derived.toLowerCase() !== env.CENTRAL_WALLET_ADDRESS.toLowerCase()) {
      // eslint-disable-next-line no-console
      console.warn(
        `[config] CENTRAL_WALLET_ADDRESS (${env.CENTRAL_WALLET_ADDRESS}) does not match ` +
          `the address of the central wallet key (${derived}). Using the key's address ` +
          `so sweeps and payouts use the same wallet.`,
      );
    }
    centralWalletAddress = derived;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      '[config] central wallet private key is invalid; payouts/sweeps will fail until fixed.',
    );
  }
}

export const config = {
  nodeEnv: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  port: env.PORT,
  appBaseUrl: env.APP_BASE_URL,
  logLevel: env.LOG_LEVEL,

  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,

  jwt: {
    secret: env.JWT_SECRET,
    expiresIn: env.JWT_EXPIRES_IN,
    refreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
  },
  masterEncryptionKey: env.MASTER_ENCRYPTION_KEY,

  chain: {
    httpRpc: env.BSC_HTTP_RPC,
    wsRpc: env.BSC_WS_RPC,
    chainId: env.BSC_CHAIN_ID,
    usdtContract: env.USDT_CONTRACT,
    usdtDecimals: env.USDT_DECIMALS,
    requiredConfirmations: env.REQUIRED_CONFIRMATIONS,
    reorgDepth: env.REORG_DEPTH,
  },

  // Bitcoin. `apiUrl` resolves to the right Blockstream host for the chosen
  // network when left empty, so mainnet config can never point at testnet data
  // (or the reverse) through an oversight.
  btc: {
    enabled: env.BTC_ENABLED,
    isTestnet: env.BTC_NETWORK === 'testnet',
    apiUrl:
      env.BTC_API_URL ||
      (env.BTC_NETWORK === 'testnet'
        ? 'https://blockstream.info/testnet/api'
        : 'https://blockstream.info/api'),
    requiredConfirmations: env.BTC_REQUIRED_CONFIRMATIONS,
    feeTargetBlocks: env.BTC_FEE_TARGET_BLOCKS,
    minFeeRate: env.BTC_MIN_FEE_RATE,
    maxFeeRate: env.BTC_MAX_FEE_RATE,
    centralWalletAddress: env.BTC_CENTRAL_WALLET_ADDRESS,
    centralDerivationIndex: env.BTC_CENTRAL_DERIVATION_INDEX,
    derivationPath: env.BTC_DERIVATION_PATH,
    minSweepAmount: env.BTC_MIN_SWEEP_AMOUNT,
  },

  // Ethereum / ERC20. Like `tron` below, raw values only: the central address is
  // derived from the key inside the adapter so the two can never disagree.
  eth: {
    enabled: env.ETH_ENABLED,
    httpRpc: env.ETH_HTTP_RPC,
    wsRpc: env.ETH_WS_RPC,
    chainId: env.ETH_CHAIN_ID,
    usdtContract: env.ETH_USDT_CONTRACT,
    usdtDecimals: env.ETH_USDT_DECIMALS,
    requiredConfirmations: env.ETH_REQUIRED_CONFIRMATIONS,
    reorgDepth: env.ETH_REORG_DEPTH,
    centralWalletAddress: env.ETH_CENTRAL_WALLET_ADDRESS,
    // Falls back to the gas key, mirroring the BSC resolution below.
    centralWalletPrivateKey:
      env.ETH_CENTRAL_WALLET_PRIVATE_KEY || env.ETH_GAS_STATION_PRIVATE_KEY || '',
    gasStationPrivateKey:
      env.ETH_GAS_STATION_PRIVATE_KEY || env.ETH_CENTRAL_WALLET_PRIVATE_KEY || '',
    minSweepAmount: env.ETH_MIN_SWEEP_AMOUNT,
    maxSweepFeeEth: env.ETH_MAX_SWEEP_FEE_ETH,
    gasBufferPercent: env.ETH_GAS_BUFFER_PERCENT,
  },

  // TRC20 / Tron. Raw values only — the central address is derived from the key
  // inside blockchain/tronAdapter.ts (mirroring the BSC logic below) so that
  // `tronweb` is never imported on a BEP20-only deployment.
  tron: {
    enabled: env.TRON_ENABLED,
    fullHost: env.TRON_FULL_HOST,
    apiKey: env.TRON_API_KEY,
    usdtContract: env.TRON_USDT_CONTRACT,
    usdtDecimals: env.TRON_USDT_DECIMALS,
    requiredConfirmations: env.TRON_REQUIRED_CONFIRMATIONS,
    derivationPath: env.TRON_HD_DERIVATION_PATH,
    centralWalletAddress: env.TRON_CENTRAL_WALLET_ADDRESS,
    centralWalletPrivateKey:
      env.TRON_CENTRAL_WALLET_PRIVATE_KEY || env.TRON_GAS_STATION_PRIVATE_KEY || '',
    gasStationPrivateKey:
      env.TRON_GAS_STATION_PRIVATE_KEY || env.TRON_CENTRAL_WALLET_PRIVATE_KEY || '',
    minSweepAmount: env.TRON_MIN_SWEEP_AMOUNT,
    gasTopupTrx: env.TRON_GAS_TOPUP_TRX,
    feeLimitTrx: env.TRON_FEE_LIMIT_TRX,
    // Ceiling on the TRX a NATIVE sweep leaves behind for bandwidth. Normally
    // nothing is reserved — a fresh account's free daily allowance covers the
    // transfer — so this is the fallback, not the usual case.
    nativeSweepReserveTrx: env.TRON_NATIVE_SWEEP_RESERVE_TRX,
  },

  // Per-network symbol allowlists. Resolved into real assets by
  // blockchain/assets.ts, which also always includes USDT.
  assets: {
    bep20: env.ASSETS_BEP20,
    trc20: env.ASSETS_TRC20,
    erc20: env.ASSETS_ERC20,
    // See the note in EnvSchema: this is a second, deliberate gate, because a
    // native coin inverts the sweep's fee flow rather than adding a token.
    acceptNative: env.ACCEPT_NATIVE_COINS,
    nativeSweepGasBump: env.NATIVE_SWEEP_GAS_BUMP,
    tronNativeSweepReserveTrx: env.TRON_NATIVE_SWEEP_RESERVE_TRX,
  },

  hd: {
    mnemonic: env.HD_WALLET_MNEMONIC,
    derivationPath: env.HD_DERIVATION_PATH,
  },

  // Fiat pricing. `currencies` is resolved into a validated allowlist by
  // services/rateService.ts, which also rejects codes it has no provider
  // support for rather than quoting them at a made-up rate.
  rates: {
    currencies: env.FIAT_CURRENCIES,
    providerUrl: env.RATE_PROVIDER_URL,
    apiKey: env.COINGECKO_API_KEY,
    timeoutMs: env.RATE_PROVIDER_TIMEOUT_MS,
    freshSeconds: env.RATE_FRESH_SECONDS,
    maxStaleSeconds: env.RATE_MAX_STALE_SECONDS,
  },

  centralWalletAddress,
  centralWalletPrivateKey,
  gasStationPrivateKey: env.GAS_STATION_PRIVATE_KEY || centralWalletPrivateKey,

  settlement: {
    autoPayoutEnabled: env.AUTO_PAYOUT_ENABLED,
    minSweepAmount: env.MIN_SWEEP_AMOUNT,
    gasTopupBnb: env.GAS_TOPUP_BNB,
  },

  paymentExpiryMinutes: env.PAYMENT_EXPIRY_MINUTES,

  webhook: {
    maxRetries: env.WEBHOOK_MAX_RETRIES,
    timeoutMs: env.WEBHOOK_TIMEOUT_MS,
  },

  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    signupMax: env.SIGNUP_RATE_LIMIT_MAX,
    apiKeyMax: env.API_KEY_RATE_LIMIT_MAX,
  },

  signup: {
    enabled: env.SIGNUP_ENABLED,
    panelUrl: env.PUBLIC_PANEL_URL.replace(/\/+$/, ''),
    verifyTtlHours: env.EMAIL_VERIFY_TTL_HOURS,
    resetTtlMinutes: env.PASSWORD_RESET_TTL_MINUTES,
    defaultCommissionPercent: env.SIGNUP_DEFAULT_COMMISSION_PERCENT,
  },

  // `enabled` is what every caller checks: with no host configured, emailService
  // logs the message instead of sending it. That is the intended dev behaviour,
  // not a degraded one — production is protected by the superRefine above.
  smtp: {
    enabled: Boolean(env.SMTP_HOST),
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    user: env.SMTP_USER,
    password: env.SMTP_PASSWORD,
    from: env.SMTP_FROM || `no-reply@${env.SMTP_HOST || 'localhost'}`,
  },

  brand: {
    name: env.BRAND_NAME,
    supportEmail: env.SUPPORT_EMAIL,
  },
} as const;

export type AppConfig = typeof config;
