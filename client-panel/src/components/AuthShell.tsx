import { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, Zap, Wallet } from 'lucide-react';
import BrandMark from './BrandMark';
import ThemeToggle from './ThemeToggle';

interface AuthShellProps {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  /** Rendered under the card — the "no account? / have an account?" switch. */
  footer?: ReactNode;
}

const points = [
  {
    icon: Wallet,
    title: 'Settle to your own wallet',
    body: 'Every payment gets a unique deposit address and is swept to the wallet you control. We never hold your keys.',
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
 * One shell for the whole signed-out funnel — login, signup, verify, reset.
 *
 * Before this, Login was a standalone centred card and there was nothing else;
 * putting every step in the same split layout is what makes the funnel read as
 * one product rather than four unrelated forms. The right-hand panel is
 * decorative and hidden below `lg`, so mobile gets a clean single column.
 */
export default function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: AuthShellProps) {
  return (
    <div className="flex min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* ---- Form side ---- */}
      <div className="flex w-full flex-col lg:w-[52%]">
        <div className="flex items-center justify-between px-6 py-5 sm:px-10">
          <BrandMark to="/" size="sm" />
          <ThemeToggle />
        </div>

        <div className="flex flex-1 items-center justify-center px-5 pb-12 sm:px-10">
          <div className="w-full max-w-[26rem]">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl dark:text-slate-50">
              {title}
            </h1>
            {subtitle && (
              <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                {subtitle}
              </p>
            )}

            <div className="mt-7">{children}</div>

            {footer && (
              <div className="mt-6 text-center text-sm text-slate-600 dark:text-slate-400">
                {footer}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ---- Brand side (decorative; hidden on small screens) ---- */}
      <aside
        className="relative hidden overflow-hidden border-l border-slate-200 bg-white bg-mesh lg:flex lg:w-[48%] dark:border-slate-800 dark:bg-slate-900"
        aria-hidden
      >
        <div className="absolute inset-0 bg-grid" />
        <div className="relative flex flex-col justify-center gap-8 px-14 py-16">
          <div>
            <p className="eyebrow">Crypto payment gateway</p>
            <p className="mt-3 max-w-sm text-3xl font-bold leading-tight tracking-tight text-slate-900 dark:text-slate-50">
              Take crypto payments <span className="text-gradient">without giving up custody</span>.
            </p>
          </div>

          <ul className="flex max-w-md flex-col gap-5">
            {points.map(({ icon: Icon, title: t, body }) => (
              <li key={t} className="flex gap-3.5">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-600/10 text-brand-600 dark:bg-brand-400/10 dark:text-brand-400">
                  <Icon size={17} />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {t}
                  </span>
                  <span className="mt-0.5 block text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                    {body}
                  </span>
                </span>
              </li>
            ))}
          </ul>

          <p className="max-w-md text-xs leading-relaxed text-slate-500 dark:text-slate-500">
            Programmatic access uses an API key. This dashboard uses a short-lived
            session token — changing payout or credential settings always requires
            a signed-in session, never an API key.{' '}
            <Link to="/developers" className="text-brand-600 hover:underline dark:text-brand-400">
              Read the developer guide
            </Link>
            .
          </p>
        </div>
      </aside>
    </div>
  );
}
