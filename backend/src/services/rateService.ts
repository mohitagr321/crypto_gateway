/**
 * Fiat exchange rates — CoinGecko, cached in Redis, stale-while-revalidate.
 *
 * ============================ WHAT THIS IS FOR ===============================
 * A merchant prices in the money they think in ("₹5,000", "$49") and the
 * customer pays in crypto. This module answers exactly one question: what is one
 * unit of ASSET worth in FIAT, right now? The answer is used ONCE, at payment
 * creation, and then frozen onto the payment row. Nothing re-reads a rate to
 * re-price an existing payment — see the header of migration 011.
 *
 * ============================ THE FAILURE MODE THAT MATTERS ==================
 * CoinGecko's free tier is an unauthenticated public API that rate-limits by IP
 * and goes down like anything else. If a rate lookup were a hard dependency of
 * payment creation, then every outage upstream would become an outage HERE — a
 * merchant's checkout stops taking money because a third party is having a bad
 * afternoon. That trade is never worth making for a stablecoin quote that moves
 * by fractions of a percent.
 *
 * So the cache is not a performance optimisation. It is the availability
 * strategy, in three tiers:
 *
 *   age <= RATE_FRESH_SECONDS      -> serve it. Normal operation.
 *   age <= RATE_MAX_STALE_SECONDS  -> SERVE IT ANYWAY, and refresh in the
 *                                     background. The caller is never blocked
 *                                     and never fails. This is the degraded
 *                                     mode the whole design exists to reach.
 *   older, or nothing cached       -> try once, synchronously. If that fails,
 *                                     REFUSE (503).
 *
 * That last tier is as important as the second. Degrading to a slightly old
 * price is a considered trade; inventing one, or serving a rate from last week
 * as though it were current, is not. There is a bound, and past it the honest
 * answer is "I cannot quote that right now".
 *
 * A crypto-priced payment never touches this module at all, so an outage here
 * cannot affect the pre-existing payment path in any way.
 *
 * ============================ ONE CALL, NOT N ================================
 * Every asset × every fiat comes back in a single upstream request and lands
 * under ONE Redis key. Twenty concurrent payment creations during a cache miss
 * would otherwise be twenty upstream calls, which is how a free tier gets an IP
 * banned. `SET NX` gives one caller the right to fetch; the rest wait briefly
 * for its result.
 *
 * ============================ IDS LIVE IN CODE ===============================
 * The symbol -> CoinGecko id map is here, in code, for the same reason contract
 * addresses are in blockchain/assets.ts: mapping USDC to the wrong id quotes a
 * payment against the wrong asset's price. It is not configuration.
 */
import { formatUnits, parseUnits } from 'ethers';
import { config } from '../config/env';
import { logger } from '../config/logger';
import { redis } from '../db/redis';
import { AppError } from '../utils/apiError';
import { enabledAssets } from '../blockchain/assets';

// ---------------------------------------------------------------------------
// Provider mapping
// ---------------------------------------------------------------------------

/**
 * Asset symbol -> CoinGecko coin id. NOT configurable: a wrong id here prices a
 * payment against a different asset entirely, which is a fund-loss bug of the
 * same family as a wrong contract address.
 *
 * Keyed by symbol alone rather than by (network, symbol) because a token's
 * FIAT price is the same wherever it is bridged — USDT on BSC and USDT on Tron
 * are different assets to settle, but not different prices to quote. That is
 * the one place in this codebase where the two chains legitimately collapse.
 */
const COIN_IDS: Record<string, string> = {
  USDT: 'tether',
  USDC: 'usd-coin',
  BUSD: 'binance-usd',
  DAI: 'dai',
  USDD: 'usdd',
  // Native coins, payable since R5. Harmless when disabled — an id is only ever
  // requested for an asset that is actually enabled.
  BNB: 'binancecoin',
  TRX: 'tron',
  ETH: 'ethereum',
  // Bitcoin. Unlike the others this is not optional in practice: BTC is the
  // ONLY asset on its chain, so without an id here every Bitcoin deployment
  // would fail `validateRateConfig` at boot — which is exactly how this entry
  // came to be missing and then found.
  BTC: 'bitcoin',
};

/**
 * Fiat codes this gateway can quote. Restricted to what the provider actually
 * supports; `FIAT_CURRENCIES` selects from this list rather than extending it,
 * so a typo in env produces a boot-time complaint instead of a silent 503 the
 * first time a merchant tries to price in it.
 */
const SUPPORTED_FIAT = new Set([
  'USD', 'EUR', 'INR', 'GBP', 'AED', 'AUD', 'CAD', 'CHF', 'CNY', 'JPY',
  'SGD', 'ZAR', 'BRL', 'NGN', 'RUB', 'TRY', 'KRW', 'MXN', 'IDR', 'PHP',
]);

/** Quotes are rounded at this many decimals — see `quote()` for why. */
const QUOTE_DECIMALS = 6;

/** Internal fixed-point scale for the division. Matches utils/money.ts. */
const CALC_DECIMALS = 18;

const CACHE_KEY = 'rate:v1:snapshot';
const LOCK_KEY = 'rate:v1:refresh-lock';
/** Long enough to cover a slow provider, short enough that a crash self-heals. */
const LOCK_TTL_MS = 15_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** rates[FIAT][SYMBOL] = price of one SYMBOL in FIAT. */
export type RateTable = Record<string, Record<string, string>>;

export interface RateSnapshot {
  rates: RateTable;
  /** Epoch ms when this was fetched UPSTREAM (not when it was read from cache). */
  fetchedAt: number;
  /** 'coingecko' when fresh, 'coingecko:stale' when served past freshness. */
  source: string;
  /** Seconds since the upstream fetch. Zero-ish on a fresh serve. */
  ageSeconds: number;
}

export interface Quote {
  /** Crypto amount to charge, as a decimal string. Rounded UP — see below. */
  amount: string;
  /** Price of one unit of the asset in the fiat currency, as a string. */
  rate: string;
  asset: string;
  fiatCurrency: string;
  fiatAmount: string;
  source: string;
  /** When the underlying rate was fetched upstream. */
  lockedAt: Date;
}

// ---------------------------------------------------------------------------
// Currency allowlist
// ---------------------------------------------------------------------------

let fiatCache: string[] | null = null;

/** Fiat codes this deployment accepts, uppercased and validated. */
export function enabledFiatCurrencies(): string[] {
  if (fiatCache) return fiatCache;
  const listed = config.rates.currencies
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .filter((c) => SUPPORTED_FIAT.has(c));
  // USD is the fallback denomination for everything else in the product (the
  // dashboard's "≈ USD" figures), so it is never absent.
  fiatCache = Array.from(new Set(['USD', ...listed]));
  return fiatCache;
}

/** Test seam, mirroring resetAssetCache(). */
export function resetRateCaches(): void {
  fiatCache = null;
}

/**
 * Parse an untrusted fiat code. Throws a 400 rather than defaulting, because
 * defaulting a currency silently re-denominates someone's price.
 */
export function parseFiat(value: unknown): string {
  const code = String(value ?? '').trim().toUpperCase();
  if (!code) throw AppError.badRequest('A fiat currency is required');
  const enabled = enabledFiatCurrencies();
  if (!enabled.includes(code)) {
    throw AppError.badRequest(
      `Currency "${code}" is not available. Supported: ${enabled.join(', ')}.`,
    );
  }
  return code;
}

/**
 * Boot validation, called alongside validateAssets(). Catches the two
 * misconfigurations that would otherwise surface as a 503 in front of a
 * merchant: an unsupported fiat code, and an enabled asset with no provider id.
 */
export function validateRateConfig(): void {
  const requested = config.rates.currencies
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  for (const code of requested) {
    if (!SUPPORTED_FIAT.has(code)) {
      throw new Error(
        `FIAT_CURRENCIES lists "${code}", which this gateway cannot quote. ` +
          `Supported: ${Array.from(SUPPORTED_FIAT).join(', ')}.`,
      );
    }
  }
  for (const asset of enabledAssets()) {
    if (!COIN_IDS[asset.symbol]) {
      throw new Error(
        `Asset ${asset.network}:${asset.symbol} is enabled but has no exchange-rate ` +
          `id in rateService.COIN_IDS — it could never be priced in fiat.`,
      );
    }
  }
  if (config.rates.freshSeconds > config.rates.maxStaleSeconds) {
    throw new Error(
      'RATE_FRESH_SECONDS must not exceed RATE_MAX_STALE_SECONDS — a rate cannot ' +
        'be stale-servable for less time than it is fresh.',
    );
  }
}

// ---------------------------------------------------------------------------
// Upstream fetch
// ---------------------------------------------------------------------------

/**
 * Render a JSON number as a plain decimal string.
 *
 * JSON.parse gives us a float, and `String()` on a small or large one produces
 * exponent notation ("1e-7") that parseUnits rejects. Everything downstream is
 * decimal-string arithmetic, so normalise at the boundary.
 */
function numToDecimalString(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  const s = String(n);
  if (!s.includes('e') && !s.includes('E')) return s;
  // toFixed caps at 20; CALC_DECIMALS is well inside that.
  return n.toFixed(CALC_DECIMALS).replace(/0+$/, '').replace(/\.$/, '');
}

/** One upstream call covering every enabled asset × every enabled fiat. */
async function fetchUpstream(): Promise<RateTable> {
  const symbols = Array.from(new Set(enabledAssets().map((a) => a.symbol)));
  const ids = Array.from(
    new Set(symbols.map((s) => COIN_IDS[s]).filter(Boolean)),
  );
  const fiats = enabledFiatCurrencies();
  if (ids.length === 0) throw new Error('no priceable assets are enabled');

  const url = new URL(config.rates.providerUrl);
  url.searchParams.set('ids', ids.join(','));
  url.searchParams.set('vs_currencies', fiats.map((f) => f.toLowerCase()).join(','));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.rates.timeoutMs);
  let body: Record<string, Record<string, number>>;
  try {
    const res = await fetch(url.toString(), {
      headers: {
        accept: 'application/json',
        // Only sent when configured. CoinGecko accepts the demo key header on
        // the public host; without it the same endpoint works unauthenticated.
        ...(config.rates.apiKey ? { 'x-cg-demo-api-key': config.rates.apiKey } : {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`provider returned HTTP ${res.status}`);
    }
    body = (await res.json()) as Record<string, Record<string, number>>;
  } finally {
    clearTimeout(timer);
  }

  // Invert provider shape {coinId: {fiat: price}} into {FIAT: {SYMBOL: price}}.
  const table: RateTable = {};
  for (const fiat of fiats) table[fiat] = {};
  for (const symbol of symbols) {
    const id = COIN_IDS[symbol];
    const entry = id ? body[id] : undefined;
    if (!entry) continue;
    for (const fiat of fiats) {
      const value = numToDecimalString(entry[fiat.toLowerCase()]);
      // A missing or nonsensical price is OMITTED, never defaulted. An asset
      // absent from the table cannot be quoted, which is the correct outcome —
      // substituting 1.0 for a stablecoin "because it should be a dollar" is
      // how a depeg becomes a loss.
      if (value) table[fiat][symbol] = value;
    }
  }

  const priced = Object.values(table).some((f) => Object.keys(f).length > 0);
  if (!priced) throw new Error('provider returned no usable prices');
  return table;
}

/** Fetch and cache. Returns the new snapshot. Throws if the provider fails. */
async function refreshAndStore(): Promise<RateSnapshot> {
  const rates = await fetchUpstream();
  const fetchedAt = Date.now();
  const payload = JSON.stringify({ rates, fetchedAt });
  // Held for the FULL stale window, not the freshness window: expiring at
  // freshness would delete exactly the copy the degraded path depends on.
  await redis.set(CACHE_KEY, payload, 'EX', Math.max(60, config.rates.maxStaleSeconds));
  logger.info(
    { fiats: Object.keys(rates).length, assets: Object.keys(rates.USD ?? {}).length },
    'exchange rates refreshed',
  );
  return { rates, fetchedAt, source: 'coingecko', ageSeconds: 0 };
}

/** Read whatever is cached, however old. Null when absent or unparseable. */
async function readCache(): Promise<{ rates: RateTable; fetchedAt: number } | null> {
  try {
    const raw = await redis.get(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { rates: RateTable; fetchedAt: number };
    if (!parsed?.rates || typeof parsed.fetchedAt !== 'number') return null;
    return parsed;
  } catch (err) {
    logger.warn({ err }, 'rate cache unreadable; treating as a miss');
    return null;
  }
}

/** Try to become the one caller that refreshes. */
async function acquireRefreshLock(): Promise<boolean> {
  try {
    const ok = await redis.set(LOCK_KEY, String(process.pid), 'PX', LOCK_TTL_MS, 'NX');
    return ok === 'OK';
  } catch {
    // Redis trouble should not stop a refresh — worst case is a duplicate call.
    return true;
  }
}

async function releaseRefreshLock(): Promise<void> {
  try {
    await redis.del(LOCK_KEY);
  } catch {
    /* the TTL will clear it */
  }
}

/**
 * Refresh without blocking or throwing. Used by the stale path: the caller has
 * already been served, so a failure here is a logged warning and nothing more.
 */
function refreshInBackground(): void {
  void (async () => {
    if (!(await acquireRefreshLock())) return; // someone else is on it
    try {
      await refreshAndStore();
    } catch (err) {
      logger.warn({ err }, 'background rate refresh failed; still serving cached rates');
    } finally {
      await releaseRefreshLock();
    }
  })();
}

/**
 * Refresh with single-flight. A caller that loses the race waits briefly for
 * the winner's result rather than piling another request onto the provider —
 * but fetches anyway if the winner is slow, because one duplicate upstream call
 * is a far better outcome than a failed payment.
 */
async function refreshSingleFlight(): Promise<RateSnapshot> {
  if (await acquireRefreshLock()) {
    try {
      return await refreshAndStore();
    } finally {
      await releaseRefreshLock();
    }
  }

  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const cached = await readCache();
    if (cached) {
      const ageSeconds = Math.max(0, (Date.now() - cached.fetchedAt) / 1000);
      if (ageSeconds <= config.rates.freshSeconds) {
        return { ...cached, source: 'coingecko', ageSeconds };
      }
    }
  }
  return refreshAndStore();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The current rate table, by the three-tier policy in the header.
 *
 * Never returns a rate older than RATE_MAX_STALE_SECONDS. Throws 503 when no
 * rate can be obtained at all.
 */
export async function getRates(): Promise<RateSnapshot> {
  const cached = await readCache();

  if (cached) {
    const ageSeconds = Math.max(0, (Date.now() - cached.fetchedAt) / 1000);

    if (ageSeconds <= config.rates.freshSeconds) {
      return { ...cached, source: 'coingecko', ageSeconds };
    }

    if (ageSeconds <= config.rates.maxStaleSeconds) {
      // THE DEGRADED PATH. Answer immediately from the stale copy and repair
      // the cache behind the caller's back. A provider outage costs the
      // merchant a slightly old price, not a failed checkout.
      refreshInBackground();
      return { ...cached, source: 'coingecko:stale', ageSeconds };
    }

    // Past the stale window. One synchronous attempt, then refuse — serving a
    // day-old rate as current is not a degradation, it is a wrong answer.
    try {
      return await refreshSingleFlight();
    } catch (err) {
      logger.error(
        { err, ageSeconds },
        'rates are beyond the stale window and the provider is unreachable',
      );
      throw AppError.serviceUnavailable(
        'Exchange rates are temporarily unavailable, and the last known rate is ' +
          'too old to quote from. Try again shortly, or price this payment ' +
          'directly in crypto.',
      );
    }
  }

  // Nothing cached at all — cold start, or Redis was flushed.
  try {
    return await refreshSingleFlight();
  } catch (err) {
    logger.error({ err }, 'no cached rates and the provider is unreachable');
    throw AppError.serviceUnavailable(
      'Exchange rates are temporarily unavailable. Try again shortly, or price ' +
        'this payment directly in crypto.',
    );
  }
}

/**
 * Warm the cache at boot so the first fiat-priced payment is not the one that
 * waits.
 *
 * Also REFRESHES rather than merely reading, because boot is exactly when the
 * enabled asset set may have changed — a cached snapshot from before a chain was
 * switched on is valid by age but missing the new asset. (`quote` recovers from
 * that too, but paying for it once at boot is better than on a merchant's first
 * request.)
 */
export async function primeRates(): Promise<void> {
  try {
    const cached = await readCache();
    const known = new Set(Object.keys(cached?.rates?.USD ?? {}));
    const wanted = new Set(enabledAssets().map((a) => a.symbol));
    const missing = [...wanted].filter((s) => !known.has(s));
    if (cached && missing.length > 0) {
      logger.info(
        { missing },
        'cached rates predate the current asset set; refreshing at boot',
      );
      await refreshSingleFlight();
      return;
    }
    await getRates();
  } catch (err) {
    // Explicitly non-fatal: a gateway must boot with the provider down. The
    // first fiat quote will retry, and crypto-priced payments are unaffected.
    logger.warn({ err }, 'could not prime exchange rates at boot; will retry on demand');
  }
}

/**
 * Price a fiat amount in an asset, and return everything needed to freeze the
 * decision onto a payment row.
 *
 * ============================ ROUNDING IS UPWARD =============================
 * The crypto amount is rounded UP at 6 dp. Rounding is unavoidable — a quote of
 * ₹5,000 at 95.09 is an infinite decimal — and the direction is a choice with
 * money on both sides of it:
 *
 *   Rounding DOWN would quote a customer slightly less crypto than the fiat
 *   price, so a payment that confirms in full still leaves the merchant a
 *   fraction short of what they invoiced. Every payment, forever.
 *
 *   Rounding UP overcharges by at most one unit in the sixth decimal — for a
 *   stablecoin, a millionth of a cent. The merchant is never short.
 *
 * Six decimals rather than the asset's own precision because that is the
 * coarsest precision any settled asset has (Tron's stablecoins are 6 dp; BSC's
 * are 18). A quote with more precision than the chain can express would be a
 * quote no customer could pay exactly.
 */
export async function quote(input: {
  asset: string;
  fiatCurrency: string;
  fiatAmount: string;
}): Promise<Quote> {
  const asset = String(input.asset).toUpperCase();
  const fiat = parseFiat(input.fiatCurrency);

  const amountNum = Number(input.fiatAmount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    throw AppError.badRequest('fiatAmount must be a positive number');
  }

  let snapshot = await getRates();
  let rate = snapshot.rates[fiat]?.[asset];

  // ---- The cached snapshot may predate this asset ---------------------------
  // The cache holds one blob for every enabled asset, keyed only by version —
  // not by WHICH assets were enabled when it was written. So enabling a new
  // chain leaves the previous snapshot valid by age but incomplete in
  // composition, and the new asset would be unpriceable until the entry aged
  // out (up to RATE_MAX_STALE_SECONDS — a day).
  //
  // A missing asset is therefore a cache-composition miss, not a provider
  // failure: refetch once before giving up. Costs nothing in the normal case,
  // because the asset is present and this never runs.
  if (!rate) {
    logger.info(
      { asset, fiat },
      'rate snapshot has no entry for this asset; refreshing (a newly enabled ' +
        'chain is not in the cached set)',
    );
    try {
      snapshot = await refreshSingleFlight();
      rate = snapshot.rates[fiat]?.[asset];
    } catch (err) {
      logger.warn({ err, asset }, 'refresh for a missing asset failed');
    }
  }

  if (!rate) {
    throw AppError.serviceUnavailable(
      `No ${fiat} price is available for ${asset} right now. Try again shortly, ` +
        `or price this payment directly in ${asset}.`,
    );
  }

  const rateUnits = parseUnits(rate, CALC_DECIMALS);
  if (rateUnits <= 0n) {
    // Defensive: a zero or negative rate would divide by zero, or worse, quote
    // a free payment. The provider should never produce one.
    throw AppError.serviceUnavailable(
      `The ${fiat} price for ${asset} is not usable right now. Try again shortly.`,
    );
  }

  const fiatUnits = parseUnits(String(input.fiatAmount), CALC_DECIMALS);
  const scale = 10n ** BigInt(CALC_DECIMALS);
  const raw = (fiatUnits * scale) / rateUnits;

  // Ceil at QUOTE_DECIMALS — see the note above on why upward.
  const step = 10n ** BigInt(CALC_DECIMALS - QUOTE_DECIMALS);
  const rounded = ((raw + step - 1n) / step) * step;

  const amount = formatUnits(rounded, CALC_DECIMALS);
  if (Number(amount) <= 0) {
    throw AppError.badRequest(
      `${input.fiatAmount} ${fiat} is too small to charge in ${asset}.`,
    );
  }

  return {
    amount,
    rate,
    asset,
    fiatCurrency: fiat,
    fiatAmount: String(input.fiatAmount),
    source: snapshot.source,
    lockedAt: new Date(snapshot.fetchedAt),
  };
}

/**
 * Approximate fiat value of a crypto amount, for DISPLAY only.
 *
 * Returns null rather than throwing when a rate is unavailable: this feeds
 * dashboard figures that are already labelled approximate, and a missing
 * estimate must never break a page that is otherwise showing real balances.
 * Never use this for anything that determines what someone owes.
 */
export async function estimateFiat(
  asset: string,
  amount: string,
  fiatCurrency: string,
): Promise<string | null> {
  try {
    const fiat = String(fiatCurrency).toUpperCase();
    const snapshot = await getRates();
    const rate = snapshot.rates[fiat]?.[String(asset).toUpperCase()];
    if (!rate) return null;
    const units = parseUnits(String(amount || '0'), CALC_DECIMALS);
    const rateUnits = parseUnits(rate, CALC_DECIMALS);
    const scale = 10n ** BigInt(CALC_DECIMALS);
    return formatUnits((units * rateUnits) / scale, CALC_DECIMALS);
  } catch {
    return null;
  }
}
