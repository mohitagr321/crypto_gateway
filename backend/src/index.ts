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
import type { Server } from 'node:http';
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

// NOTE ON NON-JSON BODIES. This `verify` hook runs only for application/json,
// so req.rawBody stays undefined for any other Content-Type. That is closed
// where it matters — middleware/auth.ts FAILS CLOSED when a request declares a
// body that was not captured, rather than signing the empty string — and it is
// deliberately not papered over here with a catch-all express.raw(): mounting
// one would turn req.body into a Buffer for every non-JSON request in the
// system to protect a value nothing outside the HMAC verifier reads.

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

/**
 * The live HTTP server, published at module scope so the process-level fault
 * handlers below can drain it. Null until `start()` has called listen.
 */
let httpServer: Server | null = null;

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
  //
  // NOT awaited on the boot path, and bounded. When Redis is unreachable a
  // BullMQ `add()` does not reject — it awaits a connection that ioredis retries
  // forever, so it never settles either way and the try/catch that used to wrap
  // this could not fire. Awaiting it therefore parked the boot BEFORE
  // app.listen(), which means a Redis outage took the entire API down — /health
  // included — instead of degrading the one feature that needs Redis. The job is
  // registered by a fixed jobId and the worker schedules the same one, so
  // missing this call costs nothing but a later first registration.
  const SCHEDULE_TIMEOUT_MS = 10_000;
  void Promise.race([
    scheduleExpiryJob(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error('timed out scheduling the expiry job — is Redis reachable?')),
        SCHEDULE_TIMEOUT_MS,
      ).unref();
    }),
  ]).catch((err: unknown) => {
    logger.warn({ err }, 'failed to schedule expiry job at boot (worker may schedule it)');
  });

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
  httpServer = server;

  // SOCKET TIMEOUTS. Node's defaults leave a slow or half-open client holding a
  // socket indefinitely, and the keep-alive default (5s) sits BELOW the idle
  // timeout of everything that fronts this API — 60s on the Apache reverse proxy
  // the deploy script writes, 60s on an AWS ALB. That ordering is the classic
  // source of sporadic, unreproducible 502s: the proxy reuses a connection in
  // the same instant the server decides to close it. keepAliveTimeout must
  // therefore EXCEED the proxy's idle timeout, and headersTimeout must exceed
  // keepAliveTimeout or the keep-alive window is cut short by the header clock.
  // requestTimeout bounds only the RECEIPT of a request (headers plus body, and
  // the body is capped at 256kb above) — it does not bound how long a handler
  // may take to respond, so it cannot cut off a slow payout.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;

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

// ===================== PROCESS-LEVEL FAULT HANDLERS =========================
// Every listener process installs these; the API and the worker did not, so a
// fault here was terminated by Node's default with a raw stack on stderr — no
// pino level, no `service` field, no redaction — which means the one line that
// explains a restart is the one line log aggregation cannot see.
//
// The disposition is "log fatally, then exit", NOT the listeners' "log and keep
// going". That is deliberate and it is not a behaviour change: Node already
// terminates on both of these (Node 24 defaults to --unhandled-rejections=throw),
// so this adds the structured line and, for uncaughtException, a drain — it does
// not keep a process alive that would previously have died. Continuing is the
// wrong call for this process specifically: every intentional fire-and-forget in
// the codebase carries its own .catch(), so anything arriving here is by
// definition unanticipated, and an API that keeps serving money endpoints from
// unknown state is worse than one a supervisor restarts.
//
// Registered before start() so a fault during boot is reported the same way.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'unhandledRejection — exiting for restart');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException — draining and exiting');
  const server = httpServer;
  if (!server) process.exit(1);
  // Let in-flight requests finish rather than cutting a merchant's POST
  // mid-response, then exit non-zero for the supervisor. Same 10s force-exit
  // budget as the SIGTERM path in start(), and unref'd for the same reason.
  server.close(() => process.exit(1));
  setTimeout(() => process.exit(1), 10_000).unref();
});

void start();

export { app };
