/**
 * API server entrypoint.
 *
 * IMPORTANT: JSON bodies are parsed with a `verify` hook that captures the raw
 * bytes into req.rawBody. The merchant HMAC signature is computed over the RAW
 * body, so this must run before any body transformation.
 */
// Note: the Express Request augmentation in ./types/express.d.ts is ambient and
// picked up via tsconfig `include` — it must NOT be imported at runtime (it has
// no JS output, so Node would throw MODULE_NOT_FOUND).
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config } from './config/env';
import { logger } from './config/logger';
import { globalRateLimiter } from './middleware/rateLimit';
import { buildRouter, mountDocs } from './routes';
import { errorHandler, notFoundHandler } from './utils/apiError';
import { scheduleExpiryJob } from './workers/queues';
import { closePool } from './db/pool';
import { closeRedis } from './db/redis';
import { validateAssets } from './blockchain/assets';
import { describeMailTransport } from './services/emailService';
import { primeRates, validateRateConfig } from './services/rateService';

const app = express();

// Behind a proxy/load balancer -> trust X-Forwarded-* for correct req.ip.
//
// The literal 1 means "exactly one proxy hop", which matches the single Apache
// reverse proxy the deploy script writes, and it is the safe direction to be
// wrong in: too LOW and req.ip degrades to a proxy address, too HIGH and a
// client can forge X-Forwarded-For and pick its own rate-limit bucket. Every
// IP-keyed limiter in middleware/rateLimit.ts depends on this number, so if a
// second hop is ever put in front (a CDN, a cloud load balancer), raise it to
// the real hop count in the same change — leaving it at 1 collapses the whole
// internet into one shared bucket rather than merely mis-attributing it.
app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin: true,
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Api-Key',
      'X-Timestamp',
      'X-Signature',
      'Idempotency-Key',
    ],
  }),
);

// Capture raw body for HMAC verification.
app.use(
  express.json({
    limit: '256kb',
    verify: (req, _res, buf) => {
      (req as express.Request).rawBody = Buffer.from(buf);
    },
  }),
);

// Health check — MOUNTED ABOVE THE RATE LIMITER ON PURPOSE.
//
// An orchestrator probes from one fixed address that, on a busy node, is also
// carrying real traffic. Underneath the limiter the probe spends the same
// per-IP budget as that traffic, so a burst 429s the probe and the balancer
// responds by pulling a perfectly healthy instance out of rotation — shifting
// its load onto the survivors, which then burst harder. Registering the route
// first means no store is consulted at all, so this endpoint also keeps
// answering while Redis is down. (middleware/rateLimit.ts additionally skips
// /health, so this stays correct if the order is ever disturbed.)
//
// Deliberately does no I/O: it reports that this PROCESS is up and serving.
// Wiring a Redis or Postgres check in here would hand a single dependency blip
// the power to mark every instance dead at once, which is the same failure this
// ordering exists to prevent. Dependency health belongs on a separate,
// non-orchestrator-facing endpoint.
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'crypto-gateway', ts: Date.now() });
});

app.use(globalRateLimiter);

// Docs.
mountDocs(app);

// API.
app.use('/api/v1', buildRouter());

// 404 + error handling (order matters).
app.use(notFoundHandler);
app.use(errorHandler);

async function start(): Promise<void> {
  // Fail fast on a bad asset or rate configuration, in the same spirit as the
  // wallet guards in config/env.ts: a wrong contract address or an unquotable
  // currency must surface at boot, not in front of a merchant with money on the
  // line. (validateAssets already existed but nothing invoked it.)
  try {
    validateAssets();
    validateRateConfig();
  } catch (err) {
    logger.error({ err }, 'invalid asset/rate configuration — refusing to start');
    process.exit(1);
  }

  // Warm the rate cache so the first fiat-priced payment is not the one that
  // pays for the cold start. Deliberately non-fatal — see primeRates.
  void primeRates();

  // Register the repeatable expiry job so expired payments get swept even if the
  // worker was the only process that previously scheduled it.
  try {
    await scheduleExpiryJob();
  } catch (err) {
    logger.warn({ err }, 'failed to schedule expiry job at boot (worker may schedule it)');
  }

  const server = app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        env: config.nodeEnv,
        // "No verification email arrived" is nearly always this line saying
        // 'log' on a box nobody meant to leave unconfigured.
        mail: describeMailTransport(),
      },
      'API listening',
    );
  });

  // Handle listen errors (esp. EADDRINUSE) with a clear message instead of an
  // unhandled 'error' event crash. Exit non-zero so a supervisor can react.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(
        { port: config.port },
        `Port ${config.port} is already in use. Stop the process using it ` +
          `(e.g. lsof -nP -iTCP:${config.port} -sTCP:LISTEN) or set PORT to a free port.`,
      );
    } else {
      logger.error({ err }, 'HTTP server error');
    }
    process.exit(1);
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down API');
    server.close(async () => {
      await Promise.allSettled([closePool(), closeRedis()]);
      process.exit(0);
    });
    // Force-exit if graceful shutdown hangs.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void start();

export { app };
