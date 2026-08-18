import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Clock, ExternalLink, KeyRound, Loader2, Save, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Badge, { NetworkLabel } from '@/components/Badge';
import CommissionEditor, {
  buildCommissionInput,
  useCommissionDraft,
} from '@/components/CommissionEditor';
import DataTable, { type Column } from '@/components/DataTable';
import ErrorState from '@/components/ErrorState';
import FormError, { FieldError, FormNote, FormSuccess } from '@/components/FormError';
import Modal from '@/components/Modal';
import PageHeader from '@/components/PageHeader';
import Section, { MoreLink } from '@/components/Section';
import { LoadingPanel } from '@/components/Spinner';
import StatCard from '@/components/StatCard';
import { useAuth } from '@/context/AuthContext';
import {
  apiErrorMessage,
  getClient,
  listTransactions,
  setCommission,
  updateClient,
} from '@/lib/api';
import { addrLink, formatDate, formatUsdt, shortHash, txLink } from '@/lib/format';
import type { SetCommissionInput, Transaction } from '@/types';

/**
 * ONE MERCHANT, in full.
 *
 * It was an asymmetric broadsheet spread: a 4/12 margin column of ruled facts
 * against an 8/12 column of the two things an operator came to do. The columns
 * survive, because the proportion was right — the facts are reference and the
 * commission editor is work — but each block is now a `Section` on its own
 * rim-lit surface rather than a band opened by a hairline. A console screen is a
 * stack of unrelated readouts that happen to share a route, and surfaces are what
 * let the eye land on one of them.
 *
 * THE BALANCES LEAD THE PAGE, as metric tiles. They were a `grid-cols-2` inside
 * the narrow margin column with `truncate` on both figures, which at 360px gave
 * each of them about 148px to print a float in — so a merchant holding
 * 1,234,567.89 was shown "1,234,5…". A TRUNCATED BALANCE IS SILENT DATA LOSS: it
 * is a number an operator reads wrong rather than notices is missing, and this is
 * the figure a payout is authorised against. StatCard wraps and the tile grows.
 *
 * COMMISSION SETS REAL MONEY RATES. Every guard around it is preserved exactly:
 * ops-role operators get a disabled editor and a stated reason, saving writes a
 * new versioned row, and the audit note travels with it.
 */
export default function ClientDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { role } = useAuth();
  const isSuper = role === 'super_admin';
  const [pwOpen, setPwOpen] = useState(false);

  const clientQuery = useQuery({
    queryKey: ['client', id],
    queryFn: () => getClient(id),
    enabled: !!id,
  });

  const txQuery = useQuery({
    queryKey: ['client-transactions', id],
    queryFn: () => listTransactions({ clientId: id, limit: 10 }),
    enabled: !!id,
  });

  const client = clientQuery.data;

  const { draft, setDraft, errors, setErrors } = useCommissionDraft(client?.commission);
  const [note, setNote] = useState('');

  const commissionMutation = useMutation({
    mutationFn: (input: SetCommissionInput) => setCommission(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['client', id] }),
  });

  const onSaveCommission = () => {
    const result = buildCommissionInput(id, draft, note || undefined);
    if ('errors' in result) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    commissionMutation.mutate(result.input);
  };

  // A whole route waiting on its first response. `LoadingPanel` rather than a
  // bare inline `Spinner`: this is the only thing on screen, and an inline
  // component that reserves its own vertical band is a page-level state wearing
  // the wrong name.
  if (clientQuery.isLoading) return <LoadingPanel label="Loading client…" />;
  if (clientQuery.isError || !client) {
    return (
      <>
        <PageHeader eyebrow="Merchant" title="Client" />
        <ErrorState
          message={apiErrorMessage(clientQuery.error) || 'Client not found'}
          onRetry={() => clientQuery.refetch()}
        />
      </>
    );
  }

  const txColumns: Column<Transaction>[] = [
    {
      key: 'createdAt',
      header: 'Date',
      render: (t) => (
        <span className="whitespace-nowrap text-slate-500 dark:text-slate-400">
          {formatDate(t.createdAt)}
        </span>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      render: (t) => <span className="capitalize">{t.type}</span>,
    },
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      render: (t) => (
        <span className="font-medium text-slate-900 dark:text-slate-100">
          {formatUsdt(t.amount)}
          <span className="font-normal text-slate-500 dark:text-slate-400"> {t.currency}</span>
        </span>
      ),
    },
    {
      key: 'network',
      header: 'Network',
      hideOnMobile: true,
      render: (t) => <NetworkLabel network={t.network} />,
    },
    {
      key: 'status',
      header: 'Status',
      align: 'right',
      render: (t) => <Badge status={String(t.status)} dot />,
    },
    {
      key: 'tx',
      header: 'Tx',
      hideOnMobile: true,
      render: (t) =>
        t.txHash ? (
          <a
            href={txLink(t.txHash, t.network)}
            target="_blank"
            rel="noreferrer"
            className="link-ink inline-flex items-center gap-1 font-mono text-xs"
          >
            {shortHash(t.txHash)} <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        ) : (
          // Never a bare dash: say WHICH nothing this is.
          <span className="text-slate-500 dark:text-slate-400">not seen yet</span>
        ),
    },
  ];

  /**
   * Below `md` the six-column ledger becomes a stacked, ruled list. It had none,
   * so a phone was handed the whole table to drag sideways — DataTable's generic
   * fallback covers that now, but a hand-built row puts the amount and the state
   * where the eye already expects them.
   */
  const txMobileRow = (t: Transaction) => (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[13.5px] font-medium capitalize text-slate-900 dark:text-slate-50">
          {t.type}
        </p>
        <p className="num mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          {formatDate(t.createdAt)}
        </p>
      </div>
      <div className="min-w-0 break-words text-right">
        <p className="num text-sm font-medium text-slate-900 dark:text-slate-50">
          {formatUsdt(t.amount)} {t.currency}
        </p>
        <span className="mt-1 flex justify-end">
          <Badge status={String(t.status)} dot />
        </span>
      </div>
    </div>
  );

  return (
    <>
      <PageHeader
        eyebrow="Merchant"
        title={client.name}
        description={client.email}
        actions={
          <>
            {isSuper && (
              <button type="button" className="btn-secondary" onClick={() => setPwOpen(true)}>
                <KeyRound className="h-4 w-4" aria-hidden /> Set / reset password
              </button>
            )}
            <Link to="/clients" className="btn-secondary">
              <ArrowLeft className="h-4 w-4" aria-hidden /> All clients
            </Link>
          </>
        }
        meta={<Badge status={client.status} dot />}
      />

      {/* ============================================================
          THE BALANCES. `auto-fit` + `minmax` so the two tiles reflow to one
          column below ~30rem instead of splitting a 360px screen in half and
          asking a money figure to fit in 148px of it. `min-w-0` on the track
          is what lets StatCard's `break-words` work at all.
          ============================================================ */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-3">
        <StatCard
          label="Available balance"
          value={
            <>
              {formatUsdt(client.availableBalance)}{' '}
              <span className="text-[0.5em] font-semibold text-slate-500 dark:text-slate-400">
                USDT
              </span>
            </>
          }
          icon={Wallet}
          sub="Payable to this merchant right now"
        />
        <StatCard
          label="Pending balance"
          value={
            <>
              {formatUsdt(client.pendingBalance)}{' '}
              <span className="text-[0.5em] font-semibold text-slate-500 dark:text-slate-400">
                USDT
              </span>
            </>
          }
          icon={Clock}
          // Amber only when something is genuinely waiting. An amber glyph over
          // a zero is a false alarm.
          tone={Number(client.pendingBalance ?? 0) > 0 ? 'amber' : undefined}
          sub="Awaiting confirmation — not yet payable"
        />
      </div>

      {/* The caveat, next to the figures it qualifies. */}
      <p className="measure-wide mt-3 px-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        Never summed. Available is what a payout can draw on right now; pending is what has not
        cleared yet. Adding them produces a number no operator can act on.
      </p>

      <div className="mt-4 grid gap-3 lg:grid-cols-12">
        {/* ============================================================
            THE REFERENCE COLUMN — facts, annotated.
            ============================================================ */}
        <div className="space-y-3 lg:col-span-4">
          <Section title="Account">
            {/* THE SPINE — a key/value list as ruled rows, label ranged left and
                value ranged right against the same rule. This is the one place a
                hairline is still the right primitive: these rows are a list
                INSIDE a surface rather than a structure of their own. */}
            <dl>
              <div className="spine-row">
                <dt className="spine-label">Client ID</dt>
                <dd className="spine-value">
                  <code className="code">{shortHash(client.id, 10, 6)}</code>
                </dd>
              </div>
              <div className="spine-row">
                <dt className="spine-label">API key</dt>
                <dd className="spine-value">
                  <code className="code">{shortHash(client.apiKey, 8, 4)}</code>
                </dd>
              </div>
              <div className="spine-row">
                <dt className="spine-label">Created</dt>
                <dd className="spine-value num">{formatDate(client.createdAt)}</dd>
              </div>
              <div className="spine-row">
                <dt className="spine-label">Signed up</dt>
                <dd className="spine-value">
                  {client.signupSource === 'self' ? 'Self-registered' : 'Operator-created'}
                </dd>
              </div>
              {/* Only meaningful for self-registered accounts: an operator-created
                  merchant is recorded verified because there was never a link to
                  click, so showing "verified" for them would say nothing. */}
              {client.signupSource === 'self' && (
                <div className="spine-row">
                  <dt className="spine-label">Email</dt>
                  <dd className="spine-value">
                    {client.emailVerified ? (
                      <span className="font-medium text-emerald-600 dark:text-emerald-400">
                        Verified
                      </span>
                    ) : (
                      <span className="font-medium text-amber-600 dark:text-amber-400">
                        Not verified
                      </span>
                    )}
                  </dd>
                </div>
              )}
              {client.websiteUrl && (
                <div className="spine-row">
                  <dt className="spine-label">Website</dt>
                  <dd className="spine-value">
                    <a
                      href={client.websiteUrl}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="link-ink break-all"
                    >
                      {client.websiteUrl.replace(/^https?:\/\//, '')}
                    </a>
                  </dd>
                </div>
              )}
              {client.country && (
                <div className="spine-row">
                  <dt className="spine-label">Country</dt>
                  <dd className="spine-value">{client.country}</dd>
                </div>
              )}
              <div className="spine-row">
                <dt className="spine-label">Webhook</dt>
                <dd className="spine-value">
                  {client.webhookUrl ? (
                    <code className="code break-all">{client.webhookUrl}</code>
                  ) : (
                    <span className="text-slate-500 dark:text-slate-400">Not configured</span>
                  )}
                </dd>
              </div>
            </dl>
          </Section>

          {/* One settlement address per chain. They are independent: a merchant
              may take BEP20 only, TRC20 only, or both. An unset TRC20 wallet
              means TRC20 payouts are skipped for this merchant, not that
              anything is broken. */}
          <Section title="Payout wallets">
            <PayoutWalletRow
              network="BEP20"
              address={client.payoutWallet}
              hint="0x… — BNB Smart Chain"
            />
            <PayoutWalletRow network="TRC20" address={client.payoutWalletTrc20} hint="T… — Tron" />
          </Section>
        </div>

        {/* ============================================================
            THE WORKING COLUMN — the two things you came here to do.
            ============================================================ */}
        <div className="space-y-3 lg:col-span-8">
          <Section
            title="Commission"
            aside={
              client.commission?.version != null ? (
                <span className="num text-xs text-slate-500 dark:text-slate-400">
                  version {client.commission.version}
                </span>
              ) : undefined
            }
          >
            <p className="measure text-sm leading-relaxed text-slate-500 dark:text-slate-400">
              This sets what the gateway charges this merchant on every payment. Saving writes a new
              versioned row; earlier versions are kept for audit.
            </p>

            <div className="mt-4 space-y-4">
              {!isSuper && (
                <FormNote title="Read-only">
                  Editing commissions requires the super admin role. Everything below shows the
                  rates currently in force.
                </FormNote>
              )}

              {commissionMutation.isError && (
                <FormError title="Commission not saved">
                  {apiErrorMessage(commissionMutation.error)}
                </FormError>
              )}
              {commissionMutation.isSuccess && (
                <FormSuccess>Commission saved as a new versioned row.</FormSuccess>
              )}

              <CommissionEditor
                draft={draft}
                onChange={setDraft}
                errors={errors}
                disabled={!isSuper}
              />
              <div>
                <label className="label" htmlFor="commission-note">
                  Audit note
                </label>
                <input
                  id="commission-note"
                  className="input"
                  disabled={!isSuper}
                  placeholder="Reason for this change (stored with the version)"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!isSuper || commissionMutation.isPending}
                  onClick={onSaveCommission}
                >
                  {commissionMutation.isPending ? (
                    <Loader2 className="motion-keep h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Save className="h-4 w-4" aria-hidden />
                  )}
                  Save commission
                </button>
              </div>
            </div>
          </Section>

          <Section
            flush
            title="Recent payments"
            aside={<MoreLink to="/transactions">All transactions</MoreLink>}
          >
            <DataTable
              columns={txColumns}
              rows={txQuery.data?.data ?? []}
              rowKey={(t) => t.id}
              loading={txQuery.isLoading}
              error={txQuery.isError ? apiErrorMessage(txQuery.error) : null}
              onRetry={() => txQuery.refetch()}
              emptyMessage="No transactions for this client yet."
              emptyHint="A row appears here as soon as this merchant is paid — the ten most recent are shown."
              label="Recent payments for this client"
              renderMobile={txMobileRow}
              skeletonRows={5}
              pageSize={5}
            />
          </Section>
        </div>
      </div>

      <SetPasswordModal
        clientId={id}
        clientName={client.name}
        open={pwOpen}
        onClose={() => setPwOpen(false)}
      />
    </>
  );
}

function SetPasswordModal({
  clientId,
  clientName,
  open,
  onClose,
}: {
  clientId: string;
  clientName: string;
  open: boolean;
  onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mutation = useMutation({
    mutationFn: () => updateClient(clientId, { action: 'set_password', password }),
    onSuccess: () => {
      setDone(true);
      setPassword('');
      setConfirm('');
      setLocalError(null);
    },
  });

  const close = () => {
    setPassword('');
    setConfirm('');
    setLocalError(null);
    setDone(false);
    mutation.reset();
    onClose();
  };

  const submit = () => {
    if (password.length < 8) {
      setLocalError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setLocalError('Passwords do not match.');
      return;
    }
    setLocalError(null);
    mutation.mutate();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={
        <span className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 shrink-0" aria-hidden /> Set password — {clientName}
        </span>
      }
      footer={
        done ? (
          <button type="button" className="btn-primary" onClick={close}>
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn-secondary" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={mutation.isPending}
              onClick={submit}
            >
              {mutation.isPending ? (
                <Loader2 className="motion-keep h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <KeyRound className="h-4 w-4" aria-hidden />
              )}
              Set password
            </button>
          </>
        )
      }
    >
      {done ? (
        <FormSuccess>
          Password updated. The merchant can now sign in with the new password.
        </FormSuccess>
      ) : (
        <div className="space-y-4">
          {(localError || mutation.isError) && (
            <FormError>{localError ?? apiErrorMessage(mutation.error)}</FormError>
          )}
          <div>
            <label className="label" htmlFor="set-password-new">
              New password
            </label>
            <input
              id="set-password-new"
              type="password"
              className="input"
              placeholder="At least 8 characters"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="set-password-confirm">
              Confirm password
            </label>
            <input
              id="set-password-confirm"
              type="password"
              className="input"
              placeholder="Re-enter password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {password !== '' && confirm !== '' && password !== confirm && (
              <FieldError>Passwords do not match.</FieldError>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/**
 * One merchant settlement address, labelled with the chain it belongs to.
 *
 * The explorer link is resolved per network — a TRC20 address on BscScan is a
 * dead link, and pasting a 0x address into the TRC20 slot is the single most
 * likely way to send funds nowhere, so the chain is always stated explicitly and
 * the expected shape is printed next to it.
 *
 * The rule falls BETWEEN the two chains only, not above the first: a stroke
 * directly under the section's own head would double it.
 */
function PayoutWalletRow({
  network,
  address,
  hint,
}: {
  network: string;
  address?: string | null;
  hint: string;
}) {
  return (
    <div className="rule py-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <NetworkLabel network={network} />
        <span className="text-xs text-slate-500 dark:text-slate-400">{hint}</span>
      </div>
      {address ? (
        <a
          href={addrLink(address, network)}
          target="_blank"
          rel="noreferrer"
          className="link-ink mt-1 inline-flex items-start gap-1 break-all font-mono text-xs"
        >
          {address} <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
        </a>
      ) : (
        <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          Not configured — {network} payouts are skipped for this merchant.
        </p>
      )}
    </div>
  );
}
