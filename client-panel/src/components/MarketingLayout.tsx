import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Menu, X, ArrowRight } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import BrandMark from './BrandMark';
import ThemeToggle from './ThemeToggle';
import { getSignupStatus } from '@/lib/api';
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

  // Close the mobile menu on navigation, otherwise it covers the new page.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  // Header gains a border + blur once the page is scrolled, so it separates
  // from the hero without being a hard bar at rest.
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
        className={`sticky top-0 z-40 transition-colors ${
          scrolled
            ? 'border-b border-slate-200/80 bg-white/80 backdrop-blur-xl dark:border-slate-800/80 dark:bg-slate-950/80'
            : 'border-b border-transparent'
        }`}
      >
        {/* Reading progress, driven by the root scroller via scroll-timeline —
            no scroll listener, so it cannot jank the main thread. Purely
            decorative, hence aria-hidden; browsers without scroll-timeline get
            a scaleX(0) bar, i.e. nothing, which is the correct fallback. */}
        <div
          className="scroll-progress absolute inset-x-0 bottom-0 h-px origin-left scale-x-0 bg-gradient-to-r from-brand-500 to-accent-500"
          aria-hidden
        />
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5 sm:px-8">
          <BrandMark to="/" size="sm" />

          <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.to === '/'}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-2 text-sm font-medium transition ${
                    isActive
                      ? 'text-brand-700 dark:text-brand-300'
                      : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
                  }`
                }
              >
                {l.label}
              </NavLink>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <ThemeToggle />
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

        {menuOpen && (
          <div className="border-t border-slate-200 bg-white px-5 py-4 md:hidden dark:border-slate-800 dark:bg-slate-950">
            <nav className="flex flex-col gap-1" aria-label="Mobile">
              {links.map((l) => (
                <Link
                  key={l.to}
                  to={l.to}
                  className="rounded-lg px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  {l.label}
                </Link>
              ))}
              <div className="mt-3 flex flex-col gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
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

      <footer className="border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
        <div className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8">
          <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-xs">
              <BrandMark size="sm" />
              <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
                Accept stablecoins, native coins and Bitcoin across four chains.
                Non-custodial deposit addresses, signed webhooks, and settlement
                to a wallet you control.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-8 text-sm sm:grid-cols-3">
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
          <p className="mt-10 border-t border-slate-200 pt-6 text-xs text-slate-400 dark:border-slate-800">
            Crypto is volatile and transactions are irreversible. Settlement times
            depend on network confirmations.
          </p>
        </div>
      </footer>
    </div>
  );
}

function FooterCol({
  title,
  items,
}: {
  title: string;
  items: { to: string; label: string }[];
}) {
  return (
    <div>
      <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
        {title}
      </p>
      <ul className="space-y-2">
        {items.map((i) => (
          <li key={i.to + i.label}>
            <Link
              to={i.to}
              className="text-slate-600 transition hover:text-brand-600 dark:text-slate-400 dark:hover:text-brand-400"
            >
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
