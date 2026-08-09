/**
 * The product's name, in ONE place — the admin panel's mirror of
 * client-panel/src/lib/brand.ts.
 *
 * The console used to hardcode "SecuriPay" in Sidebar.tsx and Login.tsx, which
 * is exactly the drift the client panel's brand.ts was created to stop: a
 * rebrand touched the merchant-facing app and quietly left the operator-facing
 * one on the old name. Same env var, same default, so the two apps and the
 * backend's BRAND_NAME move together.
 */
export const BRAND_NAME = import.meta.env.VITE_BRAND_NAME || 'PayCrypo';

/** Shown under the wordmark on the sidebar and the sign-in screen. */
export const BRAND_CONSOLE_LABEL = 'Admin Console';
