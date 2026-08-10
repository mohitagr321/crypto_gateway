import { Link } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { BRAND_NAME } from '@/lib/brand';

/**
 * The dead end.
 *
 * Set as a document like every other terminal screen in the product (see the
 * checkout's DeadEnd, which this deliberately rhymes with): a running head, one
 * heavy rule, the one figure worth stating, and the way out — ranged left, not
 * centred. Centred type with a coloured numeral above it is the house style of
 * every 404 on the internet, and this page is the one place a merchant meets us
 * having already made a mistake, so it should read as calm and typeset rather
 * than as an apology poster.
 *
 * TWO CORRECTIONS, both of which shipped:
 *
 *   1. The 404 was painted in brand. Brand is interactive only — it is the
 *      colour of things you can click, and a numeral you cannot click wearing
 *      it teaches the reader the opposite. It is ink now, and the only brand on
 *      the page is on the button.
 *   2. The only way out was "Back to dashboard", but this route is OUTSIDE
 *      ProtectedRoute — a signed-out visitor who mistypes a URL was offered a
 *      link that bounces them straight to the login screen. The destination now
 *      follows the session.
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
    <div className="flex min-h-screen items-center bg-slate-50 px-5 py-16 dark:bg-slate-950 sm:px-8">
      <main className="mx-auto w-full max-w-2xl">
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

        <p className="rule measure mt-12 pt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          {BRAND_NAME} — if you reached this from a link inside the product,
          it is worth telling us: an internal link that 404s is a bug on our
          side, not yours.
        </p>
      </main>
    </div>
  );
}
