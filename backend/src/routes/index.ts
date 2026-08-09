/**
 * Route mounting. Everything lives under /api/v1 to match the OpenAPI servers.
 * Also exposes GET /health and serves the OpenAPI docs at /docs.
 */
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import swaggerUi from 'swagger-ui-express';
import authRoutes from './auth';
import registerRoutes from './register';
import paymentRoutes from './payments';
import payoutRoutes from './payouts';
import accountRoutes from './account';
import adminRoutes from './admin';
import { merchantLinkRouter, publicCheckoutRouter } from './paymentLinks';
import invoiceRoutes from './invoices';
import subscriptionRoutes from './subscriptions';
import { enabledNetworks } from '../blockchain/networks';
import { assetCatalogue } from '../blockchain/assets';
import { enabledFiatCurrencies, getRates } from '../services/rateService';
import { asyncHandler } from '../utils/apiError';

export function buildRouter(): Router {
  const api = Router();

  api.use('/auth', authRoutes);
  // Public self-registration / verification / password reset. Mounted on the
  // same prefix as login; the paths do not overlap.
  api.use('/auth', registerRoutes);
  api.use('/payments', paymentRoutes);
  api.use('/payouts', payoutRoutes);
  api.use('/admin', adminRoutes);
  // Merchant-managed hosted-checkout links.
  api.use('/payment-links', merchantLinkRouter);
  // Invoices and recurring billing. Money-IN only, so an API key may use them —
  // see the header of each router.
  api.use('/invoices', invoiceRoutes);
  api.use('/subscriptions', subscriptionRoutes);
  // PUBLIC checkout. No authentication by design — the link token in the path
  // is the capability. See routes/paymentLinks.ts for what may and may not be
  // returned here.
  api.use('/pay', publicCheckoutRouter);
  // Public capability probe: which networks this gateway can actually settle on.
  // Lets the panels offer only enabled networks instead of erroring on submit.
  api.get('/networks', (_req: Request, res: Response) => {
    res.status(200).json({ networks: enabledNetworks() });
  });
  // Companion probe: which (network, asset) pairs can actually be settled.
  // Drives every coin picker, so the panel offers only what will succeed.
  api.get('/assets', (_req: Request, res: Response) => {
    res.status(200).json({ assets: assetCatalogue() });
  });
  // Live exchange rates for the fiat currencies this gateway can price in.
  //
  // Unauthenticated, like /networks and /assets: it publishes public market
  // prices and this gateway's currency list, which is exactly what the checkout
  // page and the pricing UI need before anyone has signed in. It reveals
  // nothing about any merchant.
  //
  // `source` and `ageSeconds` are part of the contract, not debug output — a
  // caller showing a converted price is entitled to know it is looking at a
  // stale quote. See services/rateService.ts.
  api.get(
    '/rates',
    asyncHandler(async (_req: Request, res: Response) => {
      const snapshot = await getRates();
      res.status(200).json({
        rates: snapshot.rates,
        currencies: enabledFiatCurrencies(),
        source: snapshot.source,
        ageSeconds: Math.round(snapshot.ageSeconds),
        fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
      });
    }),
  );
  // /balance lives at the top level per the OpenAPI spec.
  api.use('/', accountRoutes);

  return api;
}

/** Mount /docs (swagger-ui) from docs/openapi.yaml if present; else a static note. */
export function mountDocs(app: import('express').Express): void {
  // openapi.yaml lives at <repo>/docs/openapi.yaml. From dist/routes -> ../../../docs.
  const candidates = [
    path.resolve(__dirname, '../../../docs/openapi.yaml'),
    path.resolve(process.cwd(), '../docs/openapi.yaml'),
    path.resolve(process.cwd(), 'docs/openapi.yaml'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));

  if (!found) {
    app.get('/docs', (_req: Request, res: Response) => {
      res
        .status(200)
        .type('text/plain')
        .send('OpenAPI spec not bundled in this image. See repo docs/openapi.yaml.');
    });
    return;
  }

  const doc = YAML.parse(fs.readFileSync(found, 'utf8'));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(doc));
}
