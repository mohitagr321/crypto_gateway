import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Menu, X, ArrowRight } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import BrandMark from './BrandMark';
import ThemeToggle from './ThemeToggle';
import DepthField from './DepthField';
import { getAssets, getNetworks, getSignupStatus, networkLabel } from '@/lib/api';
import { BRAND_NAME } from '@/lib/brand';
import { useAuth } from '@/context/AuthContext';
import { useSpotlight } from '@/lib/useSpotlight';

const links = [
  { to: '/', label: 'Overview' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/developers', label: 'Developers' },
];

/**
 * Chrome for the public (signed-out) pages. Deliberately separate from the
 * dashboard's Layout: this is a sales surface with a marketing header and
 * footer, not an app shell with a sidebar.
 *
 * THE MASTHEAD IS A FLOATING PLANE, and that is the whole difference from what
 * stood here before. The outgoing header was a rule the page hung from — a
 * broadsheet masthead, correct for a design made of hairlines and wrong for one
 * made of lit surfaces. A rule says "the page starts here"; on a design where
 * the page is printed on a depth field, the true statement is "this bar floats
 * above the page", and the z-plane law says exactly one treatment carries that:
 * `.glass` + `shadow-float`, on plane 3.
 *
 * IT IS INSET FROM THE VIEWPORT ON PURPOSE. A glass bar that runs edge to edge
 * reads as a fixed app chrome; one with air on three sides reads as an object
 * resting over the page, which is what makes the depth field behind it legible.
 * `sticky` rather than `fixed`, so the plane reserves its own space and no page
 * has to know the header's height to avoid being covered by it.
 *
 * GLASS BUDGET. Backdrop-filter repaints its backdrop every scroll frame, so
 * the system caps it at 3-4 live planes per viewport. The public site spends
 * exactly two: this masthead, and Landing's sticky mobile CTA — which never
 * share a viewport with a third, because nothing else on these pages is chrome.
 *
 * The "Get started" call to action is hidden entirely when the gateway has
 * SIGNUP_ENABLED=false — better to show no door than one that 404s.
 */
export default function MarketingLayout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const location = useLocation();
  const { isAuthenticated } = useAuth();

  // One delegated pointer listener for every `.spot` surface on the public
  // site. The dashboard's shell mounts this too; the marketing routes never
  // pass through that shell, so without this call every spotlit surface on the
  // landing page would sit permanently unlit — a silent failure, since the
  // surface underneath still paints and nothing looks broken.
  useSpotlight();

  const { data: signupEnabled } = useQuery({
    queryKey: ['signup-status'],
    queryFn: getSignupStatus,
    staleTime: 5 * 60_000,
  });

  // The footer's capability readout. Same query keys and staleTime as Landing
  // and Pricing use, so react-query serves all three from one request rather
  // than refetching per surface — and so the footer can never contradict the
  // hero about how many assets are live.
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

  const chains = networks ?? [];
  // Null rather than 0 while the probe is in flight: "0 assets" is a claim, and
  // it is the wrong one. The figure holds an em dash until the gateway answers.
  const assetCount = assets?.length ?? null;

  // Close the mobile menu on navigation, otherwise it covers the new page.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  // What scrolling changes is ELEVATION, not fill. The plane is glass from the
  // first frame — it is on plane 3 whether or not the page has moved — but at
  // rest it sits low over the hero and lifts once there is content travelling
  // underneath it. Only box-shadow animates, so nothing reflows.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="relative min-h-dvh text-slate-900 dark:text-slate-100">
      {/* Plane 0. The public site gets the same field the dashboard floats on —
          it is the ground the whole design is built against, and a marketing
          page that omitted it would be a different product's front door. */}
      <DepthField />

      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-brand-600 focus:px-4 focus:py-2 focus:text-white"
      >
        Skip to content
      </a>

      {/* The sticky element is this PADDING BOX, not the plane inside it. That
          is what gives the glass its air on three sides while still reserving
          flow space, so no page below has to know the header's height. */}
      <header className="sticky top-0 z-40 px-3 pt-3 sm:px-5 sm:pt-4">
        <div
          className={`glass mx-auto w-full max-w-6xl overflow-hidden rounded-2xl transition-shadow duration-[var(--dur-menu)] ease-[var(--ease-out)] ${
            scrolled ? 'shadow-float' : 'shadow-lift'
          }`}
        >
          <div className="relative flex h-14 items-center gap-2 px-3 sm:h-16 sm:gap-3 sm:px-4">
            {/* Reading progress, driven by the root scroller via scroll-timeline
                — no scroll listener, so it cannot jank the main thread. It is
                INFORMATION rather than decoration, which is why it survives
                prefers-reduced-motion (as a snap) and why it carries
                `.motion-keep`. aria-hidden because the same fact is available
                to a screen reader from the scroll position itself. Browsers
                without scroll-timeline get a scaleX(0) bar, i.e. nothing, which
                is the correct fallback. */}
            <div
              className="motion-keep scroll-progress absolute inset-x-0 bottom-0 h-0.5 origin-left scale-x-0 bg-gradient-to-r from-brand-500 to-accent-400"
              aria-hidden
            />

            <BrandMark to="/" size="sm" />

            <nav className="ml-3 hidden items-center gap-1 md:flex" aria-label="Main">
              {links.map((l) => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  end={l.to === '/'}
                  className={({ isActive }) =>
                    `nav-item ${isActive ? 'nav-item-on' : ''}`
                  }
                >
                  {l.label}
                </NavLink>
              ))}
            </nav>

            <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
              <ThemeToggle />
              <span
                className="hidden h-6 w-px shrink-0 bg-[var(--line)] sm:block"
                aria-hidden
              />
              {isAuthenticated ? (
                <Link to="/dashboard" className="btn-primary hidden sm:inline-flex">
                  Dashboard <ArrowRight size={16} />
                </Link>
              ) : (
                <>
                  <Link to="/login" className="btn-ghost hidden sm:inline-flex">
                    Sign in
                  </Link>
                  {signupEnabled && (
                    <Link to="/signup" className="btn-primary hidden sm:inline-flex">
                      Get started
                    </Link>
                  )}
                </>
              )}
              {/* 44px, not the 36px this was. The touch-target floor is not a
                  guideline on the one control that opens navigation on a phone
                  — it is the control every mobile visit starts at. */}
              <button
                type="button"
                className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-600 transition-colors duration-[var(--dur-press)] hover:bg-[var(--hover)] hover:text-slate-900 md:hidden dark:text-slate-300 dark:hover:text-slate-100"
                onClick={() => setMenuOpen((v) => !v)}
                aria-expanded={menuOpen}
                aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              >
                {menuOpen ? <X size={20} /> : <Menu size={20} />}
              </button>
            </div>
          </div>

          {/* Mobile: the index drops INSIDE the same glass plane rather than
              below it, so the header stays one object as it opens instead of
              becoming a bar with a panel stuck to its underside. */}
          {menuOpen && (
            <nav
              className="border-t border-[var(--line)] px-3 pb-3 pt-1 md:hidden"
              aria-label="Mobile"
            >
              {links.map((l) => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  end={l.to === '/'}
                  // `min-h-11` is 44px, the touch floor. `.nav-item` carries
                  // 38px, which is the DESKTOP relaxation — correct for a
                  // pointer beside a rail, wrong for the one list a phone
                  // navigates the whole site from.
                  className={({ isActive }) =>
                    `nav-item mt-1 min-h-11 justify-between ${isActive ? 'nav-item-on' : ''}`
                  }
                >
                  {l.label}
                  <ArrowRight size={14} className="text-slate-400" aria-hidden />
                </NavLink>
              ))}
              <div className="mt-3 flex flex-col gap-2 border-t border-[var(--line-soft)] pt-3">
                {isAuthenticated ? (
                  <Link to="/dashboard" className="btn-primary w-full">
                    Go to dashboard
                  </Link>
                ) : (
                  <>
                    <Link to="/login" className="btn-secondary w-full">
                      Sign in
                    </Link>
                    {signupEnabled && (
                      <Link to="/signup" className="btn-primary w-full">
                        Get started
                      </Link>
                    )}
                  </>
                )}
              </div>
            </nav>
          )}
        </div>
      </header>

      {/* Plane 1 — the canvas. Transparent, printed on the field. z-10 keeps it
          above the grain tile, which sits at z-index 1. */}
      <div className="relative z-10">
        <main id="main">
          <Outlet />
        </main>

        {/* ============================== FOOTER ==============================
            Three bands. The directory and the colophon are printed straight on
            the canvas — they are chrome, and chrome does not get a surface —
            but the LIVE CAPABILITY READOUT does, because it is the only part of
            the footer that is data. Giving it the same rim-lit surface the
            dashboard gives a metric tile is what tells a reader it is a
            measurement rather than a marketing line.

            DELIBERATELY NO .reveal HERE, on a marketing route that otherwise
            permits it. A scroll-driven reveal on an element at the very bottom
            of the document cannot finish: at maximum scroll a footer band of
            height h has only travelled h/(viewport + h) of its view() timeline,
            and `animation-range: ... cover 34%` needs 34% of it. A short band on
            a tall screen would sit permanently half-faded. The footer is also
            chrome — it is on every public route, so by the Frequency Boundary it
            is the last thing on these pages that should be animating. */}
        <footer className="mt-20 border-t border-[var(--line)] sm:mt-28">
          <div className="mx-auto w-full max-w-6xl px-5 sm:px-8">
            {/* --- Band 1: the flag and the directory ------------------------ */}
            <div className="grid gap-10 py-12 sm:py-16 md:grid-cols-12 md:gap-8">
              <div className="md:col-span-5">
                <BrandMark size="sm" />
                <p className="measure mt-5 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                  Non-custodial deposit addresses, signed webhooks, and settlement
                  to a wallet you control. No float held on your behalf, and no
                  approval queue standing between you and your first payment.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-8 sm:grid-cols-3 md:col-span-6 md:col-start-7">
                <FooterCol
                  title="Product"
                  items={[
                    { to: '/', label: 'Overview' },
                    { to: '/pricing', label: 'Pricing' },
                  ]}
                />
                <FooterCol
                  title="Developers"
                  items={[
                    { to: '/developers', label: 'API guide' },
                    { to: '/docs', label: 'Reference' },
                  ]}
                />
                <FooterCol
                  title="Account"
                  items={[
                    { to: '/login', label: 'Sign in' },
                    ...(signupEnabled ? [{ to: '/signup', label: 'Create account' }] : []),
                    { to: '/forgot-password', label: 'Reset password' },
                  ]}
                />
              </div>
            </div>

            {/* --- Band 2: the figure, and what it counts --------------------- */}
            <section className="surface spot grid gap-8 p-5 sm:p-7 md:grid-cols-12 md:gap-10">
              <div className="md:col-span-4">
                <h2 className="runhead">Live capability</h2>
                {/* min-w-0 so the figure can shrink inside its grid track. A
                    grid child defaults to min-width:auto and refuses to go
                    under its content, which is how a large numeral pushes a
                    whole row wider than the phone it is on. */}
                <div className="min-w-0">
                  <span className="figure-xl mt-4 break-words">{assetCount ?? '—'}</span>
                  <span className="figure-label measure">
                    assets currently enabled, across every live network. Read from
                    this deployment when the page loaded, not written into the
                    page — switch a chain off server-side and it leaves this list
                    on the next visit.
                  </span>
                </div>
              </div>

              <div className="md:col-span-7 md:col-start-6">
                <h3 className="runhead">Networks</h3>
                {chains.length > 0 ? (
                  <ul className="mt-2">
                    {chains.map((n) => (
                      <li key={n} className="spine-row">
                        <span className="text-sm text-slate-700 dark:text-slate-300">
                          {networkLabel(n)}
                        </span>
                        {/* emerald, and the WORD as well as the hue: this is
                            health, and colour is never the only carrier. */}
                        <span className="st text-emerald-600 dark:text-emerald-400">
                          <span className="st-dot" aria-hidden />
                          Live
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
                    Reading the gateway&rsquo;s enabled networks&hellip;
                  </p>
                )}
              </div>
            </section>

            {/* --- Band 3: colophon ------------------------------------------
                THE BOTTOM PADDING IS CLEARANCE, not taste. Landing mounts a
                fixed glass CTA bar on phones, and a fixed element reserves no
                flow space — so at maximum scroll it would sit on top of the
                copyright line. The clearance belongs HERE rather than as a
                spacer at the end of Landing: a spacer there only pushes
                Landing's own content up and leaves the footer, which comes
                after it, covered exactly as before. `lg:pb-10` gives it back on
                the widths where the bar does not render, and the safe-area
                inset keeps the last line clear of the iOS home indicator now
                that `viewport-fit=cover` extends the page under it. */}
            <div className="grid gap-6 pb-[calc(7rem+env(safe-area-inset-bottom))] pt-10 md:grid-cols-12 md:gap-8 lg:pb-[calc(2.5rem+env(safe-area-inset-bottom))]">
              <div className="col-aside">
                <span className="runhead">Legal</span>
              </div>
              <div className="md:col-span-9">
                <p className="measure-wide text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                  Crypto is volatile and transactions are irreversible. Settlement
                  times depend on network confirmations, and a payment is not final
                  until the chain says it is. {BRAND_NAME} does not custody your
                  funds: they settle to the wallet you configure, which means the
                  keys to it are your responsibility alone.
                </p>
                {/* slate-500, not the 400 step this line used to use: the ramp
                    documents 400 as 3.01:1 — input borders and decorative icons
                    only, never text. */}
                <p className="mt-6 text-xs text-slate-500 dark:text-slate-400">
                  &copy; {new Date().getFullYear()} {BRAND_NAME}
                </p>
              </div>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

/**
 * One column of the footer directory. The heading is a .runhead — slate, not
 * brand: it labels a group, and brand on this page means "you can click this".
 */
function FooterCol({
  title,
  items,
}: {
  title: string;
  items: { to: string; label: string }[];
}) {
  return (
    <div>
      <span className="runhead">{title}</span>
      {/* The ROW is the target, not the word. These used to be inline links on a
          10px rhythm — about 18px of tappable height each, which on a phone is a
          coin toss between two adjacent destinations. `flex min-h-11` makes each
          one a 44px band and the gap between rows disappears into it, so the
          column reads the same and stops missing. */}
      <ul className="mt-2">
        {items.map((i) => (
          <li key={i.to + i.label}>
            <Link
              to={i.to}
              className="flex min-h-11 items-center rounded-sm text-sm text-slate-600 underline decoration-transparent decoration-1 underline-offset-[3px] outline-none transition-colors hover:text-slate-900 hover:decoration-brand-600 focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:decoration-brand-400"
            >
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
