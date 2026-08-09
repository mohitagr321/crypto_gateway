import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Coins, ExternalLink, Loader2, TrendingUp, Wallet } from 'lucide-react';
import { useState } from 'react';
import Badge from '@/components/Badge';
import DataTable, { type Column } from '@/components/DataTable';
import Modal from '@/components/Modal';
import PageHeader from '@/components/PageHeader';
import StatCard from '@/components/StatCard';
import { useAuth } from '@/context/AuthContext';
import {
  apiErrorMessage,
  commissionBalance,
  listCommissionWithdrawals,
  withdrawCommission,
} from '@/lib/api';
import {
  addrLink,
  formatDate,
  formatUsdt,
  networkTone,
  shortHash,
  txLink,
} from '@/lib/format';
import type { AdminWithdrawal, CommissionBalance } from '@/types';

// Address shape differs per chain. Validating client-side is a courtesy — the
// server re-validates against the target chain's adapter — but it is the check
// that stops the single most costly mistake here: pasting a BEP20 address into
// a TRC20 withdrawal (or vice versa) and sending commission into the void.
const ADDRESS_RE: Record<string, RegExp> = {
  BEP20: /^0x[0-9a-fA-F]{40}$/,
  TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
};

export default function Revenue() {
  const qc = useQueryClient();
  const { role } = useAuth();
  const isSuper = role === 'super_admin';
  const [open, setOpen] = useState(false);

  const balanceQuery = useQuery({
    queryKey: ['commission-balance'],
    queryFn: () => commissionBalance(),
  });

  const historyQuery = useQuery({
    queryKey: ['commission-withdrawals'],
    queryFn: () => listCommissionWithdrawals(),
  });

  const balance = balanceQuery.data;
  const currency = balance?.currency ?? 'USDT';

  // Prefer the per-network payload; fall back to the flat BEP20-only shape so
  // the page still renders against an older API.
  const networkBalances: CommissionBalance[] =
    balance?.networks && balance.networks.length > 0
      ? balance.networks
      : balance
        ? [{ ...balance, network: balance.network ?? 'BEP20' }]
        : [];

  const columns: Column<AdminWithdrawal>[] = [
    {
      key: 'createdAt',
      header: 'Date',
      sortValue: (w) => w.createdAt,
      render: (w) => <span className="text-xs text-gray-500">{formatDate(w.createdAt)}</span>,
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      sortValue: (w) => Number(w.amount ?? 0),
      render: (w) => (
        <span className="tabular-nums">
          {formatUsdt(w.amount)} {currency}
        </span>
      ),
    },
    {
      key: 'to',
      header: 'To',
      render: (w) =>
        w.toAddress ? (
          <a
            href={addrLink(w.toAddress, w.network)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-brand-600 hover:underline"
          >
            <code className="text-xs">{shortHash(w.toAddress, 8, 4)}</code>
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-gray-400">—</span>
        ),
    },
    {
      key: 'network',
      header: 'Network',
      sortValue: (w) => w.network ?? 'BEP20',
      render: (w) => <Badge tone={networkTone(w.network)}>{w.network ?? 'BEP20'}</Badge>,
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (w) => w.status,
      render: (w) => (
        <div>
          <Badge status={w.status} />
          {w.error && <p className="mt-1 max-w-[200px] truncate text-xs text-red-600">{w.error}</p>}
        </div>
      ),
    },
    {
      key: 'tx',
      header: 'Tx',
      render: (w) =>
        w.txHash ? (
          <a
            href={txLink(w.txHash, w.network)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-brand-600 hover:underline"
          >
            {shortHash(w.txHash)} <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-gray-400">—</span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Revenue / Commission"
        subtitle="Commission earned and withdrawals to your wallet"
        actions={
          isSuper ? (
            <button className="btn-primary" onClick={() => setOpen(true)}>
              <Wallet className="h-4 w-4" /> Withdraw commission
            </button>
          ) : undefined
        }
      />

      {balanceQuery.isError ? (
        <div className="card p-5 text-sm text-red-600 dark:text-red-400">
          {apiErrorMessage(balanceQuery.error)}
        </div>
      ) : (
        <>
          {/* One block per chain. Commission is physically held in that chain's
              central wallet and can only be withdrawn from there, so a single
              pooled total would be misleading — and acting on it would mean
              trying to spend Tron-earned funds from the BSC wallet. */}
          {networkBalances.map((b) => (
            <div key={b.network ?? 'BEP20'} className="mb-4">
              {networkBalances.length > 1 && (
                <div className="mb-2 flex items-center gap-2">
                  <Badge tone={networkTone(b.network)}>{b.network ?? 'BEP20'}</Badge>
                  <span className="text-xs text-gray-500">
                    held in the {b.network ?? 'BEP20'} central wallet
                  </span>
                </div>
              )}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <StatCard
                  label="Accrued (total earned)"
                  value={`${formatUsdt(b.accrued)} ${b.currency ?? currency}`}
                  icon={TrendingUp}
                  tone="blue"
                  loading={balanceQuery.isLoading}
                />
                <StatCard
                  label="Withdrawn"
                  value={`${formatUsdt(b.withdrawn)} ${b.currency ?? currency}`}
                  icon={Coins}
                  tone="purple"
                  loading={balanceQuery.isLoading}
                />
                <StatCard
                  label="Available to withdraw"
                  value={`${formatUsdt(b.available)} ${b.currency ?? currency}`}
                  icon={Wallet}
                  tone="brand"
                  hint="Withdrawable now"
                  loading={balanceQuery.isLoading}
                />
              </div>
            </div>
          ))}
        </>
      )}

      <div className="mt-6">
        <h2 className="mb-3 text-sm font-semibold">Withdrawal history</h2>
        <DataTable
          columns={columns}
          rows={historyQuery.data ?? []}
          rowKey={(w) => w.id}
          loading={historyQuery.isLoading}
          error={historyQuery.isError ? apiErrorMessage(historyQuery.error) : null}
          emptyMessage="No withdrawals yet."
          pageSize={15}
        />
      </div>

      {isSuper && (
        <WithdrawModal
          open={open}
          balances={networkBalances}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            qc.invalidateQueries({ queryKey: ['commission-balance'] });
            qc.invalidateQueries({ queryKey: ['commission-withdrawals'] });
          }}
        />
      )}
    </>
  );
}

function WithdrawModal({
  open,
  balances,
  onClose,
  onDone,
}: {
  open: boolean;
  balances: CommissionBalance[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [network, setNetwork] = useState('BEP20');
  const [amount, setAmount] = useState('');
  const [toAddress, setToAddress] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Everything in this modal is scoped to the selected chain: the Max button,
  // the address format, and which wallet actually pays.
  const balance =
    balances.find((b) => (b.network ?? 'BEP20') === network) ?? balances[0];
  const currency = balance?.currency ?? 'USDT';

  const mutation = useMutation({
    mutationFn: (input: { amount: string; toAddress: string; network: string }) =>
      withdrawCommission(input),
    onSuccess: () => {
      setAmount('');
      setToAddress('');
      setFieldError(null);
      onDone();
    },
  });

  const close = () => {
    setFieldError(null);
    onClose();
  };

  // Clearing the address on a network switch is deliberate: a leftover address
  // from the other chain is exactly the paste error this guards against.
  const onNetworkChange = (next: string) => {
    setNetwork(next);
    setToAddress('');
    setAmount('');
    setFieldError(null);
  };

  const onSubmit = () => {
    const amt = amount.trim();
    const addr = toAddress.trim();
    if (!amt || Number.isNaN(Number(amt)) || Number(amt) <= 0) {
      setFieldError('Enter a valid amount greater than 0.');
      return;
    }
    const re = ADDRESS_RE[network] ?? ADDRESS_RE.BEP20;
    if (!re.test(addr)) {
      setFieldError(
        network === 'TRC20'
          ? 'Enter a valid TRC20 address (T + 33 base58 characters). A 0x address will not work on Tron.'
          : 'Enter a valid BEP20 address (0x + 40 hex characters).',
      );
      return;
    }
    setFieldError(null);
    mutation.mutate({ amount: amt, toAddress: addr, network });
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={
        <span className="flex items-center gap-2">
          <Wallet className="h-4 w-4" /> Withdraw commission
        </span>
      }
      footer={
        <>
          <button className="btn-secondary" onClick={close}>
            Cancel
          </button>
          <button className="btn-primary" disabled={mutation.isPending} onClick={onSubmit}>
            {mutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            Withdraw
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {mutation.isError && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
            {apiErrorMessage(mutation.error)}
          </div>
        )}
        {fieldError && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
            {fieldError}
          </div>
        )}

        {balances.length > 1 && (
          <div>
            <label className="label">Network</label>
            <select
              className="input"
              value={network}
              onChange={(e) => onNetworkChange(e.target.value)}
            >
              {balances.map((b) => (
                <option key={b.network ?? 'BEP20'} value={b.network ?? 'BEP20'}>
                  {b.network === 'TRC20' ? 'TRC20 (Tron)' : 'BEP20 (BNB Smart Chain)'} —{' '}
                  {formatUsdt(b.available)} {b.currency ?? 'USDT'} available
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Paid from the {network} central wallet. Commission is not
              transferable between chains.
            </p>
          </div>
        )}

        <div>
          <div className="flex items-center justify-between">
            <label className="label">Amount ({currency})</label>
            <button
              type="button"
              className="text-xs font-medium text-brand-600 hover:underline"
              onClick={() => setAmount(balance?.available ?? '')}
            >
              Max: {formatUsdt(balance?.available)}
            </button>
          </div>
          <input
            className="input"
            placeholder="100.00"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>

        <div>
          <label className="label">Destination address ({network})</label>
          <input
            className="input font-mono text-sm"
            placeholder={network === 'TRC20' ? 'T…' : '0x…'}
            value={toAddress}
            onChange={(e) => setToAddress(e.target.value)}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Must be a {network === 'TRC20' ? 'Tron (T…)' : 'BEP20 (0x…)'} address.
            On-chain transfers are irreversible.
          </p>
        </div>

        <p className="text-xs text-gray-500 dark:text-gray-400">
          Available to withdraw: {formatUsdt(balance?.available)} {currency}. The withdrawal is
          queued and broadcast on {network} by the settlement worker.
        </p>
      </div>
    </Modal>
  );
}
