/**
 * Rate limiting via express-rate-limit, backed by Redis — with a deliberate,
 * loud degraded mode for when Redis is not there.
 *
 * WHAT WAS WRONG. The comment that used to sit here claimed we "fall back to
 * the in-memory store so the API still boots (with a warning) rather than
 * crashing". It did not, and structurally could not: the try/catch below only
 * ever wrapped the SYNCHRONOUS `new RedisStore(...)`, and that constructor does
 * not throw when Redis is unreachable. It fires two `SCRIPT LOAD`s and parks
 * the promises on the instance (`incrementScriptSha`, `getScriptSha`).
 * `getScriptSha` is only ever awaited by `store.get()`, which this middleware
 * never calls — it calls `increment` — so when ioredis gave up after
 * `maxRetriesPerRequest` nothing anywhere held a handler for that rejection.
 * Node's default for an unhandled rejection is to terminate, and the API
 * registers no process-level handler, so the whole process died ~4s after boot,
 * seven times over (one store per limiter, all built at module load). Under PM2
 * that is a crash loop for the full duration of the outage, with /health
 * unreachable rather than merely degraded — strictly worse than the 500s the
 * old comment was worried about.
 *
 * WHAT WE DO INSTEAD, AND WHY. Rate limiting is a security control, so the two
 * obvious answers are both wrong here:
 *   - failing CLOSED turns a Redis blip into a total gateway outage. On-chain
 *     money keeps being credited (the listener is a separate process and does
 *     not touch these limiters), but no merchant can create a payment and no
 *     checkout page can poll a status while a customer is mid-payment. For a
 *     system that moves other people's money that is the worse failure.
 *   - failing OPEN silently hands /auth/login a free window for credential
 *     stuffing, and lets the public checkout write path burn the HD derivation
 *     counter unthrottled, with nothing in the logs to say it happened.
 *
 * So we fail open ONTO A REAL LIMITER. Every store keeps a per-process
 * MemoryStore in reserve and switches to it the moment a Redis command fails or
 * times out. The ceiling is then per-process instead of per-cluster — N api
 * instances make it N times looser than configured — which is worse than Redis
 * and enormously better than nothing: one abusive IP still meets roughly the
 * configured rate on whichever instance it lands on. Entering and leaving that
 * mode is logged at ERROR with the store prefix, so the degradation shows up in
 * the first second rather than being inferred later from an abuse report.
 *
 * NOTE: this file can only make the limiter survive a Redis outage. It cannot
 * make the API survive one on its own — see the notes on `redis.ts` /
 * `index.ts` in the audit (offline queue, command timeout, a process-level
 * unhandledRejection handler, and a Redis probe on /health).
 *
 * WHERE THE COUNTERS LIVE. Confirmed, because it changes what every number in
 * this file means: in the steady state every limiter below is REDIS-backed
 * (`rate-limit-redis` over the single shared ioredis client in `db/redis.ts`),
 * so a limit is a CLUSTER-wide budget no matter how many api processes are
 * running. The per-process MemoryStore is reached only while `ResilientStore`
 * is degraded, and while it is, each ceiling is effectively multiplied by the
 * number of api processes — which is precisely why entering that mode is logged
 * at ERROR rather than swallowed.
 *
 * WHAT THE GLOBAL LIMITER IS FOR. It is a coarse per-IP ABUSE ceiling and
 * nothing else. It used to be the only limiter with real teeth (120/min/IP, in
 * front of every route including /health) and that made it the first thing to
 * reject legitimate traffic: the deliberate 600/min per-API-key budget was
 * unreachable underneath a 120/min per-IP one, every merchant behind a single
 * NAT egress shared one bucket, and a load balancer's health probe spent the
 * same budget as customer traffic — so a busy instance could be probed into
 * being declared dead. See `GLOBAL_ABUSE_CEILING` and `isHealthProbe` below.
 */
import rateLimit, { MemoryStore, Options, Store, ClientRateLimitInfo } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { config } from '../config/env';
import { logger } from '../config/logger';
import { redis } from '../db/redis';

/**
 * How long a single Redis command may hang before we treat it as failed.
 *
 * EVALSHA against a healthy Redis is sub-millisecond, so a second is enormously
 * generous for the happy path. It exists for the UNhealthy path: ioredis queues
 * commands while the connection is down, and without a ceiling every one of
 * 1,000 concurrent requests parks on a queued command instead of being served
 * by the fallback store.
 */
const REDIS_COMMAND_TIMEOUT_MS = 1_000;

/**
 * Once degraded, don't re-probe Redis on every request — at 1,000 concurrent
 * that is 1,000 requests each paying the timeout above. One probe every few
 * seconds is enough to notice recovery quickly while everything else goes
 * straight to the local store.
 */
const REDIS_PROBE_INTERVAL_MS = 5_000;

/** Ceiling on how often a store repeats its "still degraded" line. */
const DEGRADED_LOG_INTERVAL_MS = 30_000;

/**
 * Send one raw command to the shared client, with a hard deadline.
 *
 * The loser of the race must not be left to reject on its own — that is exactly
 * the unhandled rejection this whole file exists to stop — so the underlying
 * promise gets a no-op handler attached before the race is set up.
 */
function sendCommand(command: string, ...args: string[]): Promise<never> {
  // ioredis: use call() to send raw commands as rate-limit-redis expects.
  const call = redis.call(command, ...args) as Promise<never>;
  call.catch(() => {
    /* handled by the race below, or discarded if the deadline won */
  });

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`redis command ${command} exceeded ${REDIS_COMMAND_TIMEOUT_MS}ms`)),
      REDIS_COMMAND_TIMEOUT_MS,
    );
    // Never hold the process open on a rate-limit command.
    timer.unref?.();
  });

  return Promise.race([call, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<never>;
}

/**
 * A Redis-backed store that degrades to a per-process one instead of throwing.
 *
 * express-rate-limit's own `passOnStoreError` degradation is all-or-nothing:
 * the request is waved through with no counting at all. This sits in front of
 * that and keeps counting locally, so an outage costs us cluster-wide accuracy
 * rather than the control itself.
 */
class ResilientStore implements Store {
  /** Exposed because the ERR_ERL_DOUBLE_COUNT validation disambiguates stores by prefix. */
  readonly prefix: string;

  /** The steady state is Redis, which is shared across api instances. */
  readonly localKeys = false;

  private readonly redisStore: Store;

  private options?: Options;

  private memoryStore?: MemoryStore;

  private degraded = false;

  private probeAfter = 0;

  private failuresSinceLog = 0;

  private lastLogAt = 0;

  constructor(redisStore: Store, prefix: string) {
    this.redisStore = redisStore;
    this.prefix = prefix;
  }

  init(options: Options): void {
    this.options = options;
    this.redisStore.init?.(options);
    // The MemoryStore is built on first failure rather than here: it starts an
    // interval timer, and there is no reason for seven of them to exist for the
    // entire life of a process whose Redis is perfectly healthy.
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    if (this.skipRedis()) return this.memory().increment(key);
    try {
      const info = await this.redisStore.increment(key);
      this.noteHealthy();
      return info;
    } catch (err) {
      this.noteFailure(err);
      return this.memory().increment(key);
    }
  }

  async decrement(key: string): Promise<void> {
    if (this.skipRedis()) {
      await this.memory().decrement(key);
      return;
    }
    try {
      await this.redisStore.decrement(key);
      this.noteHealthy();
    } catch (err) {
      this.noteFailure(err);
      await this.memory().decrement(key);
    }
  }

  async resetKey(key: string): Promise<void> {
    if (this.skipRedis()) {
      await this.memory().resetKey(key);
      return;
    }
    try {
      await this.redisStore.resetKey(key);
      this.noteHealthy();
    } catch (err) {
      this.noteFailure(err);
      await this.memory().resetKey(key);
    }
  }

  /**
   * Only reachable via `middleware.getKey`, which nothing in this codebase
   * calls today. Kept so wrapping the store does not quietly remove a method
   * the store used to have.
   */
  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    if (this.skipRedis()) return this.memory().get(key);
    try {
      const info = await this.redisStore.get?.(key);
      this.noteHealthy();
      return info;
    } catch (err) {
      this.noteFailure(err);
      return this.memory().get(key);
    }
  }

  private skipRedis(): boolean {
    return this.degraded && Date.now() < this.probeAfter;
  }

  private memory(): MemoryStore {
    if (!this.memoryStore) {
      const store = new MemoryStore();
      // `init` is always called by express-rate-limit before any request
      // reaches us; the fallback window is there so a MemoryStore can never end
      // up with windowMs undefined and reset its counters on every single hit —
      // that would be the silent fail-open this design is trying to avoid.
      store.init(this.options ?? ({ windowMs: 60_000 } as Options));
      this.memoryStore = store;
    }
    return this.memoryStore;
  }

  private noteFailure(err: unknown): void {
    const now = Date.now();
    const entering = !this.degraded;
    this.degraded = true;
    this.probeAfter = now + REDIS_PROBE_INTERVAL_MS;
    this.failuresSinceLog += 1;

    if (entering || now - this.lastLogAt >= DEGRADED_LOG_INTERVAL_MS) {
      logger.error(
        { err, prefix: this.prefix, failures: this.failuresSinceLog },
        'rate limiter DEGRADED: redis unreachable, counting in this process only. ' +
          'Limits are now per-api-process and therefore looser than configured.',
      );
      this.lastLogAt = now;
      this.failuresSinceLog = 0;
    }
  }

  private noteHealthy(): void {
    if (!this.degraded) return;
    this.degraded = false;
    this.probeAfter = 0;
    this.failuresSinceLog = 0;
    // Warn, not error: this is the all-clear, and an operator alerting on ERROR
    // should not be paged by a recovery. It is still logged, because "when did
    // the window stop being cluster-wide" is the first question asked after an
    // abuse report that lands during an outage.
    logger.warn(
      { prefix: this.prefix },
      'rate limiter RECOVERED: redis reachable again, limits are cluster-wide once more',
    );
    // Drop the local counters. They cannot be merged into Redis, and holding
    // them costs memory for a window that no longer means anything.
    void this.memoryStore?.resetAll();
  }
}

function buildStore(prefix: string): Store {
  try {
    const store = new RedisStore({
      sendCommand: (command: string, ...args: string[]) => sendCommand(command, ...args),
      prefix,
    });

    // THE CRASH. rate-limit-redis fires both SCRIPT LOADs inside its
    // constructor and keeps the promises as fields. Nothing awaits
    // `getScriptSha` on this path, so with Redis down it rejects with no
    // handler and takes the process out. Attaching a handler here defuses that
    // without changing the store's behaviour: `retryableIncrement` reassigns
    // `incrementScriptSha = loadIncrementScript(key)` in its own catch and
    // awaits the new promise immediately, so the store still self-heals the
    // moment Redis comes back.
    store.incrementScriptSha.catch((err: unknown) =>
      logger.error({ err, prefix }, 'rate limiter: redis SCRIPT LOAD failed at startup (increment)'),
    );
    store.getScriptSha.catch((err: unknown) =>
      logger.error({ err, prefix }, 'rate limiter: redis SCRIPT LOAD failed at startup (get)'),
    );

    return new ResilientStore(store as unknown as Store, prefix);
  } catch (err) {
    // Only reachable on a malformed options object, not on an outage — but if
    // it ever fires we still want a limiter rather than none, so return the
    // per-process store directly and say so at ERROR, not warn.
    logger.error(
      { err, prefix },
      'rate limiter: could not construct the redis store; using a per-process memory store for the life of this process',
    );
    return new MemoryStore();
  }
}

/**
 * Fail-open is the last line, below the ResilientStore.
 *
 * The store above should never throw — a Redis failure lands in the local
 * MemoryStore instead. If something below it does throw anyway, express-rate-
 * limit's default is to surface a 500 for the request, which for the global
 * limiter means the entire API returns 500 including /health. Passing the
 * request through unthrottled and logging it is the lesser harm for a payment
 * gateway; it is set on every limiter deliberately, not selectively, so there
 * is no route where an internal limiter error is a customer-visible outage.
 */
const failOpen = { passOnStoreError: true } as const;

/**
 * Liveness/readiness probes are never rate limited.
 *
 * An orchestrator or load balancer probes on a fixed schedule from a fixed
 * address, and on a busy node that address is also carrying real traffic. If
 * the probe shares a bucket with that traffic, the first thing a burst does is
 * 429 the probe — and the balancer's answer to a 429 is to take a HEALTHY
 * instance out of rotation, moving its load onto the remaining ones, which then
 * burst harder. That is a self-amplifying outage caused entirely by the
 * limiter. /health does no I/O (see index.ts), so there is nothing here worth
 * protecting with a counter.
 *
 * index.ts also registers /health ABOVE this middleware, so in practice the
 * predicate never fires. It is kept because "the limiter is in front of
 * everything" is a one-line change away from being true again, and this is the
 * cheap belt-and-braces half of the fix.
 *
 * Matched case-insensitively and with an optional trailing slash because
 * Express routing is case-insensitive and strict routing is off by default, so
 * `/Health/` reaches the same handler.
 */
function isHealthProbe(req: { path?: string; originalUrl?: string }): boolean {
  const raw = (req.path ?? req.originalUrl ?? '').split('?')[0].toLowerCase();
  const path = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
  return path === '/health';
}

/**
 * The global limiter's real ceiling — deliberately NOT `config.rateLimit.max`
 * on its own.
 *
 * This limiter is keyed on the client IP (express-rate-limit's default key; no
 * override, so IPv6 normalisation stays with the library). An IP key is the
 * wrong shape for almost all of this system's traffic — merchant integrations
 * arrive from one or two server addresses, and checkout customers arrive from
 * carrier CGNAT — so it can only ever be an anti-abuse backstop. The per-caller
 * policy is the job of the limiters that can actually see a principal:
 * `apiKeyRateLimiter` (per API key), `invoiceSendLimiter` (per client),
 * `authRateLimiter` / `signupRateLimiter` / `checkoutWriteLimiter` (tight, per
 * route). Those run AFTER this one, and a later limiter can never loosen an
 * earlier one — so if this ceiling sits below theirs, theirs are dead letters.
 *
 * Hence the floor: whatever RATE_LIMIT_MAX says, the global ceiling is at least
 * five API keys' worth of the per-key budget in the same window. Five, so that
 * a handful of merchants sharing one NAT egress can each still reach the
 * per-key allowance the product sold them, and so the number moves with
 * API_KEY_RATE_LIMIT_MAX instead of silently going stale next to it. A larger
 * RATE_LIMIT_MAX is always honoured — the floor only ever raises.
 *
 * Deployed .env files still carry RATE_LIMIT_MAX=120 from when this was the
 * only limiter in the system; at 120/min/IP the 600/min per-key budget is
 * arithmetically unreachable and a single merchant integration is capped at 2
 * req/s. Overriding config is not something to do quietly, so the override is
 * logged at WARN at boot with the variable to set.
 */
const GLOBAL_ABUSE_CEILING = Math.max(
  config.rateLimit.max,
  Math.max(3000, config.rateLimit.apiKeyMax * 5),
);

if (GLOBAL_ABUSE_CEILING !== config.rateLimit.max) {
  logger.warn(
    {
      configured: config.rateLimit.max,
      applied: GLOBAL_ABUSE_CEILING,
      windowMs: config.rateLimit.windowMs,
      apiKeyMax: config.rateLimit.apiKeyMax,
    },
    'global rate limiter: RATE_LIMIT_MAX is below the per-IP abuse floor and would cap ' +
      'API_KEY_RATE_LIMIT_MAX before it could ever apply; raising it for this process. ' +
      'Set RATE_LIMIT_MAX at or above the applied value to silence this — it is a per-IP ' +
      'anti-abuse ceiling, not the per-merchant budget.',
  );
}

/**
 * Global limiter applied to the whole API.
 *
 * Note what is deliberately NOT here: a `skip` for requests that merely CARRY
 * an X-Api-Key or Authorization header. Skipping on the presence of a header
 * would let any caller opt out of the only limiter that runs before
 * authentication just by sending a junk credential, which turns this into a
 * no-op for exactly the traffic it exists to stop and points unbounded 401s at
 * the database. The header is not evidence of anything until `merchantAuth`
 * has checked it, and that runs later. So every request is counted, and the
 * ceiling is sized so that counting them costs legitimate traffic nothing.
 */
export const globalRateLimiter = rateLimit({
  ...failOpen,
  windowMs: config.rateLimit.windowMs,
  max: GLOBAL_ABUSE_CEILING,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('rl:global:'),
  skip: (req) => isHealthProbe(req),
  message: { error: 'rate_limited', message: 'Too many requests' },
});

/**
 * Login/refresh attempts allowed per IP per window.
 *
 * DELIBERATELY DECOUPLED FROM A RAISED `RATE_LIMIT_MAX`. This used to be a
 * straight `floor(config.rateLimit.max / 12)`, which was harmless only because
 * RATE_LIMIT_MAX was the global per-IP ceiling and therefore small (120 -> 10
 * attempts/min). Now that the global limiter has its own abuse floor and warns
 * the operator to raise RATE_LIMIT_MAX to match it, that divisor became a trap:
 * following the boot warning and setting RATE_LIMIT_MAX=3000 would silently
 * take the credential-stuffing ceiling from 10 attempts/min to 250 — a 25x
 * weakening of a security control as a side effect of a throughput setting,
 * with nothing in the logs to say it happened.
 *
 * So the divisor is applied to a fixed baseline, not to whatever the global
 * ceiling has grown to. The one direction still honoured is TIGHTENING: an
 * operator who lowers RATE_LIMIT_MAX below the baseline still lowers this
 * (identical arithmetic to before for any value <= the baseline), because
 * "turn everything down" must keep working. Raising it no longer moves this.
 */
const AUTH_LIMIT_BASE = 120;
const AUTH_ATTEMPTS_PER_WINDOW = Math.max(
  5,
  Math.floor(Math.min(config.rateLimit.max, AUTH_LIMIT_BASE) / 12),
);

/** Tighter limiter for auth/login to blunt credential stuffing. */
export const authRateLimiter = rateLimit({
  ...failOpen,
  windowMs: config.rateLimit.windowMs,
  max: AUTH_ATTEMPTS_PER_WINDOW,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('rl:auth:'),
  message: { error: 'rate_limited', message: 'Too many login attempts' },
});

/**
 * Signup / verification / password-reset limiter — per IP, per HOUR.
 *
 * Much tighter than the others because these routes send email to an
 * attacker-chosen address: unthrottled they are a spam relay and a way to
 * enumerate accounts by timing. An hour window (rather than the global minute
 * one) is what makes a handful of attempts a meaningful ceiling.
 */
export const signupRateLimiter = rateLimit({
  ...failOpen,
  windowMs: 60 * 60 * 1000,
  max: config.rateLimit.signupMax,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('rl:signup:'),
  message: {
    error: 'rate_limited',
    message: 'Too many attempts from this address. Try again in an hour.',
  },
});

/**
 * PUBLIC checkout — read paths (resolve a link, poll a payment status).
 *
 * Generous on purpose: the checkout page polls the status endpoint every few
 * seconds while a customer waits for confirmations, and several customers can
 * legitimately sit behind one NAT. Too tight here breaks a paying customer's
 * page mid-payment, which is far worse than the abuse it would prevent.
 */
export const checkoutReadLimiter = rateLimit({
  ...failOpen,
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('rl:checkout:read:'),
  message: { error: 'rate_limited', message: 'Too many requests. Please wait a moment.' },
});

/**
 * PUBLIC checkout — write path (starting a payment).
 *
 * Much tighter: each call derives an HD address and writes rows, so unthrottled
 * it is a cheap way to burn the derivation counter and fill the payments table
 * from the open internet. A real customer starts one payment, occasionally two.
 */
export const checkoutWriteLimiter = rateLimit({
  ...failOpen,
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('rl:checkout:write:'),
  message: {
    error: 'rate_limited',
    message: 'Too many payment attempts. Please wait a minute and try again.',
  },
});

/**
 * Sending an invoice by email — per MERCHANT, per hour.
 *
 * This is the only route in the system that sends mail to an address the caller
 * chooses, with content the caller writes. Unbounded, that is a spam relay
 * wearing this gateway's domain and reputation, and the first anyone would know
 * is when delivery starts failing for real merchants too.
 *
 * Keyed on the client id rather than the IP: a merchant's own server is one
 * address, and several merchants can sit behind one. The ceiling is generous
 * enough for a real billing run (a hundred invoices an hour) and far below what
 * a relay would need.
 */
export const invoiceSendLimiter = rateLimit({
  ...failOpen,
  windowMs: 60 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('rl:invoice:send:'),
  keyGenerator: (req) => req.client?.clientId ?? `ip:${req.ip}`,
  message: {
    error: 'rate_limited',
    message:
      'Too many invoices sent in the last hour. They are still saved — wait and send the rest.',
  },
});

/**
 * Per-API-key limiter for the merchant REST API.
 *
 * Keyed on the authenticated key id, NOT the IP — server-to-server traffic all
 * arrives from a handful of addresses, so an IP limit either throttles a busy
 * merchant or lets a leaked key run unbounded. Must be mounted AFTER
 * `merchantAuth` so `req.client.apiKeyId` is populated; requests without one
 * (dashboard JWT sessions) fall through to the global limiter untouched.
 */
export const apiKeyRateLimiter = rateLimit({
  ...failOpen,
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.apiKeyMax,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('rl:key:'),
  keyGenerator: (req) => req.client?.apiKeyId ?? `ip:${req.ip}`,
  skip: (req) => !req.client?.apiKeyId,
  message: {
    error: 'rate_limited',
    message: 'Too many requests for this API key',
  },
});
