import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, KeyRound, Loader2, Save, Wallet, Webhook } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Badge from '@/components/Badge';
import CommissionEditor, {
  buildCommissionInput,
  useCommissionDraft,
} from '@/components/CommissionEditor';
import DataTable, { type Column } from '@/components/DataTable';
import ErrorState from '@/components/ErrorState';
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
import { addrLink, formatDate, formatUsdt, networkTone, shortHash, txLink } from '@/lib/format';
import type { SetCommissionInput, Transaction } from '@/types';

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
      render: (t) => <span className="text-xs">{formatDate(t.createdAt)}</span>,
    },
    { key: 'type', header: 'Type', render: (t) => <span className="capitalize">{t.type}</span> },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      render: (t) => <span className="tabular-nums">{formatUsdt(t.amount)} {t.currency}</span>,
    },
    {
      key: 'network',
      header: 'Network',
      render: (t) => <Badge tone={networkTone(t.network)}>{t.network ?? 'BEP20'}</Badge>,
    },
    { key: 'status', header: 'Status', render: (t) => <Badge status={String(t.status)} /> },
    {
      key: 'tx',
      header: 'Tx',
      render: (t) =>
        t.txHash ? (
          <a
            href={txLink(t.txHash, t.network)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-brand-600 hover:underline"
          >
            {shortHash(t.txHash)} <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-gray-400">—</span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title={client.name}
        subtitle={client.email}
        actions={
          <div className="flex gap-2">
            {isSuper && (
              <button className="btn-secondary" onClick={() => setPwOpen(true)}>
                <KeyRound className="h-4 w-4" /> Set / reset password
              </button>
            )}
            <Link to="/clients" className="btn-secondary">
              <ArrowLeft className="h-4 w-4" /> Back
            </Link>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left column: info + config */}
        <div className="space-y-6 lg:col-span-1">
          <div className="card p-5">
            <h2 className="mb-4 text-sm font-semibold">Client info</h2>
            <dl className="space-y-3 text-sm">
              <Row label="Status"><Badge status={client.status} /></Row>
              <Row label="Client ID">
                <code className="text-xs">{shortHash(client.id, 10, 6)}</code>
              </Row>
              <Row label="API key">
                <code className="text-xs">{shortHash(client.apiKey, 8, 4)}</code>
              </Row>
              <Row label="Created">
                <span className="text-xs">{formatDate(client.createdAt)}</span>
              </Row>
              <Row label="Signed up">
                {client.signupSource === 'self' ? (
                  <span className="text-xs font-medium text-brand-700 dark:text-brand-300">
                    Self-registered
                  </span>
                ) : (
                  <span className="text-xs">Operator-created</span>
                )}
              </Row>
              {/* Only meaningful for self-registered accounts: an operator-created
                  merchant is recorded verified because there was never a link to
                  click, so showing "verified" for them would say nothing. */}
              {client.signupSource === 'self' && (
                <Row label="Email">
                  {client.emailVerified ? (
                    <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                      Verified
                    </span>
                  ) : (
                    <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                      Not verified
                    </span>
                  )}
                </Row>
              )}
              {client.websiteUrl && (
                <Row label="Website">
                  <a
                    href={client.websiteUrl}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-xs text-brand-600 hover:underline dark:text-brand-400"
                  >
                    {client.websiteUrl.replace(/^https?:\/\//, '').slice(0, 28)}
                  </a>
                </Row>
              )}
              {client.country && (
                <Row label="Country">
                  <span className="text-xs">{client.country}</span>
                </Row>
              )}
            </dl>
          </div>

          <div className="card p-5">
            <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
              <Webhook className="h-4 w-4" /> Webhook URL
            </h2>
            {client.webhookUrl ? (
              <code className="block overflow-x-auto rounded-lg bg-gray-100 px-3 py-2 text-xs dark:bg-gray-800">
                {client.webhookUrl}
              </code>
            ) : (
              <p className="text-sm text-gray-400">Not configured</p>
            )}
          </div>

          <div className="card p-5">
            <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
              <Wallet className="h-4 w-4" /> Payout wallets
            </h2>

            {/* One settlement address per chain. They are independent: a
                merchant may take BEP20 only, TRC20 only, or both. An unset
                TRC20 wallet means TRC20 payouts are skipped for this merchant,
                not that anything is broken. */}
            <div className="space-y-3">
              <PayoutWalletRow
                network="BEP20"
                address={client.payoutWallet}
                hint="0x… — BNB Smart Chain"
              />
              <PayoutWalletRow
                network="TRC20"
                address={client.payoutWalletTrc20}
                hint="T… — Tron"
              />
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-lg bg-gray-50 p-3 dark:bg-gray-800/50">
                <p className="text-xs text-gray-500">Available</p>
                <p className="font-semibold tabular-nums">{formatUsdt(client.availableBalance)}</p>
              </div>
              <div className="rounded-lg bg-gray-50 p-3 dark:bg-gray-800/50">
                <p className="text-xs text-gray-500">Pending</p>
                <p className="font-semibold tabular-nums">{formatUsdt(client.pendingBalance)}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Right column: commission editor + recent payments */}
        <div className="space-y-6 lg:col-span-2">
          <div className="card p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Commission</h2>
              {client.commission?.version != null && (
                <span className="text-xs text-gray-400">v{client.commission.version}</span>
              )}
            </div>

            {!isSuper && (
              <div className="mb-4 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500 dark:bg-gray-800/50">
                Read-only. Editing commissions requires the super admin role.
              </div>
            )}

            {commissionMutation.isError && (
              <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
                {apiErrorMessage(commissionMutation.error)}
              </div>
            )}
            {commissionMutation.isSuccess && (
              <div className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                Commission saved as a new versioned row.
              </div>
            )}

            <div className="space-y-4">
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
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  Save commission
                </button>
              </div>
            </div>
          </div>

          <div>
            <h2 className="mb-3 text-sm font-semibold">Recent payments</h2>
            <DataTable
              columns={txColumns}
              rows={txQuery.data?.data ?? []}
              rowKey={(t) => t.id}
              loading={txQuery.isLoading}
              error={txQuery.isError ? apiErrorMessage(txQuery.error) : null}
              emptyMessage="No transactions for this client yet."
              pageSize={5}
            />
          </div>
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
          <KeyRound className="h-4 w-4" /> Set / reset password — {clientName}
        </span>
      }
      footer={
        done ? (
          <button className="btn-primary" onClick={close}>
            Done
          </button>
        ) : (
          <>
            <button className="btn-secondary" onClick={close}>
              Cancel
            </button>
            <button className="btn-primary" disabled={mutation.isPending} onClick={submit}>
              {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              Set password
            </button>
          </>
        )
      }
    >
      {done ? (
        <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
          Password updated. The merchant can now sign in with the new password.
        </div>
      ) : (
        <div className="space-y-4">
          {(localError || mutation.isError) && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
              {localError ?? apiErrorMessage(mutation.error)}
            </div>
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
          </div>
        </div>
      )}
    </Modal>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * One merchant settlement address, labelled with the chain it belongs to.
 * The explorer link is resolved per network — a TRC20 address on BscScan is a
 * dead link, and pasting a 0x address into the TRC20 slot is the single most
 * likely way to send funds nowhere, so the chain is always shown explicitly.
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
    <div className="rounded-lg bg-gray-50 p-3 dark:bg-gray-800/50">
      <div className="mb-1 flex items-center gap-2">
        <Badge tone={networkTone(network)}>{network}</Badge>
        <span className="text-xs text-gray-500">{hint}</span>
      </div>
      {address ? (
        <a
          href={addrLink(address, network)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 break-all font-mono text-xs text-brand-600 hover:underline"
        >
          {address} <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
      ) : (
        <p className="text-sm text-gray-400">
          Not configured — {network} payouts are skipped for this merchant.
        </p>
      )}
    </div>
  );
}
