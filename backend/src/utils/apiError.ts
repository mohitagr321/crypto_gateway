/**
 * Typed application error + Express error-handling middleware.
 *
 * The response body always matches the OpenAPI `Error` schema:
 *   { error: string, message: string }
 */
import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { logger } from '../config/logger';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, AppError.prototype);
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError(400, 'bad_request', message, details);
  }
  static unauthorized(message = 'Unauthorized'): AppError {
    return new AppError(401, 'unauthorized', message);
  }
  static forbidden(message = 'Forbidden'): AppError {
    return new AppError(403, 'forbidden', message);
  }
  static notFound(message = 'Not found'): AppError {
    return new AppError(404, 'not_found', message);
  }
  static conflict(message: string): AppError {
    return new AppError(409, 'conflict', message);
  }
  static tooManyRequests(message = 'Too many requests'): AppError {
    return new AppError(429, 'rate_limited', message);
  }
  static internal(message = 'Internal server error'): AppError {
    return new AppError(500, 'internal_error', message);
  }
  /**
   * A dependency this request needed is down, and the request is worth retrying
   * unchanged. Distinct from `internal`: nothing is wrong with what the caller
   * sent. Used when an exchange rate cannot be obtained at all — quoting a
   * fiat-priced payment from a made-up number is worse than refusing it.
   */
  static serviceUnavailable(message: string): AppError {
    return new AppError(503, 'service_unavailable', message);
  }
}

/** Express async handler wrapper so thrown/rejected errors reach the error middleware. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error({ err, path: req.path }, err.message);
    } else {
      logger.warn({ code: err.code, path: req.path }, err.message);
    }
    res.status(err.statusCode).json({ error: err.code, message: err.message });
    return;
  }

  if (err instanceof ZodError) {
    const message = err.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    res.status(400).json({ error: 'validation_error', message });
    return;
  }

  // Postgres unique-violation -> 409.
  if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
    res.status(409).json({ error: 'conflict', message: 'Resource already exists' });
    return;
  }

  logger.error({ err, path: req.path }, 'unhandled error');
  res.status(500).json({ error: 'internal_error', message: 'Internal server error' });
}

/** 404 fallthrough for unmatched routes. */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: 'not_found', message: 'Route not found' });
}
