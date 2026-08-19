import { useEffect, useRef, useState } from 'react';
import { MailCheck, ShieldAlert, ShieldX } from 'lucide-react';
import { collectLogin, apiErrorMessage } from '@/lib/api';
import type { LoginResponse } from '@/types';

interface Props {
  challenge: string;
  /** "d****w@example.com" — which inbox to open, without printing the address. */
  sentTo: string;
  expiresAt: string;
  /** Hand the session up once the poll finds one. */
  onApproved: (res: LoginResponse) => void;
  /** Back to the form — rejected, expired, or the user changed their mind. */
  onCancel: () => void;
}

/** mm:ss, floored at zero. */
function countdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * THE WAITING ROOM. Shown after a correct password, while the account's mailbox
 * decides whether this sign-in happens.
 *
 * IT POLLS RATHER THAN PUSHES. A websocket would be the elegant answer and it is
 * the wrong trade here: it would mean holding an unauthenticated socket open for
 * every login attempt, including every failed credential-stuffing attempt, on
 * the one endpoint an attacker can reach without a session. A 2s poll against a
 * single indexed lookup is cheap, needs no new infrastructure, and degrades to
 * "the user waits two more seconds" when something goes wrong.
 *
 * THE CHALLENGE NEVER LEAVES THIS COMPONENT. It arrives as a prop, lives in
 * memory, and dies with the screen — deliberately not localStorage. Persisting
 * it would mean a stolen browser profile could finish somebody else's
 * half-completed sign-in, which is exactly the attack the approval exists to
 * stop.
 *
 * MOTION: none. This is a security screen, and a spinner on one reads as
 * "something is happening to your account" when the honest state is "nothing is
 * happening until you answer the email". The countdown moves because it is
 * information; nothing else does.
 */
export default function AwaitingApproval({
  challenge,
  sentTo,
  expiresAt,
  onApproved,
  onCancel,
}: Props) {
  const [state, setState] = useState<'waiting' | 'rejected' | 'expired'>('waiting');
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, new Date(expiresAt).getTime() - Date.now()),
  );

  // `onApproved` in a ref rather than in the effect's deps: the parent rebuilds
  // it on every render, and a changing dep would tear down and restart the poll
  // interval each time — resetting the cadence and, on a slow render loop,
  // stacking timers.
  const approvedRef = useRef(onApproved);
  approvedRef.current = onApproved;

  useEffect(() => {
    if (state !== 'waiting') return;
    let alive = true;

    const tick = async () => {
      try {
        const res = await collectLogin(challenge);
        if (!alive) return;
        if (res.accessToken) {
          approvedRef.current(res);
          return;
        }
        if (res.status === 'rejected') setState('rejected');
        else if (res.status === 'expired' || res.status === 'consumed') setState('expired');
      } catch (err) {
        // A transient failure must not end the wait — the approval is still
        // live server-side and the next tick may well succeed. Surface it and
        // keep polling.
        if (alive) setError(apiErrorMessage(err));
      }
    };

    void tick();
    const poll = setInterval(tick, 2000);
    const clock = setInterval(() => {
      const left = new Date(expiresAt).getTime() - Date.now();
      setRemaining(Math.max(0, left));
      if (left <= 0) setState('expired');
    }, 1000);

    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [challenge, expiresAt, state]);

  if (state === 'rejected') {
    return (
      <Outcome
        tone="bad"
        icon={ShieldX}
        title="Sign-in rejected"
        body="This attempt was rejected from your email. If that wasn't you, change your password now — someone else knows it."
        onCancel={onCancel}
      />
    );
  }

  if (state === 'expired') {
    return (
      <Outcome
        tone="mut"
        icon={ShieldAlert}
        title="Request expired"
        body="Nobody answered in time, so nothing was signed in. Start again when you're ready."
        onCancel={onCancel}
      />
    );
  }

  return (
    <div className="surface p-5 sm:p-6">
      <span
        className="grid h-11 w-11 place-items-center rounded-xl bg-brand-500/12 text-brand-600 dark:text-brand-400"
        aria-hidden
      >
        <MailCheck size={20} />
      </span>

      <h2 className="mt-4 text-lg font-semibold tracking-[-0.02em] text-slate-900 dark:text-slate-50">
        Approve this sign-in from your email
      </h2>
      <p className="measure mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        Your password was correct, but <strong>you are not signed in yet</strong>. We sent
        a message to <span className="font-medium text-slate-900 dark:text-slate-100">{sentTo}</span>{' '}
        showing this device. Open it and approve to continue.
      </p>

      <div className="well mt-4 flex items-center justify-between gap-4 px-3.5 py-3">
        <span className="runhead">Expires in</span>
        <span className="num text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-50">
          {countdown(remaining)}
        </span>
      </div>

      {/* `role="status"` rather than `alert`: this updates while the user waits
          and should be announced politely, not interrupt what they are doing. */}
      <p role="status" className="mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        This page is watching for your answer — it will continue on its own. Keep
        this tab open.
      </p>

      {error && (
        <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
          {error} Still trying…
        </p>
      )}

      <button type="button" onClick={onCancel} className="btn-secondary mt-5 w-full">
        Cancel and use a different account
      </button>
    </div>
  );
}

function Outcome({
  tone,
  icon: Icon,
  title,
  body,
  onCancel,
}: {
  tone: 'bad' | 'mut';
  icon: typeof ShieldX;
  title: string;
  body: string;
  onCancel: () => void;
}) {
  const ink =
    tone === 'bad'
      ? 'text-red-600 dark:text-red-400 bg-red-500/12'
      : 'text-slate-500 dark:text-slate-400 bg-slate-500/12';
  return (
    <div className="surface p-5 sm:p-6">
      <span className={`grid h-11 w-11 place-items-center rounded-xl ${ink}`} aria-hidden>
        <Icon size={20} />
      </span>
      <h2 className="mt-4 text-lg font-semibold tracking-[-0.02em] text-slate-900 dark:text-slate-50">
        {title}
      </h2>
      <p className="measure mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        {body}
      </p>
      <button type="button" onClick={onCancel} className="btn-primary mt-5 w-full">
        Back to sign in
      </button>
    </div>
  );
}
