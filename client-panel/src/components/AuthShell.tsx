import { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ShieldCheck, Zap, Wallet } from 'lucide-react';
import BrandMark from './BrandMark';
import DepthField from './DepthField';
import ThemeToggle from './ThemeToggle';
import { BRAND_NAME } from '@/lib/brand';
import { useReveal, revealDelay } from '@/lib/useReveal';

interface AuthShellProps {
  /** The step's headline. Set as the page <h1> in .h-section display type. */
  title: string;
  /** Standfirst under the title, on the reading measure. */
  subtitle?: ReactNode;
  /** The form (or the terminal state) for this step. Rendered ON the surface. */
  children: ReactNode;
  /**
   * The "no account? / have an account?" switch. Rendered UNDER the surface,
   * on the bare canvas — see the note on enclosure below.
   */
  footer?: ReactNode;

  /**
   * The running head naming this step — "Sign in", "New account", "Password
   * reset". Sits above the headline and is how a reader knows which part of
   * the funnel they are in.
   */
  runhead?: string;
  /**
   * Replaces the default standing matter in the supporting column. Pass `null`
   * to drop the column entirely; the form column does NOT re-centre or widen,
   * because every step in the funnel must present the same object in the same
   * place.
   */
  aside?: ReactNode;
  /**
   * Widen the form column for a step whose content is a table or a wide panel
   * rather than a stack of inputs. Nothing in the funnel needs it today; it is
   * kept because the column width is the only measure control the shell has.
   */
  wide?: boolean;
}

/**
 * One shell for the whole signed-out funnel — login, signup, verify, reset.
 *
 * THE FORM IS AN OBJECT ON A LIT FIELD. The outgoing version was a broadsheet:
 * a 7/12 form column against a 4/12 margin column of standing matter, the two
 * separated by a full column of gutter, everything printed straight onto paper
 * and structured by hairlines. It was well made and it is not this system. A
 * design built from rules has to be read to be understood; a design built from
 * surfaces is understood before it is read, and this is the screen where that
 * matters most — it is the first thing a returning merchant sees every morning
 * and the first thing a prospect sees after the landing page.
 *
 * So the four planes are assigned here exactly as they are in the app shell:
 *
 *   0 FIELD      <DepthField /> — the same drifting aurora, grid and grain that
 *                sits behind every signed-in route. The funnel and the product
 *                are now demonstrably the same room.
 *   1 CANVAS     the page, the headline block, the footer switch. Printed ON
 *                the field, no fill of their own.
 *   2 SURFACE    the form. One rim-lit panel, and the only raised thing on the
 *                page, so there is never a question about where to look.
 *   3 FLOATING   the masthead, as `.glass` chrome — matching Layout's topbar,
 *                which is what a merchant sees one route later.
 *
 * WHY THE HEADLINE IS NOT ON THE SURFACE. It is the same call PageHeader makes
 * on every signed-in route: the masthead is printed on the canvas and the first
 * surface below it draws the line between "where you are" and "what you do
 * here". Putting the h1 inside the panel would make the panel a page, and then
 * the page would need something else to be.
 *
 * WHY THE FOOTER IS NOT ON THE SURFACE EITHER. "Don't have an account?" is
 * navigation away from the task, not part of it. It used to need a hairline to
 * separate it from the form; the panel's own edge does that now for free, which
 * is precisely the trade the redesign is making everywhere — an edge instead of
 * a stroke.
 *
 * ORDER IS DELIBERATE: the form column comes FIRST in the DOM at every width.
 * A keyboard or screen-reader user reaches the field they came for before any
 * marketing, and the supporting column is a real <aside> landmark they can skip.
 * Below `lg` that column is not merely reordered, it is GONE — a phone gets the
 * form and nothing competing with it, and nothing that pushes the form down.
 *
 * MOTION. Only the supporting column reveals, and that is now structural rather
 * than a convention every page has to remember: useReveal()'s ref is attached
 * to the <aside> itself, so `.reveal` inside `children` is inert by
 * construction. /login is opened daily by merchants already reaching for the
 * password field, and fading their form in taxes them for arriving.
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
  // Scoped to the supporting column ONLY. useReveal observes once, on mount —
  // see the warning on StandingMatter — and pointing it at the <aside> means a
  // page can no longer accidentally hide a conditionally-rendered form field
  // behind an observer that has already finished collecting its targets.
  const asideRef = useReveal<HTMLElement>();

  /**
   * THE FORM MEASURE, and it is the grid track rather than a max-width on the
   * content. 28rem is wide enough for a label, a field and an inline error and
   * narrow enough that the eye does not travel to find the next input. The
   * second track takes whatever is left, so dropping the aside leaves the panel
   * exactly where it was instead of sliding it to the middle of the screen.
   *
   * Both class strings are written out in full: Tailwind scans source TEXT, and
   * a grid-template assembled from fragments at runtime is a class it never
   * sees and therefore never emits.
   */
  const track = wide
    ? 'lg:grid-cols-[minmax(0,36rem)_minmax(0,1fr)]'
    : 'lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]';
  // Below `lg` the grid is a single column that would otherwise run the full
  // container, so the same measure is enforced as a cap — and centred, because
  // a 28rem column ranged left in a 768px tablet viewport reads as a mistake.
  const cap = wide ? 'max-w-[36rem]' : 'max-w-[28rem]';

  return (
    <div className="relative flex min-h-dvh flex-col">
      {/* PLANE 0. `min-h-dvh` and not `min-h-screen`: on mobile Safari `vh` is
          taller than the visible viewport, which is how a footer ends up behind
          the browser's own chrome. */}
      <DepthField />

      {/* PLANE 3 — the same glass chrome as the signed-in topbar, down to the
          border reset. `.glass` rings all four sides; only the bottom edge is
          wanted on a full-bleed bar. */}
      <header className="glass sticky top-0 z-30 shrink-0 border-x-0 border-t-0">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
          <BrandMark to="/" size="sm" />
          <ThemeToggle />
        </div>
      </header>

      {/* `justify-center` optically centres a short step (sign in is ~26rem of
          content) without trapping a tall one: `flex-1` items keep their auto
          min-height, so a long form simply grows the element and the centring
          stops applying rather than pushing the top out of reach. */}
      <main className="relative z-10 flex flex-1 flex-col justify-center px-4 py-10 sm:px-6 sm:py-14">
        <div className={`mx-auto grid w-full max-w-5xl gap-x-16 gap-y-12 ${track}`}>
          {/* ========================= FORM COLUMN =========================
              First in the DOM at every width. See the note above. */}
          <div className={`mx-auto w-full min-w-0 ${cap} lg:mx-0 lg:max-w-none`}>
            <span className="runhead">{runhead}</span>

            {/*
              ASCENDER ROOM, AND IT HAS TO BE IN `em`.
              `.h-section` runs a fluid clamp at line-height 1.06, while Geist's
              ink box is ~1.21em — so the glyphs deliberately overflow their own
              line box by ~0.075em at top and bottom. That is what makes display
              type sit tight, and it is also why "Welcome back" came back with
              its W and its b clipped: anything that paints to the element's box
              rather than to the line box (an `overflow: hidden` ancestor, or
              `background-clip: text`, which is how `.text-gradient` works)
              cuts the ascenders straight off. A padding in `em` scales with the
              clamp, so the room is correct at 30px and at 52px alike — a `pt-1`
              in pixels would be right at exactly one viewport width.
            */}
            <h1 className="h-section mt-2 pt-[0.09em]">{title}</h1>

            {subtitle && <p className="lede measure mt-3">{subtitle}</p>}

            {/* PLANE 2. The one raised thing on the page.

                NOT a `.spot`. The cursor-follow highlight belongs on small
                discrete objects that read as tiles; lighting a single 28rem
                panel that fills the reader's whole field of view is a wash, not
                a highlight — the same call Section.tsx makes and for the same
                reason. It would also cost the rim: `.spot::after` and
                `.surface::after` are the same pseudo-element, so wearing both
                replaces the specular top edge with the spotlight's gradient. */}
            <div className="surface mt-6 p-5 sm:p-7">{children}</div>

            {footer && (
              <div className="mt-5 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                {footer}
              </div>
            )}
          </div>

          {/* ====================== SUPPORTING COLUMN ======================
              Quiet type on the bare canvas, so it can never compete with the
              lit panel however much copy a step puts in it. Dropped outright
              below `lg` rather than reflowed under the form: on a phone this is
              material the reader did not come for, and stacking it would push
              the thing they did come for off the first screen. */}
          {aside && (
            <aside ref={asideRef} className="hidden min-w-0 lg:block">
              {aside}
            </aside>
          )}
        </div>
      </main>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * THE FUNNEL'S NOTICE
 * -------------------------------------------------------------------------- */

/**
 * A state message on a surface — six screens used to hand-roll this and they
 * had drifted into four different treatments (a marginal 2px rule, a bare
 * coloured line, a tinted box, a bordered top stroke).
 *
 * ON A SURFACE A BARE COLOURED SENTENCE READS AS A LABEL, not as a state. It
 * needs a shape, which is the same argument `.st` makes for the status lozenge:
 * a tint mixed from the tone, a hairline ring inset so it cannot shift layout,
 * and a radius that belongs to the same scale as the panel it sits on.
 *
 * THREE CARRIERS, NEVER ONE. The sentence says what happened, the icon says
 * what kind of thing happened, and the hue confirms both — so the message
 * survives a monochrome screen and a red/green-blind reader intact.
 *
 * The tones are the product's, not this file's: red is money or work that
 * failed, amber is waiting on someone, emerald is verified. Brand appears
 * nowhere here, because brand means "you can act on this" and a notice is not
 * an action.
 */
export function Notice({
  tone,
  icon: Icon = AlertCircle,
  live = 'alert',
  children,
}: {
  tone: 'failed' | 'waiting' | 'ok';
  icon?: typeof AlertCircle;
  /** `alert` interrupts, `status` waits its turn. A success is not an alert. */
  live?: 'alert' | 'status';
  children: ReactNode;
}) {
  // Text takes the 600 step on paper and the 400 step on ink, per the ramp —
  // the 500 step never carries text in this product. The fill and the ring are
  // not text, so they stay on 500/400 where the hue is strongest.
  const tones = {
    failed:
      'bg-red-500/10 text-red-600 ring-red-500/20 dark:bg-red-400/10 dark:text-red-400 dark:ring-red-400/25',
    waiting:
      'bg-amber-500/10 text-amber-600 ring-amber-500/20 dark:bg-amber-400/10 dark:text-amber-400 dark:ring-amber-400/25',
    ok: 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/20 dark:bg-emerald-400/10 dark:text-emerald-400 dark:ring-emerald-400/25',
  }[tone];

  return (
    <div
      role={live}
      className={`flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-sm leading-relaxed ring-1 ring-inset ${tones}`}
    >
      {/* `min-w-0` so the text can shrink inside the flex row at all, and
          `break-words` because the sentence is often the SERVER's — a message
          carrying a token, an address or a URL is one unbreakable string, and
          on a 360px panel that drags the whole page sideways. */}
      <Icon size={16} className="mt-px shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * THE DEFAULT SUPPORTING COLUMN
 * -------------------------------------------------------------------------- */

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
 * The default supporting column: a running head, the one figure worth stating,
 * and three claims.
 *
 * IT STAYS ON THE CANVAS, deliberately, and this is the whole reason the page
 * has a hierarchy at all. Putting this on a second surface would give the eye
 * two lit objects of equal standing and the form would stop being the point.
 * Depth is the hierarchy here; size and position are not doing that job.
 *
 * The hairlines that divide the claims are the sanctioned use of a rule in this
 * system — dividing WITHIN a block, never structuring the page — and they fall
 * BETWEEN items only, the way the ledger's rows do. A rule under the figure
 * would have been a fifth edge on a page that already has enough.
 *
 * The figure is `0`, and it is the honest one: non-custody is the claim the
 * whole product rests on and it is true on every screen in the funnel, which a
 * step-count or an approval-queue figure would not be. It takes the brand →
 * accent gradient because it is the one figure this column is built around,
 * which is exactly what `.text-gradient` is for.
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

      <div className="reveal mt-6">
        <span className="figure-xl text-gradient">0</span>
        <span className="figure-label measure">
          keys held here. Every payment settles to a wallet you control — this
          account never takes custody of your funds.
        </span>
      </div>

      <ul className="mt-10">
        {points.map(({ icon: Icon, title, body }, i) => (
          <li
            key={title}
            className="reveal rule py-5 first:border-t-0 first:pt-0"
            style={revealDelay(i + 1)}
          >
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
