/**
 * Envelope encryption + HMAC helpers.
 *
 * All at-rest secrets (HD mnemonic, MFA TOTP secret, per-client webhook secret,
 * per-key API secret, hot wallet private keys) are encrypted with AES-256-GCM
 * using MASTER_ENCRYPTION_KEY (32 bytes, sourced from KMS in production).
 *
 * Ciphertext format: "iv:tag:ciphertext", all hex.
 *   iv  = 12-byte random nonce
 *   tag = 16-byte GCM auth tag
 */
import crypto from 'crypto';
import { config } from '../config/env';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

// 32-byte key derived from the 64 hex chars validated in env.ts.
const KEY = Buffer.from(config.masterEncryptionKey, 'hex');

/**
 * Encrypt a UTF-8 string. Returns "iv:tag:ciphertext" (hex).
 */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

/**
 * Decrypt an "iv:tag:ciphertext" (hex) envelope back to the original string.
 * Throws if the payload is malformed or the auth tag does not verify.
 */
export function decrypt(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('malformed ciphertext envelope');
  }
  const [ivHex, tagHex, ctHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

/**
 * HMAC-SHA256 of `message` under `secret`, hex-encoded.
 * Used for both the inbound merchant request signature and the outbound
 * webhook signature so the schemes stay symmetric and reviewable.
 */
export function hmacSha256(secret: string, message: string): string {
  return crypto.createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two hex strings (or arbitrary equal-length strings).
 * Returns false (never throws) on length mismatch to avoid leaking length via timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Compare against self to keep timing roughly constant, then fail.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Cryptographically-strong random token, hex-encoded (default 32 bytes = 64 chars).
 */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * SHA-256 of a string, hex-encoded.
 *
 * Used for credentials the server only ever needs to RECOGNISE, never read back:
 * simple-mode API bearer tokens and the single-use email/password-reset tokens.
 * Those are stored hashed rather than envelope-encrypted (which is what
 * `api_secret_hash` uses) precisely because nothing needs to recover the
 * plaintext — see the design note in middleware/auth.ts for the contrast.
 *
 * A plain digest is correct here and bcrypt is not: these are 32-byte random
 * values, not user-chosen passwords, so there is no search space to slow down.
 */
export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
