import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Menu, X, ArrowRight } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import BrandMark from './BrandMark';
import ThemeToggle from './ThemeToggle';
import { getAssets, getNetworks, getSignupStatus, networkLabel } from '@/lib/api';
import { BRAND_NAME } from '@/lib/brand';
import { useAuth } from '@/context/AuthContext';

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
 * Set as a MASTHEAD, not a floating app bar. The flag sits left, the section
 * nav hangs off it behind a vertical hairline, and the whole thing stands on a
 * horizontal rule rather than a drop shadow — a shadow says "this panel is
 * above the page", a rule says "the page starts here", and the second is the
 * true statement. The active section is marked by an ink bar sitting ON that
 * rule, the way a newspaper marks the section you are reading.
 *
 * The "Get started" call to action is hidden entirely when the gateway has
 * SIGNUP_ENABLED=false — better to show no door than one that 404s.
 */
export default function MarketingLayout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const location = useLocation();
  const { isAuthenticated } = useAuth();

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

  // The rule under the masthead is permanent; what scrolling adds is the paper
  // behind it, so type from the page cannot run underneath the nav.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-brand-600 focus:px-4 focus:py-2 focus:text-white"
      >
        Skip to content
      </a>

      <header
        className={`sticky top-0 z-40 border-b transition-colors ${
          scrolled
            ? 'border-slate-200 bg-white/85 backdrop-blur-xl dark:border-slate-800 dark:bg-slate-950/85'
            : 'border-slate-200/70 dark:border-slate-800/70'
        }`}
      >
        {/* Reading progress, driven by the root scroller via scroll-timeline —
            no scroll listener, so it cannot jank the main thread. Purely
            decorative, hence aria-hidden; browsers without scroll-timeline get
            a scaleX(0) bar, i.e. nothing, which is the correct fallback. */}
        <div
          className="motion-keep scroll-progress absolute inset-x-0 bottom-0 h-px origin-left scale-x-0 bg-gradient-to-r from-brand-500 to-accent-500"
          aria-hidden
        />
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-4 px-5 sm:px-8">
          <BrandMark to="/" size="sm" />

          {/* The vertical hairline that separates the flag from the sections.
              Cheap, and it is the whole difference between a masthead and a
              row of links that happens to have a logo at one end. */}
          <span
            className="hidden h-7 w-px shrink-0 bg-slate-200 md:block dark:bg-slate-800"
            aria-hidden
          />

          <nav className="hidden h-full items-stretch md:flex" aria-label="Main">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.to === '/'}
                className={({ isActive }) =>
                  `group relative flex items-center px-3.5 text-xs font-medium uppercase tracking-[0.14em] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 ${
                    isActive
                      ? 'text-slate-900 dark:text-slate-50'
                      : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    {l.label}
                    {/* Sits ON the masthead rule. scaleX from the left edge, so
                        it draws rather than fades — transform only, never a
                        width transition. */}
                    <span
                      aria-hidden
                      className={`absolute inset-x-2.5 -bottom-px h-0.5 origin-left transition-transform duration-200 ${
                        isActive
                          ? 'scale-x-100 bg-slate-900 dark:bg-slate-50'
                          : 'scale-x-0 bg-slate-300 group-hover:scale-x-100 dark:bg-slate-700'
                      }`}
                      style={{ transitionTimingFunction: 'var(--ease-out)' }}
                    />
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <span
              className="hidden h-7 w-px shrink-0 bg-slate-200 sm:block dark:bg-slate-800"
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
            <button
              type="button"
              className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 md:hidden dark:text-slate-300 dark:hover:bg-slate-800"
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            >
              {menuOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>

        {/* Mobile: a ruled index, not a stack of tinted pills. */}
        {menuOpen && (
          <div className="border-t border-slate-200 bg-white md:hidden dark:border-slate-800 dark:bg-slate-950">
            <nav className="mx-auto w-full max-w-6xl px-5 pb-5 sm:px-8" aria-label="Mobile">
              {links.map((l) => (
                <Link
                  key={l.to}
                  to={l.to}
                  className="rule flex items-center justify-between py-3.5 text-xs font-medium uppercase tracking-[0.14em] text-slate-700 first:border-t-0 dark:text-slate-300"
                >
                  {l.label}
                  <ArrowRight size={14} className="text-slate-400" />
                </Link>
              ))}
              <div className="rule mt-4 flex flex-col gap-2 pt-5">
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
          </div>
        )}
      </header>

      <main id="main">
        <Outlet />
      </main>

      {/* ============================== FOOTER ==============================
          Opened by .rule-strong — the ink stroke that closes the page the way
          a masthead opens it. Three bands on the same asymmetric 12-column
          grid the pages use: the directory, the live capability readout, and
          the colophon.

          DELIBERATELY NO .reveal HERE, on a marketing route that otherwise
          permits it. A scroll-driven reveal on an element at the very bottom
          of the document cannot finish: at maximum scroll a footer band of
          height h has only travelled h/(viewport + h) of its view() timeline,
          and `animation-range: ... cover 34%` needs 34% of it. A short band on
          a tall screen would sit permanently half-faded. The footer is also
          chrome — it is on every public route, so by the Frequency Boundary it
          is the last thing on these pages that should be animating. */}
      <footer className="rule-strong bg-white dark:bg-slate-950">
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
          <div className="band grid gap-8 md:grid-cols-12 md:gap-8">
            <div className="col-aside">
              <span className="runhead">Live capability</span>
              <p className="mt-3">
                Read from this deployment when the page loaded, not written into
                the page. Switch a chain off server-side and it leaves this list
                on the next visit.
              </p>
            </div>

            <div className="md:col-span-9">
              <div className="grid gap-10 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-end sm:gap-14">
                <div>
                  <span className="figure-xl">{assetCount ?? '—'}</span>
                  <span className="figure-label">
                    assets currently enabled,
                    <br />
                    across every live network
                  </span>
                </div>

                <div>
                  <span className="runhead">Networks</span>
                  {chains.length > 0 ? (
                    <ul className="mt-3">
                      {chains.map((n) => (
                        <li
                          key={n}
                          className="rule flex items-center justify-between gap-4 py-2 first:border-t-0"
                        >
                          <span className="text-sm text-slate-700 dark:text-slate-300">
                            {networkLabel(n)}
                          </span>
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.12em] text-emerald-700 dark:text-emerald-400">
                            <span
                              className="h-1.5 w-1.5 rounded-full bg-emerald-500"
                              aria-hidden
                            />
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
              </div>
            </div>
          </div>

          {/* --- Band 3: colophon ------------------------------------------ */}
          <div className="rule grid gap-6 py-10 md:grid-cols-12 md:gap-8">
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
      <ul className="mt-4 space-y-2.5">
        {items.map((i) => (
          <li key={i.to + i.label}>
            <Link
              to={i.to}
              className="rounded-sm text-sm text-slate-600 underline decoration-transparent decoration-1 underline-offset-[3px] outline-none transition-colors hover:text-slate-900 hover:decoration-brand-600 focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:decoration-brand-400"
            >
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
