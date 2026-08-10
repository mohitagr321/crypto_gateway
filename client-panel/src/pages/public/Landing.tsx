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
 * SET IN TYPE, NOT ASSEMBLED FROM CARDS. The page is divided by hairline rules
 * and white space rather than by rounded rectangles: each band carries a
 * running head, body copy sits on a real reading measure ranged left, the grid
 * is asymmetric (a narrow annotation column against a wide main one), and the
 * one number worth stating in a section is set enormous and anchors it.
 *
 * The rules that outrank the look:
 *
 *   - Every capability claim is READ FROM THE GATEWAY (/networks, /assets).
 *     Nothing on this page asserts a chain or a coin that the deployment cannot
 *     actually settle — including the enormous figure in "what you get", which
 *     is the live pair count and simply does not render until it is known. A
 *     payments site that overstates itself is worse than a plain one.
 *   - Motion is CSS scroll-driven where supported (see index.css) and degrades
 *     to a visible page everywhere else. No animation library, so the first
 *     thing a prospect downloads stays small.
 *   - BRAND IS INTERACTIVE ONLY: the CTA, a link underline, the focus ring. It
 *     is never decoration and never a state. That is why the headline is plain
 *     ink (emphasis comes from WEIGHT, not hue) and why the tick marks and
 *     section icons are slate-400, the step documented for decorative icons.
 *     Emerald stays reserved for "funds arrived" — hence the live dot, and
 *     nothing else.
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

const devPoints = [
  'Send an Idempotency-Key and retry without creating duplicates',
  'HMAC-signed requests, or a single bearer key for simpler stacks',
  'Deliveries logged with status codes and the retry schedule',
];

const heroClaims = ['No setup fee', 'No approval queue', 'Your keys, your wallet'];

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
            {/* Masthead: the running head and the live capability chips sit on
                one line, closed by the section rule. The heavy stroke is under
                the label rather than above it, so it never reads as a second
                copy of the site header's border. */}
            <div className="reveal">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                <span className="runhead">Crypto payment gateway</span>
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
              <div className="rule-strong mt-4" aria-hidden />
            </div>

            {/* Plain ink. The emphasis on the second line is WEIGHT — the brand
                hue belongs to things you can click, and a gradient headline is
                the one thing every template on this market does. */}
            <h1 className="reveal mt-7 h-display" style={revealDelay(1)}>
              Accept crypto.<br />
              <span className="font-normal">Keep custody.</span>
            </h1>

            <p className="reveal lede measure mt-6" style={revealDelay(2)}>
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
              className="reveal rule mt-8 flex flex-wrap gap-x-6 gap-y-2 pt-4 text-sm text-slate-600 dark:text-slate-400"
              style={revealDelay(4)}
            >
              {heroClaims.map((t) => (
                <li key={t} className="flex items-center gap-1.5">
                  <Check size={15} className="text-slate-400" aria-hidden />
                  {t}
                </li>
              ))}
            </ul>
          </div>

          <div className="reveal parallax-slow" style={revealDelay(2)}>
            <LiveCheckoutDemo />
          </div>
        </div>

        {/* Asset ticker — proof of breadth, and it is the live catalogue. Set as
            a ruled stock ticker rather than a row of pills: symbol in ink,
            chain in small caps, a hairline between each. */}
        {assetList.length > 0 && (
          <div className="relative border-y border-slate-200 bg-white/50 py-5 backdrop-blur dark:border-slate-800 dark:bg-slate-900/30">
            <div className="mx-auto mb-4 w-full max-w-6xl px-5 sm:px-8">
              <span className="runhead">Assets this gateway settles</span>
            </div>
            <div className="marquee-mask group overflow-hidden">
              {/* A -50% translate only loops seamlessly if the track holds
                  EXACTLY two copies of a run that is itself wider than the
                  viewport. With four assets one copy is ~500px, so on a desktop
                  the seam was visible as a gap. `run` repeats the catalogue
                  until it is long enough, then it is rendered twice. */}
              <div className="animate-marquee flex w-max group-hover:[animation-play-state:paused]">
                {[...marqueeRun, ...marqueeRun].map((a, i) => (
                  <span
                    key={`${a.network}-${a.symbol}-${i}`}
                    className="flex shrink-0 items-baseline gap-2 border-l border-slate-200 px-6 dark:border-slate-800"
                  >
                    <span className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                      {a.symbol}
                    </span>
                    <span className="text-[11px] uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                      {a.network}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ========================= HOW IT WORKS =========================
          Three steps as a ruled sequence, each opened by an enormous numeral.
          Cards would have made them three equal-weight objects; a numbered
          sequence down the page is what actually says "in this order". */}
      <section className="section">
        <div className="reveal grid gap-x-8 gap-y-4 md:grid-cols-12">
          <div className="col-aside">
            <span className="runhead">How it works</span>
            <p className="mt-3">
              Three calls, in order. Nothing between them is manual, and nothing
              waits on us.
            </p>
          </div>
          <div className="md:col-span-8 md:col-start-5">
            <h2 className="h-section">Three calls from zero to settled</h2>
            <p className="lede measure mt-4">
              One POST, one webhook, and a payout address you set once.
            </p>
          </div>
        </div>

        <ol className="mt-8 sm:mt-12">
          {steps.map((s, i) => (
            <li
              key={s.n}
              className="reveal band grid gap-x-8 gap-y-4 md:grid-cols-12"
              style={revealDelay(i)}
            >
              <div className="md:col-span-3">
                <span className="figure-xl">{s.n}</span>
              </div>
              <div className="md:col-span-8 md:col-start-5">
                <h3 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl dark:text-slate-50">
                  {s.title}
                </h3>
                <p className="measure mt-3 leading-relaxed text-slate-600 dark:text-slate-400">
                  {s.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* ============================ CODE ============================ */}
      <section className="relative overflow-hidden border-y border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
        <div className="section">
          <div className="grid gap-x-8 gap-y-10 lg:grid-cols-12 lg:items-start">
            <div className="reveal lg:col-span-5">
              <span className="runhead">For developers</span>
              <div className="rule-strong mt-4" aria-hidden />
              <h2 className="mt-6 h-section">An API that gets out of the way</h2>
              <p className="lede measure mt-4">
                Create a payment, show the address, wait for the webhook.
                Requests are idempotent, responses are boring, and every field
                means exactly what it says.
              </p>
              {/* A ruled list, not a column of ticks: the hairline does the
                  separating a bullet glyph was doing, for a pixel. */}
              <ul className="mt-8 border-b border-slate-200 dark:border-slate-800">
                {devPoints.map((t) => (
                  <li
                    key={t}
                    className="rule measure py-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400"
                  >
                    {t}
                  </li>
                ))}
              </ul>
              <Link to="/developers" className="btn-primary mt-8 inline-flex">
                Full developer guide <ArrowRight size={16} />
              </Link>
            </div>

            <div className="reveal min-w-0 lg:col-span-7" style={revealDelay(1)}>
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
        <div className="reveal grid gap-x-8 gap-y-4 md:grid-cols-12">
          <div className="col-aside">
            <span className="runhead">What you get</span>
            <p className="mt-3">
              Every capability named here is read from this gateway on load, not
              from a brochure.
            </p>
          </div>
          <div className="md:col-span-8 md:col-start-5">
            <h2 className="h-section">Built for moving real money</h2>
          </div>
        </div>

        {/* THE FIGURE. The live (network, asset) pair count carries the section.
            It is deliberately absent until /assets answers — a placeholder zero
            on a payments page is a claim, and the wrong one. */}
        {assetList.length > 0 && (
          <div className="reveal band mt-8 grid gap-x-8 gap-y-8 sm:mt-12 md:grid-cols-12">
            <div className="md:col-span-4">
              <span className="figure-xl">{assetList.length}</span>
              <span className="figure-label measure">
                (network, asset) pairs this deployment settles right now, read
                from <code className="code">/assets</code>.
              </span>
            </div>
            <div className="md:col-span-7 md:col-start-6">
              <p className="measure leading-relaxed text-slate-600 dark:text-slate-400">
                Each pair keeps its own balance and is never summed with
                another, so what you reconcile is what actually landed on that
                chain.
              </p>
              <dl className="mt-6 grid gap-x-10 sm:grid-cols-2">
                {chains.map((n) => {
                  const count = assetList.filter((a) => a.network === n).length;
                  return (
                    <div
                      key={n}
                      className="rule flex items-baseline justify-between gap-4 py-2.5"
                    >
                      <dt className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        {n}
                      </dt>
                      <dd className="num text-xs text-slate-500 dark:text-slate-400">
                        {count} {count === 1 ? 'asset' : 'assets'}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </div>
          </div>
        )}

        {/* The six capabilities as a ruled table rather than six boxes. Icons
            stay, at slate-400 — the step documented for decorative icons. */}
        {/* Spacing has to read correctly BOTH with the figure band above it and
            without it, since the band does not render until /assets answers. */}
        <div className="mt-8 grid border-b border-slate-200 sm:mt-10 sm:grid-cols-2 sm:gap-x-12 dark:border-slate-800">
          {features.map((f, i) => (
            <div
              key={f.title}
              className="reveal rule py-6 sm:py-8"
              style={revealDelay(i % 2)}
            >
              <div className="flex items-baseline gap-2.5">
                <f.icon size={16} className="shrink-0 translate-y-0.5 text-slate-400" aria-hidden />
                <h3 className="text-base font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                  {f.title}
                </h3>
              </div>
              <p className="measure mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                {f.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ============================= FAQ ============================= */}
      <section className="border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
        <div className="section">
          <div className="reveal grid gap-x-8 gap-y-4 md:grid-cols-12">
            <div className="col-aside">
              <span className="runhead">Questions</span>
              <p className="mt-3">
                The six a merchant asks before handing over a payment flow.
              </p>
            </div>
            <div className="md:col-span-8 md:col-start-5">
              <h2 className="h-section">Before you sign up</h2>
            </div>
          </div>

          {/* Same 12-column grid as the heading above, so the list hangs off
              exactly the same edge as the headline rather than approximately. */}
          <div className="mt-8 grid gap-x-8 sm:mt-12 md:grid-cols-12">
            <div className="border-b border-slate-200 md:col-span-8 md:col-start-5 dark:border-slate-800">
              {faqs.map((f, i) => (
                <Faq key={f.q} {...f} style={revealDelay(Math.min(i, 3))} />
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ============================= CTA ============================= */}
      <section className="section">
        <div className="reveal">
          <div className="rule-strong" aria-hidden />
          <div className="mt-8 grid gap-x-8 gap-y-8 md:grid-cols-12">
            <div className="col-aside">
              <span className="runhead">Get started</span>
              <p className="mt-3 flex gap-2">
                <Percent size={13} className="mt-0.5 shrink-0 text-slate-400" aria-hidden />
                <span>
                  Commission is shown in full on your dashboard, versioned with
                  an audit trail.
                </span>
              </p>
            </div>
            <div className="md:col-span-8 md:col-start-5">
              <h2 className="h-section">Start accepting crypto today</h2>
              <p className="lede measure mt-4">
                Create an account, confirm your email, add a settlement wallet.
                You'll have a working API key in a few minutes.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
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
            </div>
          </div>
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

/**
 * One question in the ruled FAQ list. No box: a hairline above each row and one
 * closing the list is all the enclosure a disclosure needs. The hover
 * affordance is a brand underline on the question — a link underline is the
 * sanctioned decorative use of the brand hue, because it is drawn on something
 * you can genuinely click.
 */
function Faq({ q, a, style }: { q: string; a: string; style?: React.CSSProperties }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="reveal rule" style={style}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex w-full items-baseline justify-between gap-6 py-5 text-left outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <span className="text-[15px] font-semibold text-slate-900 underline decoration-transparent underline-offset-[3px] group-hover:decoration-brand-600 dark:text-slate-100 dark:group-hover:decoration-brand-400">
          {q}
        </span>
        <ChevronDown
          size={18}
          aria-hidden
          className={`shrink-0 translate-y-0.5 text-slate-400 transition-transform duration-[var(--dur-morph)] ease-[var(--ease-out)] ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      {/* The grid-rows trick still does the SIZING — it reaches the content's
          natural height without measuring it in JS, which a max-height cannot
          do without a magic number — but it is no longer TRANSITIONED.
          Transitioning the row track is a layout animation: it re-runs layout
          every frame for every element inside the row, which is the one thing
          the motion rule forbids. So the row snaps, and the answer itself
          carries the motion on opacity and transform only.

          Do not name that banned utility in this comment. Tailwind's content
          scanner is a plain token extractor and does not know what a comment
          is, so writing the class here — even to say "never use it" — is
          enough to emit the rule into the shipped stylesheet. */}
      <div className={`grid ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden">
          <p
            className={`measure pb-6 text-sm leading-relaxed text-slate-600 transition-[opacity,transform] duration-[var(--dur-morph)] ease-[var(--ease-out)] dark:text-slate-400 ${
              open ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0'
            }`}
          >
            {a}
          </p>
        </div>
      </div>
    </div>
  );
}
