import { Link } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import DepthField from '@/components/DepthField';
import { BRAND_NAME } from '@/lib/brand';

/**
 * The dead end.
 *
 * This route sits OUTSIDE the app shell — it has to, because a signed-out
 * visitor who mistypes a URL must still reach it — which means it gets no
 * sidebar, no topbar and, until now, no depth field either. That was the whole
 * reason it read as a different product: every other page in the panel floats
 * on a lit field and this one was type on a flat rectangle. It mounts its own
 * `<DepthField />` now, and the content sits on a single surface, so the 404 is
 * recognisably the same instrument as the page the merchant meant to reach.
 *
 * Still ranged left rather than centred. Centred type with a coloured numeral
 * above it is the house style of every 404 on the internet, and this page is
 * the one place a merchant meets us having already made a mistake, so it should
 * read as calm and typeset rather than as an apology poster.
 *
 * TWO CORRECTIONS, both of which shipped and both of which survive the
 * redesign:
 *
 *   1. The 404 was painted in brand. Brand is interactive only — it is the
 *      colour of things you can click, and a numeral you cannot click wearing
 *      it teaches the reader the opposite. It is ink now, and the only brand on
 *      the page is on the button.
 *   2. The only way out was "Back to dashboard", but this route is OUTSIDE
 *      ProtectedRoute — a signed-out visitor who mistypes a URL was offered a
 *      link that bounces them straight to the login screen. The destination
 *      follows the session.
 *
 * `dvh`, NOT `vh`. On mobile Safari `vh` measures the viewport without the
 * collapsing toolbar, so `min-h-screen` reserves more height than the visitor
 * can actually see and pushes the two ways out below the fold on the one screen
 * whose entire job is to offer them.
 *
 * No entrance animation: nothing here is worth watching arrive.
 */
export default function NotFound() {
  const { isAuthenticated } = useAuth();

  const primary = isAuthenticated
    ? { to: '/dashboard', label: 'Back to dashboard' }
    : { to: '/', label: 'Go to the home page' };
  const secondary = isAuthenticated
    ? { to: '/payments', label: 'All payments' }
    : { to: '/login', label: 'Sign in' };

  return (
    <div className="relative flex min-h-dvh items-center px-4 py-12 sm:px-8 sm:py-16">
      <DepthField />

      {/* `z-10` puts the content above the field and its grain, which are fixed
          at z-index 0 and 1 — the same stacking the app shell uses. */}
      <main className="relative z-10 mx-auto w-full max-w-2xl">
        <div className="surface p-5 sm:p-8">
          <span className="runhead">Not found</span>
          <div className="rule-strong mt-3" aria-hidden />

          <p className="figure-xl mt-8">404</p>

          <h1 className="mt-6 text-2xl font-semibold tracking-[-0.02em] text-slate-900 dark:text-slate-50">
            This page could not be found.
          </h1>
          <p className="measure mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
            The address may have been mistyped, or the page may have moved. Nothing
            has happened to your account, and no payment was affected by landing
            here.
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link to={primary.to} className="btn-primary">
              {primary.label}
            </Link>
            <Link to={secondary.to} className="btn-secondary">
              {secondary.label}
            </Link>
          </div>

          <p className="measure mt-10 border-t border-[var(--line-soft)] pt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {BRAND_NAME} — if you reached this from a link inside the product, it is
            worth telling us: an internal link that 404s is a bug on our side, not
            yours.
          </p>
        </div>
      </main>
    </div>
  );
}
