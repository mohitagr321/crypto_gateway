import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, KeyRound, Loader2, Save } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Badge, { NetworkLabel } from '@/components/Badge';
import CommissionEditor, {
  buildCommissionInput,
  useCommissionDraft,
} from '@/components/CommissionEditor';
import DataTable, { type Column } from '@/components/DataTable';
import { BandHead, Figure, SpineRow } from '@/components/Editorial';
import ErrorState from '@/components/ErrorState';
import FormError, { FieldError, FormNote, FormSuccess } from '@/components/FormError';
import Modal from '@/components/Modal';
import PageHeader from '@/components/PageHeader';
import Spinner from '@/components/Spinner';
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
 * An asymmetric spread: a narrow margin column of facts against a wide main
 * column of the two things an operator actually came to do — read or change what
 * this merchant is charged, and see what they have put through.
 *
 * THE FACTS ARE A SPINE, not a stack of cards. Six ruled key/value rows state in
 * one column what three bordered panels used to state in three, and the rules
 * they are set on are the same rules the ledger below uses.
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

  if (clientQuery.isLoading) return <Spinner label="Loading client…" />;
  if (clientQuery.isError || !client) {
    return (
      <ErrorState
        message={apiErrorMessage(clientQuery.error) || 'Client not found'}
        onRetry={() => clientQuery.refetch()}
      />
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
    { key: 'status', header: 'Status', render: (t) => <Badge status={String(t.status)} /> },
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

  return (
    <>
      <PageHeader
        eyebrow="Merchant"
        title={client.name}
        subtitle={client.email}
        actions={
          <>
            {isSuper && (
              <button type="button" className="btn-secondary" onClick={() => setPwOpen(true)}>
                <KeyRound className="h-4 w-4" /> Set / reset password
              </button>
            )}
            <Link to="/clients" className="btn-secondary">
              <ArrowLeft className="h-4 w-4" /> All clients
            </Link>
          </>
        }
        meta={<Badge status={client.status} />}
      />

      <div className="grid gap-x-10 gap-y-10 lg:grid-cols-12">
        {/* ============================================================
            THE MARGIN COLUMN — facts, annotated. Ruled rows, not panels.
            ============================================================ */}
        <div className="space-y-8 lg:col-span-4">
          <section>
            <BandHead>Account</BandHead>
            <dl className="mt-2">
              <SpineRow label="Client ID">
                <code className="code">{shortHash(client.id, 10, 6)}</code>
              </SpineRow>
              <SpineRow label="API key">
                <code className="code">{shortHash(client.apiKey, 8, 4)}</code>
              </SpineRow>
              <SpineRow label="Created">
                <span className="num">{formatDate(client.createdAt)}</span>
              </SpineRow>
              <SpineRow label="Signed up">
                {client.signupSource === 'self' ? 'Self-registered' : 'Operator-created'}
              </SpineRow>
              {/* Only meaningful for self-registered accounts: an operator-created
                  merchant is recorded verified because there was never a link to
                  click, so showing "verified" for them would say nothing. */}
              {client.signupSource === 'self' && (
                <SpineRow label="Email">
                  {client.emailVerified ? (
                    <span className="font-medium text-emerald-600 dark:text-emerald-400">
                      Verified
                    </span>
                  ) : (
                    <span className="font-medium text-amber-600 dark:text-amber-400">
                      Not verified
                    </span>
                  )}
                </SpineRow>
              )}
              {client.websiteUrl && (
                <SpineRow label="Website">
                  <a
                    href={client.websiteUrl}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="link-ink break-all"
                  >
                    {client.websiteUrl.replace(/^https?:\/\//, '')}
                  </a>
                </SpineRow>
              )}
              {client.country && <SpineRow label="Country">{client.country}</SpineRow>}
              <SpineRow label="Webhook">
                {client.webhookUrl ? (
                  <code className="code break-all">{client.webhookUrl}</code>
                ) : (
                  <span className="text-slate-500 dark:text-slate-400">Not configured</span>
                )}
              </SpineRow>
            </dl>
          </section>

          <section>
            <BandHead>Balance</BandHead>
            {/* Two figures, ruled, never summed into one: available is what a
                payout can draw on right now and pending is what has not cleared
                yet. Adding them would produce a number no operator can act on. */}
            <div className="mt-2 grid grid-cols-2 gap-x-6">
              <div className="rule pt-3">
                <span className="runhead">Available</span>
                <Figure className="mt-1.5 truncate">{formatUsdt(client.availableBalance)}</Figure>
                <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">USDT, payable now</p>
              </div>
              <div className="rule pt-3">
                <span className="runhead">Pending</span>
                <Figure className="mt-1.5 truncate">{formatUsdt(client.pendingBalance)}</Figure>
                <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                  USDT, awaiting confirmation
                </p>
              </div>
            </div>
          </section>

          <section>
            <BandHead>Payout wallets</BandHead>
            {/* One settlement address per chain. They are independent: a merchant
                may take BEP20 only, TRC20 only, or both. An unset TRC20 wallet
                means TRC20 payouts are skipped for this merchant, not that
                anything is broken. */}
            <div className="mt-2">
              <PayoutWalletRow network="BEP20" address={client.payoutWallet} hint="0x… — BNB Smart Chain" />
              <PayoutWalletRow network="TRC20" address={client.payoutWalletTrc20} hint="T… — Tron" />
            </div>
          </section>
        </div>

        {/* ============================================================
            THE MAIN COLUMN — the two things you came here to do.
            ============================================================ */}
        <div className="space-y-10 lg:col-span-8">
          <section>
            <BandHead
              aside={
                client.commission?.version != null ? (
                  <span className="num text-xs text-slate-500 dark:text-slate-400">
                    version {client.commission.version}
                  </span>
                ) : undefined
              }
            >
              Commission
            </BandHead>
            <p className="measure mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
              This sets what the gateway charges this merchant on every payment.
              Saving writes a new versioned row; earlier versions are kept for
              audit.
            </p>

            <div className="rule mt-4 space-y-4 pt-4">
              {!isSuper && (
                <FormNote title="Read-only">
                  Editing commissions requires the super admin role. Everything
                  below shows the rates currently in force.
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
                <label className="label">Audit note</label>
                <input
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
                    <Loader2 className="motion-keep h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  Save commission
                </button>
              </div>
            </div>
          </section>

          <section>
            <BandHead
              aside={
                <Link
                  to={`/transactions`}
                  className="text-xs font-medium text-brand-600 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-brand-400"
                >
                  All transactions
                </Link>
              }
            >
              Recent payments
            </BandHead>
            <div className="mt-3">
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
                skeletonRows={5}
                pageSize={5}
              />
            </div>
          </section>
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
                <Loader2 className="motion-keep h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="h-4 w-4" />
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
            <label className="label">New password</label>
            <input
              type="password"
              className="input"
              placeholder="At least 8 characters"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Confirm password</label>
            <input
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
    <div className="rule py-3">
      <div className="flex items-baseline justify-between gap-3">
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
