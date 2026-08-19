import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Laptop,
  LogOut,
  MonitorSmartphone,
  ShieldCheck,
  Smartphone,
  Tablet,
} from 'lucide-react';
import Section from '@/components/Section';
import Modal from '@/components/Modal';
import Spinner from '@/components/Spinner';
import ErrorState from '@/components/ErrorState';
import { errorMessage, listSessions, revokeOtherSessions, revokeSession } from '@/lib/api';
import type { SessionInfo } from '@/types';

const KIND_ICON: Record<string, typeof Laptop> = {
  desktop: Laptop,
  mobile: Smartphone,
  tablet: Tablet,
  unknown: MonitorSmartphone,
};

/** "3 minutes ago" — relative, because "is this open right now?" is the question. */
function ago(iso: string | null): string {
  if (!iso) return 'unknown';
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 90) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * DEVICES SIGNED IN TO THIS ACCOUNT, and the control to end any of them.
 *
 * WHAT A ROW ACTUALLY IS: a refresh-token family — one sign-in, rotating a token
 * every fifteen minutes for as long as that browser stays open. So "sign out"
 * here is a revocation of the family, the same operation the server performs
 * when it detects a stolen token. Nothing bespoke is being invented for the UI.
 *
 * `lastUsedAt` IS THE COLUMN THAT MATTERS and it is why it is stated
 * relatively. "Last used 2 minutes ago" is a browser open on someone's screen
 * right now; "4 days ago" is one somebody closed and forgot. A merchant
 * scanning for a device they do not recognise is really scanning for one that
 * is ACTIVE and unfamiliar, and an absolute timestamp makes them do that
 * arithmetic themselves.
 *
 * REVOKING TAKES EFFECT WITHIN ONE ACCESS-TOKEN LIFETIME, not instantly, and
 * the card says so rather than implying otherwise. Revocation kills the ability
 * to REFRESH; the access token already in that browser's memory keeps working
 * until it expires. Claiming "signed out immediately" would be the kind of
 * security promise that is worse than no promise.
 */
export default function SessionsCard() {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState<SessionInfo | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: listSessions,
    // A device list that is minutes stale is a device list that cannot be used
    // to answer "is someone in my account right now".
    refetchInterval: 60_000,
  });

  const revokeOne = useMutation({
    mutationFn: (id: string) => revokeSession(id),
    onSuccess: (res) => {
      setConfirming(null);
      setError(null);
      // Revoking THIS device kills our own ability to refresh. Rather than wait
      // for the access token to lapse and produce a confusing half-working
      // dashboard, discard the credentials now and let the app bounce to login.
      if (res.current) {
        window.location.assign('/login');
        return;
      }
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e) => setError(errorMessage(e, 'Could not sign that device out.')),
  });

  const revokeRest = useMutation({
    mutationFn: revokeOtherSessions,
    onSuccess: () => {
      setConfirmAll(false);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e) => setError(errorMessage(e, 'Could not sign the other devices out.')),
  });

  const rows = sessions.data ?? [];
  const others = rows.filter((s) => !s.current).length;

  return (
    <>
      <Section
        title="Devices and sessions"
        aside={
          others > 0 ? (
            <button
              type="button"
              onClick={() => setConfirmAll(true)}
              className="text-xs font-medium text-red-600 hover:underline dark:text-red-400"
            >
              Sign out {others} other {others === 1 ? 'device' : 'devices'}
            </button>
          ) : undefined
        }
      >
        <p className="measure text-sm leading-relaxed text-slate-500 dark:text-slate-400">
          Every browser currently signed in to this account. If you do not recognise
          one, sign it out and change your password — whoever is using it knows the
          current one.
        </p>

        {sessions.isLoading && (
          <div className="mt-4">
            <Spinner label="Loading devices…" />
          </div>
        )}

        {sessions.isError && (
          <div className="mt-4">
            <ErrorState
              message={errorMessage(sessions.error, 'Could not load your devices.')}
              onRetry={() => sessions.refetch()}
            />
          </div>
        )}

        {error && (
          <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        {!sessions.isLoading && !sessions.isError && (
          <ul className="mt-4">
            {rows.map((s) => {
              const Icon = KIND_ICON[s.deviceKind ?? 'unknown'] ?? MonitorSmartphone;
              return (
                <li
                  key={s.id}
                  className="flex items-start justify-between gap-3 border-t border-[var(--line-soft)] py-3 first:border-t-0"
                >
                  <span className="flex min-w-0 gap-3">
                    <Icon
                      size={17}
                      className="mt-0.5 shrink-0 text-slate-400"
                      aria-hidden
                    />
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-[13.5px] font-medium text-slate-900 dark:text-slate-100">
                          {s.device ?? 'Unrecognised device'}
                        </span>
                        {s.current && (
                          <span className="st text-emerald-600 dark:text-emerald-400">
                            <ShieldCheck size={11} aria-hidden />
                            This device
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                        {s.ip ?? 'Unknown IP'} · last used {ago(s.lastUsedAt ?? s.signedInAt)}
                      </span>
                    </span>
                  </span>

                  <button
                    type="button"
                    onClick={() => setConfirming(s)}
                    disabled={revokeOne.isPending}
                    className="btn-ghost shrink-0 px-2.5 text-xs text-red-600 hover:bg-red-500/10 dark:text-red-400"
                  >
                    <LogOut size={14} aria-hidden />
                    Sign out
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <p className="mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          Signing a device out stops it renewing its session. It can take up to
          fifteen minutes to take full effect on that device.
        </p>
      </Section>

      {/* CONFIRMED, because it is not undoable and the copy has to distinguish
          the two cases: signing out ANOTHER device is routine, signing out THIS
          one ends the session the merchant is reading the dialog in. */}
      <Modal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={confirming?.current ? 'Sign out this device?' : 'Sign out that device?'}
        footer={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setConfirming(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger"
              disabled={revokeOne.isPending}
              onClick={() => confirming && revokeOne.mutate(confirming.id)}
            >
              {revokeOne.isPending ? <Spinner size={16} /> : <LogOut size={16} />}
              Sign out
            </button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          {confirming?.current ? (
            <>
              This is the device you are using now. You will be returned to the sign-in
              screen and will need your password and an emailed approval to come back.
            </>
          ) : (
            <>
              <span className="font-medium text-slate-900 dark:text-slate-100">
                {confirming?.device ?? 'That device'}
              </span>{' '}
              will need to sign in again, with your password and an emailed approval.
            </>
          )}
        </p>
      </Modal>

      <Modal
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        title="Sign out every other device?"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setConfirmAll(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger"
              disabled={revokeRest.isPending}
              onClick={() => revokeRest.mutate()}
            >
              {revokeRest.isPending ? <Spinner size={16} /> : <LogOut size={16} />}
              Sign out {others} {others === 1 ? 'device' : 'devices'}
            </button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          Every browser except this one will be signed out. This device stays signed in,
          so you can carry on securing the account — change your password next if you
          think it has leaked.
        </p>
      </Modal>
    </>
  );
}
