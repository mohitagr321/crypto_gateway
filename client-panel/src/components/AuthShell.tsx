import { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, Zap, Wallet } from 'lucide-react';
import BrandMark from './BrandMark';
import ThemeToggle from './ThemeToggle';
import { BRAND_NAME } from '@/lib/brand';
import { useReveal, revealDelay } from '@/lib/useReveal';

interface AuthShellProps {
  /** The step's headline. Set as the page <h1> in .h-section display type. */
  title: string;
  /** Standfirst under the title, on the reading measure. */
  subtitle?: ReactNode;
  /** The form (or the terminal state) for this step. */
  children: ReactNode;
  /** Rendered under the form on its own hairline — the "no account? / have an
   *  account?" switch. Ranged LEFT now, not centred. */
  footer?: ReactNode;

  /* ---------------- added in phase 4, all optional ---------------- */

  /**
   * The running head naming this step — "Sign in", "New account", "Password
   * reset". Sits above the masthead rule that opens the form column, and is
   * how a reader knows which part of the funnel they are in.
   */
  runhead?: string;
  /**
   * Replaces the default standing matter in the right-hand margin column.
   * Pass `null` to drop the column entirely (the form stays exactly where it
   * is — the frame does not re-centre, because every step in the funnel must
   * hang off the same left edge).
   */
  aside?: ReactNode;
  /**
   * Let `children` fill the whole main column instead of the 28rem form
   * measure. For a step whose content is a table or a wide panel rather than
   * a stack of inputs.
   */
  wide?: boolean;
}

/**
 * One shell for the whole signed-out funnel — login, signup, verify, reset.
 *
 * SET IN TYPE, NOT A CARD ON A GRADIENT. This used to be a centred 26rem column
 * facing a mesh-gradient panel of brand-tinted icon tiles. Both halves were
 * doing the thing the broadsheet direction exists to stop: the gradient and the
 * tinted tiles spent the brand hue on decoration, and a centred column with a
 * centred footer is the layout every auth template ships.
 *
 * What it is instead:
 *
 *   MASTHEAD          the wordmark and the theme control on one line, closed by
 *                     a hairline across the full page. The heavy stroke is
 *                     saved for the running head below, so the page never reads
 *                     as two competing headers (same call as Landing's hero).
 *   RUNNING HEAD      every step is labelled before it is titled.
 *   ASYMMETRY         a wide form column (7/12) against a narrow margin column
 *                     (4/12) with a full column of gutter between them — not a
 *                     52/48 split down the middle of the screen.
 *   RULES, NOT BOXES  the form is separated from its footer by one hairline
 *                     rather than enclosed in a border.
 *   A MEASURE         the standfirst runs to 62ch; the form runs to 28rem,
 *                     because an <input> stretched across 40rem is unusable
 *                     however editorial the page around it is.
 *
 * ORDER IS DELIBERATE: the form column comes FIRST in the DOM on every
 * viewport. A keyboard or screen-reader user reaches the field they came for
 * before the marketing column, and the margin column is a real <aside> landmark
 * they can skip.
 *
 * MOTION. Only the margin column reveals. The form, its heading and its footer
 * render at full opacity immediately — the funnel is a marketing route and
 * earns reveals under the frequency boundary in index.css, but /login is opened
 * daily by merchants who are already reaching for the password field, and
 * fading their form in taxes them for arriving.
 */
export default function AuthShell({
  title,
  subtitle,
  children,
  footer,
  runhead = 'Merchant account',
  aside = <StandingMatter />,
  wide = false,
}: AuthShellProps) {
  // Wired for the .reveal on the margin column below, and it also serves any
  // .reveal a page puts inside `children`. NOTE: useReveal observes ONCE on
  // mount — see the warning on StandingMatter.
  const revealRef = useReveal<HTMLElement>();

  // The form measure. Wide enough for a label + input + inline error, narrow
  // enough that the eye does not have to travel to find the next field.
  const formMeasure = wide ? '' : 'max-w-[28rem]';

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 dark:bg-slate-950">
      {/* ============================ MASTHEAD ============================
          Full-bleed hairline, page gutter matched to the grid below so the
          wordmark sits on exactly the same left edge as the headline. */}
      <header className="border-b border-slate-200 dark:border-slate-800">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-4 sm:px-8">
          <BrandMark to="/" size="sm" />
          <ThemeToggle />
        </div>
      </header>

      <main
        ref={revealRef}
        className="mx-auto w-full max-w-6xl flex-1 px-5 py-10 sm:px-8 sm:py-16"
      >
        <div className="grid gap-x-10 gap-y-16 lg:grid-cols-12">
          {/* ========================= FORM COLUMN ========================= */}
          <div className="lg:col-span-7">
            <span className="runhead">{runhead}</span>
            {/* The masthead gesture: one heavy stroke, under the label. */}
            <div className="rule-strong mt-3" aria-hidden />

            <h1 className="mt-6 h-section">{title}</h1>

            {subtitle && <p className="lede measure mt-4">{subtitle}</p>}

            <div className={`mt-8 ${formMeasure}`}>{children}</div>

            {/* No box, no centring: a hairline is the whole enclosure this
                needs, and it hangs off the same left edge as everything
                above it. */}
            {footer && (
              <div
                className={`rule mt-8 pt-5 text-sm leading-relaxed text-slate-600 dark:text-slate-400 ${formMeasure}`}
              >
                {footer}
              </div>
            )}
          </div>

          {/* ======================= MARGIN COLUMN =======================
              Standing matter, in the narrow column, with a full grid column
              of gutter against the form. Hidden below lg — a phone gets the
              form and nothing competing with it. */}
          {aside && (
            <aside className="hidden lg:col-span-4 lg:col-start-9 lg:block">
              {aside}
            </aside>
          )}
        </div>
      </main>
    </div>
  );
}

const points = [
  {
    icon: Wallet,
    title: 'Settle to your own wallet',
    body: 'Every payment gets a unique deposit address and is swept to the wallet you configure.',
  },
  {
    icon: Zap,
    title: 'Confirmed in minutes',
    body: 'A signed webhook hits your server the moment a payment reaches the confirmations that make it irreversible.',
  },
  {
    icon: ShieldCheck,
    title: 'Built for money movement',
    body: 'HMAC-signed requests, IP allowlists, scoped API keys and idempotent payment creation.',
  },
];

/**
 * The default margin column: a running head, the one figure worth stating, and
 * three claims as a RULED LIST rather than three brand-tinted icon tiles. The
 * icons survive at slate-400, the step documented for decorative icons — the
 * brand hue on this page belongs to the submit button and the links, and a
 * tinted tile behind an icon is exactly the decoration the rule forbids.
 *
 * The figure is `0`, and it is the honest one: non-custody is the claim the
 * whole product rests on and it is true on every screen in the funnel, which a
 * step-count or an approval-queue figure would not be.
 *
 * REVEALS HERE ARE SAFE because this markup mounts with the shell. Anything a
 * page renders CONDITIONALLY must not carry .reveal — useReveal() collects its
 * targets once, on mount, so an element that appears later is never observed
 * and stays at opacity 0 in browsers without scroll-driven animation.
 */
function StandingMatter() {
  return (
    <>
      <span className="runhead">Why {BRAND_NAME}</span>
      <div className="rule-strong mt-3" aria-hidden />

      <div className="reveal mt-8">
        <span className="figure-xl">0</span>
        <span className="figure-label">
          keys held here. Every payment settles to a wallet you control — this
          account never takes custody of your funds.
        </span>
      </div>

      <ul className="mt-10">
        {points.map(({ icon: Icon, title, body }, i) => (
          <li key={title} className="reveal rule py-5" style={revealDelay(i + 1)}>
            <div className="flex items-baseline gap-2.5">
              <Icon
                size={15}
                className="shrink-0 translate-y-0.5 text-slate-400"
                aria-hidden
              />
              <span className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                {title}
              </span>
            </div>
            <p className="measure mt-1.5 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              {body}
            </p>
          </li>
        ))}
      </ul>

      {/* Small print, set as small print. The link is REAL and focusable — the
          old panel was marked aria-hidden with this link still inside it,
          which put a tabbable control in a subtree hidden from assistive
          technology. */}
      <p
        className="reveal rule measure pt-5 text-xs leading-relaxed text-slate-500 dark:text-slate-400"
        style={revealDelay(4)}
      >
        Programmatic access uses an API key. This dashboard uses a short-lived
        session token — changing payout or credential settings always requires a
        signed-in session, never an API key.{' '}
        <Link to="/developers" className="link-ink">
          Read the developer guide
        </Link>
        .
      </p>
    </>
  );
}
