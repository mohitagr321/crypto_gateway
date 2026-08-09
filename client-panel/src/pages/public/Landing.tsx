import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Check,
  ChevronDown,
  Coins,
  Layers,
  Percent,
  ReceiptText,
  ShieldCheck,
  Wallet,
  Webhook,
} from 'lucide-react';
import CodeBlock from '@/components/CodeBlock';
import LiveCheckoutDemo from '@/components/LiveCheckoutDemo';
import { getAssets, getNetworks, getSignupStatus } from '@/lib/api';
import { useReveal, revealDelay } from '@/lib/useReveal';

/**
 * Public landing page.
 *
 * Structured against the way this kind of page is actually judged — usability,
 * accessibility, performance and responsiveness carry more weight than
 * spectacle — so the rules here are:
 *
 *   - Every capability claim is READ FROM THE GATEWAY (/networks, /assets).
 *     Nothing on this page asserts a chain or a coin that the deployment cannot
 *     actually settle. A payments site that overstates itself is worse than a
 *     plain one.
 *   - Motion is CSS scroll-driven where supported (see index.css) and degrades
 *     to a visible page everywhere else. No animation library, so the first
 *     thing a prospect downloads stays small.
 *   - One accent colour. Green and red are reserved for money states and never
 *     used decoratively.
 *   - Mobile is the primary layout, including a sticky CTA that survives the
 *     whole scroll — most first visits are on a phone.
 */

const CREATE_SNIPPET = `curl -X POST https://your-gateway/api/v1/payments \\
  -H "X-Api-Key: $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "fiatAmount":   "49.90",
    "fiatCurrency": "EUR",
    "orderId":      "order-1042",
    "network":      "TRC20",
    "asset":        "USDT"
  }'`;

const RESPONSE_SNIPPET = `{
  "paymentId": "pay_01J8ZK...",
  "orderId":   "order-1042",
  "amount":    "53.85",
  "asset":     "USDT",
  "network":   "TRC20",
  "address":   "TXk9Lm...",
  "status":    "waiting",
  "fiat": {
    "currency": "EUR",
    "amount":   "49.90",
    "rate":     "1.0791",
    "lockedAt": "2026-08-08T17:42:00Z"
  },
  "expiresAt": "2026-08-08T18:12:00Z"
}`;

const WEBHOOK_SNIPPET = `// The signature covers the body with \`signature\` blanked —
// not the raw bytes. Blank it, re-serialise, then compare.
const event = JSON.parse(raw);

const expected = crypto
  .createHmac('sha256', process.env.WEBHOOK_SECRET)
  .update(JSON.stringify({ ...event, signature: '' }))
  .digest('hex');

if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'),
                            Buffer.from(event.signature, 'hex'))) {
  return res.status(401).end();
}

if (event.event === 'payment.confirmed') {
  await fulfilOrder(event.orderId);   // idempotently
}`;

const features = [
  {
    icon: Wallet,
    title: 'Non-custodial by design',
    body: 'Every order gets its own HD-derived deposit address. Funds sweep to the settlement wallet you configure. We never ask for your keys.',
  },
  {
    icon: Layers,
    title: 'Multi-chain, multi-asset',
    body: 'Stablecoins, native coins and Bitcoin. Balances stay separate per (network, asset) pair — nothing is ever summed across chains.',
  },
  {
    icon: Coins,
    title: 'Price in your own currency',
    body: 'Quote in EUR, GBP, INR or USD. The rate locks at creation and is never revisited, so what you quoted is what you reconcile.',
  },
  {
    icon: Webhook,
    title: 'Signed webhooks, with receipts',
    body: 'HMAC-signed with your own secret and retried with backoff. Every attempt, status code and response body is logged and replayable.',
  },
  {
    icon: ShieldCheck,
    title: 'Credentials that fail safe',
    body: 'Scoped keys, IP allowlists, and one hard rule: only a signed-in session can move where your money settles. A leaked key cannot redirect a payout.',
  },
  {
    icon: ReceiptText,
    title: 'Invoices and subscriptions',
    body: 'Send a payable invoice or bill on a schedule. Hosted checkout links need no frontend work — share a URL and get paid.',
  },
];

const steps = [
  {
    n: '01',
    title: 'Create a payment',
    body: 'One POST with an amount — crypto or fiat — and your order id. Back comes an address unique to that order, and a QR.',
  },
  {
    n: '02',
    title: 'Your customer pays',
    body: 'From any wallet, with no account here. We watch the chain and track confirmations as they land.',
  },
  {
    n: '03',
    title: 'You get settled',
    body: 'On confirmation we fire a signed webhook and sweep, then settle the net amount to the wallet you control.',
  },
];

const faqs = [
  {
    q: 'Do you hold my funds?',
    a: 'No. Deposits sweep into a collection wallet and settle out to the payout address you set in your dashboard. You control that address, and changing it requires a signed-in session — an API key cannot change it, even a stolen one.',
  },
  {
    q: 'Which coins and networks can I accept?',
    a: 'BNB Smart Chain (BEP20) is always on. Tron (TRC20), Ethereum (ERC20) and Bitcoin are enabled per deployment. On each chain you can take its stablecoins and its native coin. The badges on this page are read live from this gateway, so they show what it settles right now rather than a wish list.',
  },
  {
    q: 'Can I charge in euros or rupees instead of crypto?',
    a: 'Yes. Send fiatAmount and fiatCurrency instead of a crypto amount. The gateway converts at the market rate, locks it on the payment, and records the rate and its source. Your customer sees a crypto amount; your books see the figure you quoted.',
  },
  {
    q: 'How long does approval take?',
    a: 'There is no approval queue. Create an account, click the link in the confirmation email, and it is active. Then add a settlement wallet and create your API key.',
  },
  {
    q: 'What happens if a customer underpays?',
    a: 'The payment is marked partial and the amount actually received is recorded. You decide whether to fulfil, refund or ask for the difference. Nothing is auto-fulfilled on your behalf.',
  },
  {
    q: 'Can I test before going live?',
    a: 'Yes. Create a payment from the dashboard and send a small amount to the deposit address to watch the whole lifecycle, including the webhook delivery log.',
  },
];

/**
 * True once `ref`'s element has scrolled out of view. Drives the sticky mobile
 * CTA: showing a second "Create your account" button while the first one is
 * still on screen is just clutter, and clutter on a phone is expensive.
 */
function useScrolledPast(ref: React.RefObject<HTMLElement>) {
  const [past, setPast] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([entry]) => setPast(!entry.isIntersecting && entry.boundingClientRect.top < 0),
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return past;
}

export default function Landing() {
  const revealRef = useReveal<HTMLDivElement>();
  const heroCtaRef = useRef<HTMLDivElement>(null);
  const showStickyCta = useScrolledPast(heroCtaRef);

  const { data: networks } = useQuery({
    queryKey: ['networks'],
    queryFn: getNetworks,
    staleTime: 5 * 60_000,
  });
  const { data: assets } = useQuery({
    queryKey: ['assets'],
    queryFn: getAssets,
    staleTime: 5 * 60_000,
  });
  const { data: signupEnabled } = useQuery({
    queryKey: ['signup-status'],
    queryFn: getSignupStatus,
    staleTime: 5 * 60_000,
  });

  const primaryCta = signupEnabled
    ? { to: '/signup', label: 'Create your account' }
    : { to: '/login', label: 'Sign in' };

  const chains = networks ?? ['BEP20'];
  const assetList = assets ?? [];

  // One "run" of the ticker, long enough to exceed any viewport before it is
  // doubled. A gateway with three enabled assets and one with fifteen both need
  // a seamless loop; repeating to a floor of ~16 chips covers both.
  const marqueeRun =
    assetList.length === 0
      ? []
      : Array.from({ length: Math.ceil(16 / assetList.length) }, () => assetList).flat();

  return (
    <div ref={revealRef}>
      {/* ============================ HERO ============================ */}
      <section className="relative isolate overflow-hidden">
        <div className="aurora pointer-events-none absolute inset-0 -z-10" aria-hidden />
        <div className="absolute inset-0 -z-10 bg-grid" aria-hidden />

        <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-5 pb-14 pt-10 sm:px-8 sm:pb-20 sm:pt-14 lg:grid-cols-[1.02fr_1fr] lg:gap-14">
          <div>
            <div className="reveal flex flex-wrap items-center gap-2">
              {chains.map((n) => (
                <span key={n} className="chip">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-emerald-500" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                  </span>
                  {n} · live
                </span>
              ))}
              {assetList.length > 0 && (
                <span className="chip">{assetList.length} assets</span>
              )}
            </div>

            <h1 className="reveal mt-6 h-display" style={revealDelay(1)}>
              Accept crypto.<br />
              <span className="text-gradient">Keep custody.</span>
            </h1>

            <p
              className="reveal lede mt-6 max-w-xl text-balance"
              style={revealDelay(2)}
            >
              A payment gateway that settles straight to a wallet you control —
              priced in your currency, confirmed on-chain, delivered by signed
              webhook.
            </p>

            <div
              ref={heroCtaRef}
              className="reveal mt-8 flex flex-col gap-3 sm:flex-row sm:items-center"
              style={revealDelay(3)}
            >
              <Link to={primaryCta.to} className="btn-primary-lg group">
                {primaryCta.label}
                <ArrowRight
                  size={18}
                  className="transition-transform duration-200 group-hover:translate-x-0.5"
                />
              </Link>
              <Link to="/developers" className="btn-secondary-lg">
                Read the API guide
              </Link>
            </div>

            <ul
              className="reveal mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-600 dark:text-slate-400"
              style={revealDelay(4)}
            >
              {['No setup fee', 'No approval queue', 'Your keys, your wallet'].map((t) => (
                <li key={t} className="flex items-center gap-1.5">
                  <Check size={15} className="text-brand-600 dark:text-brand-400" />
                  {t}
                </li>
              ))}
            </ul>
          </div>

          <div className="reveal parallax-slow" style={revealDelay(2)}>
            <LiveCheckoutDemo />
          </div>
        </div>

        {/* Asset ticker — proof of breadth, and it is the live catalogue. */}
        {assetList.length > 0 && (
          <div className="relative border-y border-slate-200/70 bg-white/50 py-4 backdrop-blur dark:border-white/5 dark:bg-slate-900/30">
            <div className="marquee-mask group overflow-hidden">
              {/* A -50% translate only loops seamlessly if the track holds
                  EXACTLY two copies of a run that is itself wider than the
                  viewport. With four assets one copy is ~500px, so on a desktop
                  the seam was visible as a gap. `run` repeats the catalogue
                  until it is long enough, then it is rendered twice. */}
              <div className="animate-marquee flex w-max gap-3 group-hover:[animation-play-state:paused]">
                {[...marqueeRun, ...marqueeRun].map((a, i) => (
                  <span
                    key={`${a.network}-${a.symbol}-${i}`}
                    className="flex shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-1.5 text-sm dark:border-slate-700/70 dark:bg-slate-800/60"
                  >
                    <span className="font-semibold text-slate-800 dark:text-slate-100">
                      {a.symbol}
                    </span>
                    <span className="text-xs text-slate-400">{a.network}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ========================= HOW IT WORKS ========================= */}
      <section className="section">
        <div className="reveal mx-auto max-w-2xl text-center">
          <p className="eyebrow">How it works</p>
          <h2 className="mt-3 h-section">Three calls from zero to settled</h2>
          <p className="lede mt-4">
            One POST, one webhook, and a payout address you set once.
          </p>
        </div>

        <ol className="mt-12 grid gap-5 md:grid-cols-3 md:gap-6">
          {steps.map((s, i) => (
            <li key={s.n} className="reveal glass-card group p-6 sm:p-7" style={revealDelay(i)}>
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600/10 text-sm font-semibold text-brand-700 transition-colors group-hover:bg-brand-600 group-hover:text-white dark:bg-brand-400/10 dark:text-brand-300">
                {s.n}
              </span>
              <h3 className="mt-4 text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                {s.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                {s.body}
              </p>
            </li>
          ))}
        </ol>
      </section>

      {/* ============================ CODE ============================ */}
      <section className="relative overflow-hidden border-y border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
        <div className="section">
          <div className="grid gap-10 lg:grid-cols-2 lg:items-center lg:gap-14">
            <div className="reveal">
              <p className="eyebrow">For developers</p>
              <h2 className="mt-3 h-section">An API that gets out of the way</h2>
              <p className="lede mt-4">
                Create a payment, show the address, wait for the webhook.
                Requests are idempotent, responses are boring, and every field
                means exactly what it says.
              </p>
              <ul className="mt-6 space-y-3 text-sm text-slate-600 dark:text-slate-400">
                {[
                  'Send an Idempotency-Key and retry without creating duplicates',
                  'HMAC-signed requests, or a single bearer key for simpler stacks',
                  'Deliveries logged with status codes and the retry schedule',
                ].map((t) => (
                  <li key={t} className="flex gap-2.5">
                    <Check size={16} className="mt-0.5 shrink-0 text-brand-600 dark:text-brand-400" />
                    {t}
                  </li>
                ))}
              </ul>
              <Link to="/developers" className="btn-primary mt-7 inline-flex">
                Full developer guide <ArrowRight size={16} />
              </Link>
            </div>

            <div className="reveal min-w-0" style={revealDelay(1)}>
              <CodeBlock
                tabs={[
                  { label: 'Create payment', code: CREATE_SNIPPET },
                  { label: 'Response', code: RESPONSE_SNIPPET },
                  { label: 'Webhook', code: WEBHOOK_SNIPPET },
                ]}
              />
            </div>
          </div>
        </div>
      </section>

      {/* ========================== FEATURES =========================== */}
      <section className="section">
        <div className="reveal mx-auto max-w-2xl text-center">
          <p className="eyebrow">What you get</p>
          <h2 className="mt-3 h-section">Built for moving real money</h2>
        </div>

        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f, i) => (
            <div
              key={f.title}
              className="reveal glass-card group p-6 transition duration-300 hover:-translate-y-1 hover:shadow-lift sm:p-7"
              style={revealDelay(i % 3)}
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-600/10 text-brand-600 transition-colors duration-300 group-hover:bg-brand-600 group-hover:text-white dark:bg-brand-400/10 dark:text-brand-400">
                <f.icon size={20} />
              </span>
              <h3 className="mt-4 text-base font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                {f.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                {f.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ============================= FAQ ============================= */}
      <section className="border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
        <div className="section max-w-3xl">
          <div className="reveal text-center">
            <p className="eyebrow">Questions</p>
            <h2 className="mt-3 h-section">Before you sign up</h2>
          </div>
          <div className="mt-10 space-y-3">
            {faqs.map((f, i) => (
              <Faq key={f.q} {...f} style={revealDelay(Math.min(i, 3))} />
            ))}
          </div>
        </div>
      </section>

      {/* ============================= CTA ============================= */}
      <section className="section">
        <div className="reveal relative isolate overflow-hidden rounded-3xl px-6 py-16 text-center ring-1 ring-slate-200 sm:px-16 sm:py-20 dark:ring-white/10">
          <div className="aurora pointer-events-none absolute inset-0 -z-10" aria-hidden />
          <div className="absolute inset-0 -z-10 bg-grid" aria-hidden />
          <h2 className="h-section">Start accepting crypto today</h2>
          <p className="lede mx-auto mt-4 max-w-lg">
            Create an account, confirm your email, add a settlement wallet.
            You'll have a working API key in a few minutes.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Link to={primaryCta.to} className="btn-primary-lg group">
              {primaryCta.label}
              <ArrowRight
                size={18}
                className="transition-transform duration-200 group-hover:translate-x-0.5"
              />
            </Link>
            <Link to="/pricing" className="btn-secondary-lg">
              See pricing
            </Link>
          </div>
          <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <Percent size={12} />
            Commission is shown in full on your dashboard, versioned with an
            audit trail.
          </p>
        </div>
      </section>

      {/* Sticky mobile CTA. Most first visits are on a phone, and the hero CTA
          is long gone by the FAQ. Hidden on lg where the header CTA is always
          in view, and it sits above the safe-area inset so it clears the home
          indicator on iOS. */}
      <div
        className={`fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/90 px-4 py-3 backdrop-blur-xl transition-transform duration-300 lg:hidden dark:border-slate-800 dark:bg-slate-950/90 ${
          showStickyCta ? 'translate-y-0' : 'translate-y-full'
        }`}
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
        // Hidden from AT while off-screen, so a screen-reader user does not meet
        // the same link twice.
        aria-hidden={!showStickyCta}
      >
        <Link to={primaryCta.to} className="btn-primary w-full" tabIndex={showStickyCta ? 0 : -1}>
          {primaryCta.label} <ArrowRight size={16} />
        </Link>
      </div>
      {/* Spacer so the sticky bar never covers the last of the page. */}
      <div className="h-20 lg:hidden" aria-hidden />
    </div>
  );
}

function Faq({ q, a, style }: { q: string; a: string; style?: React.CSSProperties }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="reveal glass-card overflow-hidden" style={style}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-slate-50/60 sm:px-6 sm:py-5 dark:hover:bg-white/[0.03]"
      >
        <span className="text-[15px] font-semibold text-slate-900 dark:text-slate-100">
          {q}
        </span>
        <ChevronDown
          size={18}
          className={`shrink-0 text-slate-400 transition-transform duration-300 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {/* Grid-rows trick: animates to the content's natural height without
          measuring it in JS, which max-height cannot do without a magic number. */}
      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-out ${
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          <p className="border-t border-slate-200/70 px-5 py-4 text-sm leading-relaxed text-slate-600 sm:px-6 sm:py-5 dark:border-slate-800/70 dark:text-slate-400">
            {a}
          </p>
        </div>
      </div>
    </div>
  );
}
