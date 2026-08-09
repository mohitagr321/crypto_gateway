/**
 * Structured logging via pino.
 *
 * Secrets are NEVER logged. A redaction list guards against accidental leakage of
 * common secret-bearing fields if they ever make it into a log object.
 */
import pino from 'pino';
import { config } from './env';

export const logger = pino({
  level: config.logLevel,
  base: { service: 'crypto-gateway' },
  redact: {
    paths: [
      'password',
      'passwordHash',
      'password_hash',
      'apiSecret',
      'api_secret',
      'api_secret_hash',
      'mnemonic',
      'privateKey',
      'private_key',
      'encrypted_privkey',
      'webhook_secret',
      'mfa_secret',
      'authorization',
      'req.headers.authorization',
      'req.headers["x-signature"]',
      'req.headers["x-api-key"]',
    ],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

export type Logger = typeof logger;
