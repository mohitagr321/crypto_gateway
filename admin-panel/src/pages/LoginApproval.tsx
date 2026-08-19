import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Check,
  Clock,
  Globe,
  Laptop,
  MonitorSmartphone,
  Smartphone,
  Tablet,
  X,
} from 'lucide-react';
import Spinner from '@/components/Spinner';
import DepthField from '@/components/DepthField';
import ThemeToggle from '@/components/ThemeToggle';
import PayCrypoMark from '@/components/PayCrypoMark';
import { BRAND_NAME, BRAND_CONSOLE_LABEL } from '@/lib/brand';
import { decideApproval, apiErrorMessage, getApprovalRequest } from '@/lib/api';
import type { ApprovalRequest } from '@/types';

const KIND_ICON: Record<string, typeof Laptop> = {
  desktop: Laptop,
  mobile: Smartphone,
  tablet: Tablet,
  unknown: MonitorSmartphone,
};

/**
 * THE DECISION PAGE — what the link in the approval email opens.
 *
 * WHY A PAGE AND NOT A ONE-CLICK LINK. Mail providers and corporate gateways
 * FETCH the links in a message to scan them, within seconds of delivery. A link
 * that approved on sight would therefore be approved by a robot before the
 * account holder ever opened the mail, which would reduce the whole mechanism to
 * decoration. Loading this page changes nothing; the decision is a POST behind a
 * button that a scanner will not press.
 *
 * IT RESTATES THE DEVICE DETAILS rather than trusting that the email was read.
 * This is the last screen before a session exists, it is the one the person is
 * actually looking at, and "approve" has to be an informed answer — the email
 * may have been skimmed on a lock screen.
 *
 * REJECT IS A PEER OF APPROVE, not a footnote. The moment someone reads this is
 * the moment they are best placed to stop an attacker who already has the
 * password, so both answers are full-width buttons and neither is styled as the
 * obvious one to press. Approve carries the brand fill because it is the
 * affirmative action; reject is not hidden behind "if this wasn't you…" prose.
 *
 * IT DELIBERATELY SHOWS NOTHING ABOUT THE ACCOUNT — no email address, no
 * business name. Anyone holding the link can load this page, and the link
 * travelled through mail servers to get here. It answers "what am I approving",
 * never "whose account is this".
 */
export default function LoginApproval() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [req, setReq] = useState<ApprovalRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [done, setDone] = useState<'approved' | 'rejected' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError('This link is missing its token.');
      setLoading(false);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const data = await getApprovalRequest(token);
        if (alive) setReq(data);
      } catch (err) {
        if (alive) setError(apiErrorMessage(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  const answer = async (decision: 'approve' | 'reject') => {
    setBusy(decision);
    setError(null);
    try {
      await decideApproval(token, decision);
      setDone(decision === 'approve' ? 'approved' : 'rejected');
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const body = () => {
    if (loading) {
      return (
        <div className="surface grid min-h-[12rem] place-items-center p-6">
          <Spinner label="Checking this request…" />
        </div>
      );
    }

    if (done) {
      return (
        <Result
          ok={done === 'approved'}
          title={done === 'approved' ? 'Sign-in approved' : 'Sign-in rejected'}
          body={
            done === 'approved'
              ? 'You can go back to the tab where you entered your password — it will continue on its own. This page is finished.'
              : 'Nothing was signed in. Whoever tried had your password, so change it now.'
          }
        />
      );
    }

    if (error && !req) {
      return <Result ok={false} title="Link not valid" body={error} />;
    }

    if (req && req.status !== 'pending') {
      const already = req.status === 'expired';
      return (
        <Result
          ok={false}
          title={already ? 'Request expired' : 'Already answered'}
          body={
            already
              ? 'This sign-in request timed out, so nothing was signed in. Start again from the panel.'
              : 'This request has already been answered. If that was not you, change your password now.'
          }
        />
      );
    }

    if (!req) return null;
    const Icon = KIND_ICON[req.deviceKind ?? 'unknown'] ?? MonitorSmartphone;

    return (
      <div className="surface p-5 sm:p-6">
        <h2 className="text-lg font-semibold tracking-[-0.02em] text-slate-900 dark:text-slate-50">
          Approve this sign-in?
        </h2>
        <p className="measure mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          Someone entered the correct password for this operator account from the device below.
          Nobody is signed in unless you approve it.
        </p>

        <dl className="well mt-4 divide-y divide-[var(--line-soft)] px-3.5">
          <Row icon={Icon} label="Device" value={req.device ?? 'Unrecognised device'} />
          <Row icon={Globe} label="IP address" value={req.ip ?? 'Unknown'} />
          <Row
            icon={Clock}
            label="Requested"
            value={new Date(req.requestedAt).toLocaleString()}
          />
        </dl>

        {error && (
          <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        {/* Both answers are full-width and stacked. Side by side at this size
            puts a destructive and a constructive action a thumb's width apart
            on the screen where that mistake costs the most. */}
        <div className="mt-5 space-y-2.5">
          <button
            type="button"
            onClick={() => answer('approve')}
            disabled={busy !== null}
            className="btn-primary w-full"
          >
            {busy === 'approve' ? <Spinner size={16} /> : <Check size={16} />}
            Yes, this was me
          </button>
          <button
            type="button"
            onClick={() => answer('reject')}
            disabled={busy !== null}
            className="btn-danger w-full"
          >
            {busy === 'reject' ? <Spinner size={16} /> : <X size={16} />}
            No — reject this sign-in
          </button>
        </div>

        <p className="mt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          If you did not just try to sign in, reject this and change your password —
          someone else knows it.
        </p>
      </div>
    );
  };

  // The shell is the console's own Login chrome, glyph for glyph: an operator
  // deciding whether to let a session exist must be able to see at a glance
  // that they are on the real console and not a lookalike.
  return (
    <div className="relative flex min-h-dvh flex-col">
      <DepthField />

      <header className="glass sticky top-0 z-30 shrink-0 border-x-0 border-t-0 pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between gap-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))]">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-600 text-white shadow-[0_0_0_1px_oklch(var(--b-400)/0.35),0_6px_18px_-8px_oklch(var(--b-500)/0.85)]"
              aria-hidden
            >
              <PayCrypoMark size={17} />
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-[15px] font-semibold text-slate-900 dark:text-slate-50">
                {BRAND_NAME}
              </span>
              <span className="block truncate text-[11px] text-slate-500 dark:text-slate-400">
                {BRAND_CONSOLE_LABEL}
              </span>
            </span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="relative z-10 flex flex-1 flex-col justify-center px-4 pb-[calc(2.5rem+env(safe-area-inset-bottom))] pt-10 sm:px-6 sm:pt-14">
        <div className="mx-auto w-full min-w-0 max-w-[28rem]">
          <span className="runhead">Security</span>
          <h1 className="mt-1.5 text-[1.75rem] font-semibold leading-[1.1] tracking-[-0.035em] text-slate-900 sm:text-3xl dark:text-slate-50">
            Sign-in approval
          </h1>
          <p className="measure mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            Confirm that this sign-in attempt was you before any session is created.
          </p>
          <div className="mt-6">{body()}</div>
        </div>
      </main>
    </div>
  );
}

function Row({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Laptop;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <dt className="flex min-w-0 items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
        <Icon size={15} className="shrink-0 text-slate-400" aria-hidden />
        {label}
      </dt>
      <dd className="min-w-0 break-words text-right text-sm font-medium text-slate-900 dark:text-slate-100">
        {value}
      </dd>
    </div>
  );
}

function Result({ ok, title, body }: { ok: boolean; title: string; body: string }) {
  return (
    <div className="surface p-5 sm:p-6">
      <span
        className={`grid h-11 w-11 place-items-center rounded-xl ${
          ok
            ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
            : 'bg-red-500/12 text-red-600 dark:text-red-400'
        }`}
        aria-hidden
      >
        {ok ? <Check size={20} /> : <X size={20} />}
      </span>
      <h2 className="mt-4 text-lg font-semibold tracking-[-0.02em] text-slate-900 dark:text-slate-50">
        {title}
      </h2>
      <p className="measure mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        {body}
      </p>
    </div>
  );
}
