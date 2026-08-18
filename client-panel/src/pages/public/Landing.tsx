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
import PaymentFlowDiagram from './PaymentFlowDiagram';
import { getAssets, getNetworks, getSignupStatus } from '@/lib/api';
import { useReveal, revealDelay } from '@/lib/useReveal';

/**
 * Public landing page — the flagship surface of the product.
 *
 * BUILT FROM LIT SURFACES ON A DEPTH FIELD, not set as a broadsheet. The page
 * that stood here was divided by hairline rules and white space: running heads
 * in a margin column, an asymmetric grid, bands opened by a stroke. It was well
 * made and it was a newspaper, and a newspaper is not what a 2026 payments
 * company looks like. Every band that was doing STRUCTURAL work with a rule is
 * now a raised, rim-lit surface floating on the field that MarketingLayout
 * mounts; rules survive only where they divide rows INSIDE one of those
 * surfaces, which is the one job the system still gives them.
 *
 * The rules that outrank the look, and none of them changed:
 *
 *   - Every capability claim is READ FROM THE GATEWAY (/networks, /assets).
 *     Nothing on this page asserts a chain or a coin that the deployment cannot
 *     actually settle — including the enormous figure in "what you get", which
 *     is the live pair count and simply does not render until it is known. A
 *     payments site that overstates itself is worse than a plain one.
 *   - Motion is CSS scroll-driven where supported (see index.css) and degrades
 *     to a visible page everywhere else. No animation library, so the first
 *     thing a prospect downloads stays small. This is a marketing route, which
 *     is the widest end of the frequency boundary: reveals, parallax and a
 *     looping marquee are all in budget here and would not be on a dashboard.
 *   - BRAND IS INTERACTIVE ONLY: the CTA, a link underline, the focus ring. It
 *     is never a state. The one decorative use of the brand ramp on this page is
 *     `.text-gradient` on a single headline phrase — brand travelling to accent,
 *     which are the two hues that carry no meaning. It is spent ONCE, on the
 *     phrase the whole page turns on. Emerald stays reserved for "funds
 *     arrived", which is why the live dots are the only green here.
 *   - THE PRIMARY CTA STAYS ABOVE THE FOLD on a 1440x900 laptop AND a 360x640
 *     phone. That constraint is what sets the hero's vertical rhythm, and it is
 *     why `.h-display`'s clamp is left alone rather than pushed with a utility:
 *     an oversized hero that shoves the button off-screen looks impressive in a
 *     screenshot and costs signups in practice.
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
      {/* ============================ HERO ============================
          The hero gets its OWN aurora on top of the field MarketingLayout
          mounts. That is not a duplicate: the shell's field is a whole-app
          atmosphere at low alpha, and this is a local bloom sized to the
          opening spread, which is what makes the top of the page the brightest
          part of it and gives the checkout frame something to be lit against.
          Both are `pointer-events-none` and neither carries information. */}
      <section className="relative isolate overflow-hidden">
        <div className="aurora pointer-events-none absolute inset-0 -z-10" aria-hidden />
        <div className="pointer-events-none absolute inset-0 -z-10 bg-grid" aria-hidden />

        <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-5 pb-14 pt-8 sm:px-8 sm:pb-20 sm:pt-14 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
          <div className="min-w-0">
            {/* The eyebrow and the live chips share one line. This is the first
                claim the page makes and it is the only one read from the wire:
                the chips are the gateway's own enabled networks, so the header
                of the page cannot advertise a chain the deployment cannot
                settle. */}
            <div className="reveal flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="eyebrow">Crypto payment gateway</span>
              {chains.map((n) => (
                <span key={n} className="chip">
                  <span className="relative flex h-2 w-2" aria-hidden>
                    <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-emerald-500" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                  </span>
                  {n} · live
                </span>
              ))}
              {assetList.length > 0 && (
                <span className="chip num">
                  {assetList.length} {assetList.length === 1 ? 'asset' : 'assets'}
                </span>
              )}
            </div>

            {/* THE ONE GRADIENT PHRASE ON THE PAGE. "Keep custody" is the
                promise the entire product is an argument for, so it is the line
                that gets the brand -> accent sweep. Spending it a second time
                anywhere below would make it a decoration rather than an
                emphasis. */}
            <h1 className="reveal mt-6 h-display" style={revealDelay(1)}>
              Accept crypto.
              <br />
              <span className="text-gradient">Keep custody.</span>
            </h1>

            <p className="reveal lede measure mt-5" style={revealDelay(2)}>
              A payment gateway that settles straight to a wallet you control —
              priced in your currency, confirmed on-chain, delivered by signed
              webhook.
            </p>

            <div
              ref={heroCtaRef}
              className="reveal mt-7 flex flex-col gap-3 sm:flex-row sm:items-center"
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
              className="reveal mt-7 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-600 dark:text-slate-400"
              style={revealDelay(4)}
            >
              {heroClaims.map((t) => (
                <li key={t} className="flex items-center gap-1.5">
                  <Check size={15} className="shrink-0 text-slate-400" aria-hidden />
                  {t}
                </li>
              ))}
            </ul>
          </div>

          {/* The checkout replica counter-drifts as the page scrolls. Parallax
              is the cheapest way to make a flat hero feel built out of layers,
              and it is scroll-driven CSS rather than JS, so it composites. */}
          <div className="reveal parallax-slow min-w-0" style={revealDelay(2)}>
            <LiveCheckoutDemo />
          </div>
        </div>

        {/* THE ASSET MARQUEE — proof of breadth, and it is the live catalogue
            rather than a logo wall. It sits on its own surface: a ticker is an
            instrument readout, and the raised plane is what separates it from
            the hero above it without needing a rule to do the separating. */}
        {assetList.length > 0 && (
          <div className="mx-auto w-full max-w-6xl px-5 pb-14 sm:px-8 sm:pb-20">
            <div className="reveal surface overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-5">
                <h2 className="runhead">Assets this gateway settles</h2>
                <span className="num text-xs text-slate-500 dark:text-slate-400">
                  read from /assets
                </span>
              </div>
              {/* Pauses under the cursor, so a reader who wants to actually read
                  a ticker can. There is no hover on touch, which is why the
                  same list is printed statically in the footer. */}
              <div className="marquee-mask group overflow-hidden border-t border-[var(--line-soft)] py-4">
                {/* A -50% translate only loops seamlessly if the track holds
                    EXACTLY two copies of a run that is itself wider than the
                    viewport. With four assets one copy is ~500px, so on a
                    desktop the seam was visible as a gap. `marqueeRun` repeats
                    the catalogue until it is long enough, then it is rendered
                    twice. `w-max` is load-bearing — without it the track wraps
                    and the seam reappears. */}
                <div className="animate-marquee flex w-max group-hover:[animation-play-state:paused]">
                  {[...marqueeRun, ...marqueeRun].map((a, i) => (
                    <span
                      key={`${a.network}-${a.symbol}-${i}`}
                      className="flex shrink-0 items-baseline gap-2 border-l border-[var(--line-soft)] px-6"
                    >
                      <span className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                        {a.symbol}
                      </span>
                      <span className="text-xs uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
                        {a.network}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ========================= HOW IT WORKS =========================
          Three surfaces, then the lifecycle drawn out underneath them. The
          sequence used to be a stack of ruled bands down the page, which said
          "in this order" but cost three full screens to say it; three tiles say
          the same thing in one, and the diagram below carries the part a list
          genuinely cannot — that the money and the notification travel to two
          different places. */}
      <section className="section pt-0">
        <div className="reveal">
          <span className="eyebrow">How it works</span>
          <h2 className="mt-3 h-section">Three calls from zero to settled</h2>
          <p className="lede measure mt-4">
            One POST, one webhook, and a payout address you set once. Nothing
            between them is manual, and nothing waits on us.
          </p>
        </div>

        <ol className="mt-8 grid gap-3 sm:mt-12 lg:grid-cols-3">
          {steps.map((s, i) => (
            <li
              key={s.n}
              className="reveal surface spot flex min-w-0 flex-col p-5 sm:p-6"
              style={revealDelay(i)}
            >
              <span className="figure-lg">{s.n}</span>
              <h3 className="mt-3 text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                {s.title}
              </h3>
              <p className="measure mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                {s.body}
              </p>
            </li>
          ))}
        </ol>

        {/* NOT RENDERED BELOW `sm`, and this is a legibility decision rather
            than a layout one. The drawing has a fixed 420-unit viewBox, so its
            type scales with the container: inside a 320px phone column its
            labels land at ~7px, which is below anything anyone can read. The
            three tiles above carry the same sequence in real, reflowing text
            and the SVG's aria-label carries it for assistive tech, so nothing
            is lost by withholding an illustration at the one width where it
            would be illegible. From `sm` up it has 520px+ and sets at 14px. */}
        <div className="reveal mt-3 hidden sm:block" style={revealDelay(1)}>
          <PaymentFlowDiagram />
        </div>
      </section>

      {/* ============================ CODE ============================ */}
      <section className="section pt-0">
        <div className="grid gap-8 lg:grid-cols-12 lg:items-start lg:gap-10">
          <div className="reveal min-w-0 lg:col-span-5">
            <span className="eyebrow">For developers</span>
            <h2 className="mt-3 h-section">An API that gets out of the way</h2>
            <p className="lede measure mt-4">
              Create a payment, show the address, wait for the webhook. Requests
              are idempotent, responses are boring, and every field means exactly
              what it says.
            </p>

            {/* Rules INSIDE a surface, which is the one structural job the
                system still gives a hairline: it divides rows of one object
                rather than standing in for the object. */}
            <ul className="surface mt-7 px-4 py-1 sm:px-5">
              {devPoints.map((t) => (
                <li
                  key={t}
                  className="rule py-3.5 text-sm leading-relaxed text-slate-600 first:border-t-0 dark:text-slate-400"
                >
                  {t}
                </li>
              ))}
            </ul>

            <Link to="/developers" className="btn-primary mt-7 inline-flex">
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
      </section>

      {/* ========================== FEATURES =========================== */}
      <section className="section pt-0">
        <div className="reveal">
          <span className="eyebrow">What you get</span>
          <h2 className="mt-3 h-section">Built for moving real money</h2>
          <p className="lede measure mt-4">
            Every capability named here is read from this gateway on load, not
            from a brochure.
          </p>
        </div>

        {/* THE FIGURE. The live (network, asset) pair count carries the section
            and gets the surface a measurement deserves. It is deliberately
            absent until /assets answers — a placeholder zero on a payments page
            is a claim, and the wrong one. */}
        {assetList.length > 0 && (
          <div className="reveal surface spot mt-8 grid gap-8 p-5 sm:mt-12 sm:p-7 md:grid-cols-12 md:gap-10">
            <div className="min-w-0 md:col-span-5">
              <span className="figure-xl break-words">{assetList.length}</span>
              <span className="figure-label measure">
                (network, asset) pairs this deployment settles right now, read
                from <code className="code">/assets</code>.
              </span>
            </div>
            <div className="min-w-0 md:col-span-6 md:col-start-7">
              <p className="measure text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                Each pair keeps its own balance and is never summed with another,
                so what you reconcile is what actually landed on that chain.
              </p>
              {/* A spine — label left, figure right, against a shared rule. The
                  same primitive every detail view in the dashboard is built
                  from, which is the point: the marketing page and the product
                  should be recognisably the same instrument. */}
              <dl className="mt-4">
                {chains.map((n) => {
                  const count = assetList.filter((a) => a.network === n).length;
                  return (
                    <div key={n} className="spine-row">
                      <dt className="spine-label text-slate-900 dark:text-slate-100">
                        {n}
                      </dt>
                      <dd className="spine-value num">
                        {count} {count === 1 ? 'asset' : 'assets'}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </div>
          </div>
        )}

        {/* Six tiles rather than six ruled rows. `auto-fit` + `minmax` so they
            reflow from three across to one without a breakpoint, and so a tile
            can never be squeezed narrower than its own copy wants to be. */}
        <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,17rem),1fr))] gap-3">
          {features.map((f, i) => (
            <div
              key={f.title}
              className="reveal surface spot min-w-0 p-5"
              style={revealDelay(i % 3)}
            >
              {/* slate-400 is the documented step for a DECORATIVE icon and is
                  never allowed to carry text. The heading beside it is what
                  carries the meaning. */}
              <f.icon size={18} className="text-slate-400" aria-hidden />
              <h3 className="mt-3 text-base font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                {f.title}
              </h3>
              <p className="measure mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                {f.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ============================= FAQ ============================= */}
      <section className="section pt-0">
        <div className="reveal">
          <span className="eyebrow">Questions</span>
          <h2 className="mt-3 h-section">Before you sign up</h2>
          <p className="lede measure mt-4">
            The six a merchant asks before handing over a payment flow.
          </p>
        </div>

        <div className="reveal surface mt-8 px-4 sm:mt-12 sm:px-6">
          {faqs.map((f) => (
            <Faq key={f.q} {...f} />
          ))}
        </div>
      </section>

      {/* ============================= CTA =============================
          The closing surface is the only one on the page that is LIT rather
          than merely raised: `.bg-mesh` puts the hero's own bloom back behind
          the last thing the reader sees, so the page closes in the same key it
          opened in. */}
      <section className="section pt-0">
        <div className="reveal surface relative overflow-hidden bg-mesh p-6 sm:p-10">
          <div className="pointer-events-none absolute inset-0 bg-grid" aria-hidden />
          <div className="relative">
            <span className="eyebrow">Get started</span>
            <h2 className="mt-3 h-section">Start accepting crypto today</h2>
            <p className="lede measure mt-4">
              Create an account, confirm your email, add a settlement wallet.
              You&apos;ll have a working API key in a few minutes.
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
            <p className="measure-wide mt-7 flex gap-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
              <Percent size={14} className="mt-0.5 shrink-0 text-slate-400" aria-hidden />
              <span>
                Commission is shown in full on your dashboard, versioned with an
                audit trail.
              </span>
            </p>
          </div>
        </div>
      </section>

      {/* STICKY MOBILE CTA. Most first visits are on a phone and the hero CTA is
          long gone by the FAQ. Hidden on lg, where the masthead's own CTA never
          leaves the viewport.

          IT IS PLANE 3 AND THEREFORE GLASS — the second and last glass plane on
          the public site, and it never shares a viewport with a third.

          THE SAFE-AREA INSET IS LOAD-BEARING, not a nicety. `viewport-fit=cover`
          is now set on the document, so iOS extends the page under the home
          indicator; without `env(safe-area-inset-bottom)` in the padding this
          bar's button would sit UNDER that indicator, where a tap is swallowed
          by the system gesture. The clearance under the last of the page is the
          footer's own mobile bottom padding in MarketingLayout — put here it
          would only push Landing's content up and leave the colophon covered. */}
      <div
        className={`glass fixed inset-x-0 bottom-0 z-30 border-x-0 border-b-0 px-4 pt-3 shadow-float transition-transform duration-[var(--dur-morph)] ease-[var(--ease-out)] lg:hidden ${
          showStickyCta ? 'translate-y-0' : 'translate-y-full'
        }`}
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
        // Hidden from AT while off-screen, so a screen-reader user does not meet
        // the same link twice.
        aria-hidden={!showStickyCta}
      >
        <Link
          to={primaryCta.to}
          className="btn-primary w-full"
          tabIndex={showStickyCta ? 0 : -1}
        >
          {primaryCta.label} <ArrowRight size={16} />
        </Link>
      </div>
    </div>
  );
}

/**
 * One question in the FAQ, as a ruled row INSIDE the section's surface. No box
 * of its own: a disclosure is a row of a list, and giving each one a surface
 * would put six objects on screen where there is one.
 *
 * The hover affordance is a brand underline on the question — a link underline
 * is the sanctioned decorative use of the brand hue, because it is drawn on
 * something you can genuinely click.
 */
function Faq({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rule first:border-t-0">
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
