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
export const BRAND_NAME = import.meta.env.VITE_BRAND_NAME || 'SecuriPay';

/**
 * One-line positioning, used under the wordmark and in the footer. Deliberately
 * asset-neutral — adding a chain must never require a copy change here.
 */
export const BRAND_TAGLINE = 'Crypto Payments';
