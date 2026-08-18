/**
 * The product's name, in ONE place.
 *
 * It used to be typed literally into BrandMark, Sidebar and the checkout
 * footer, which is how "USDT Gateway" survived the move to multi-asset: the
 * gateway settles USDT, USDC, BUSD, DAI, BNB, TRX and BTC across four chains,
 * but three separate strings still told customers it was a USDT product.
 *
 * `VITE_BRAND_NAME` lets a white-label deployment override it at build time,
 * mirroring `BRAND_NAME` in the backend (config/env.ts) which names the sender
 * on transactional email. Keep the two in sync per deployment — a customer who
 * gets an email from one name about a checkout branded with another has every
 * reason to suspect a phish.
 */
export const BRAND_NAME = import.meta.env.VITE_BRAND_NAME || 'PayCrypo';

/**
 * One-line positioning, used under the wordmark and in the footer. Deliberately
 * asset-neutral — adding a chain must never require a copy change here.
 */
export const BRAND_TAGLINE = 'Crypto Payments';

/**
 * Apex domain, for copy that shows a URL rather than links to one (the checkout
 * preview's fake address bar, docs examples). Overridable so a white-label
 * deployment does not advertise someone else's domain in its own screenshots.
 *
 * NOT used to build real links — those come from the API base URL and from
 * PUBLIC_PANEL_URL on the backend, which are the values that actually have to
 * resolve.
 */
export const BRAND_DOMAIN = import.meta.env.VITE_BRAND_DOMAIN || 'paycrypo.com';

/**
 * Host shown on the hosted-checkout preview.
 *
 * The apex, not a `pay.` subdomain: checkout is the /pay/:token route on THIS
 * app, so it is served from wherever the merchant panel is. It said
 * pay.paycrypo.com while the deploy pointed the panel at the apex, which put a
 * hostname on the marketing page that resolved to nothing.
 */
export const BRAND_CHECKOUT_HOST = BRAND_DOMAIN;
