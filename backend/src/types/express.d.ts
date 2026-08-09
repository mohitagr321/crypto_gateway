/**
 * Express Request augmentation shared across middleware.
 */
import 'express';

declare global {
  namespace Express {
    interface AuthedClient {
      apiKeyId: string | null;
      clientId: string;
      businessName: string;
      status: string;
      /**
       * How this request authenticated:
       *   'hmac'      — signed API request (X-Timestamp + X-Signature)
       *   'simple'    — plain bearer token in X-Api-Key
       *   'dashboard' — logged-in panel session (JWT), no API key involved
       * `requireDashboardSession` gates the routes only a human session may hit.
       */
      authMode: 'hmac' | 'simple' | 'dashboard';
      /**
       * What this credential may do. A dashboard session carries every scope —
       * the user is already authenticated as the account owner.
       */
      scopes: string[];
    }
    interface AuthedUser {
      userId: string;
      role: string;
      email: string;
    }
    interface Request {
      /** Raw request body captured for HMAC verification (see index.ts json verify). */
      rawBody?: Buffer;
      /** Populated by merchantAuth. */
      client?: AuthedClient;
      /** Populated by jwtAuth. */
      user?: AuthedUser;
    }
  }
}

export {};
