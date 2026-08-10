import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Coins, ExternalLink, Loader2, TrendingUp, Wallet } from 'lucide-react';
import { useState } from 'react';
import Badge, { NetworkLabel } from '@/components/Badge';
import DataTable, { type Column } from '@/components/DataTable';
import { BandHead } from '@/components/Editorial';
import ErrorState from '@/components/ErrorState';
import FormError from '@/components/FormError';
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
import { addrLink, formatDate, formatUsdt, networkLabel, shortHash, txLink } from '@/lib/format';
import type { AdminWithdrawal, CommissionBalance } from '@/types';

// Address shape differs per chain. Validating client-side is a courtesy — the
// server re-validates against the target chain's adapter — but it is the check
// that stops the single most costly mistake here: pasting a BEP20 address into
// a TRC20 withdrawal (or vice versa) and sending commission into the void.
const ADDRESS_RE: Record<string, RegExp> = {
  BEP20: /^0x[0-9a-fA-F]{40}$/,
  TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
};

/**
 * THE GATEWAY'S OWN MONEY.
 *
 * One band per chain, and no pooled total anywhere on the page. Commission is
 * physically held in that chain's central wallet and can only be withdrawn from
 * there, so a single combined figure would be a number nobody can act on — and
 * acting on it would mean trying to spend Tron-earned funds out of the BSC
 * wallet. The non-fungibility discipline is the correctness rule here, exactly
 * as it is on the merchant panel's balances.
 */
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
      render: (w) => (
        <span className="whitespace-nowrap text-slate-500 dark:text-slate-400">
          {formatDate(w.createdAt)}
        </span>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      sortValue: (w) => Number(w.amount ?? 0),
      render: (w) => (
        <span className="font-medium text-slate-900 dark:text-slate-100">
          {formatUsdt(w.amount)}
          <span className="font-normal text-slate-500 dark:text-slate-400"> {currency}</span>
        </span>
      ),
    },
    {
      key: 'to',
      header: 'To',
      hideOnMobile: true,
      render: (w) =>
        w.toAddress ? (
          <a
            href={addrLink(w.toAddress, w.network)}
            target="_blank"
            rel="noreferrer"
            className="link-ink inline-flex items-center gap-1 font-mono text-xs"
          >
            {shortHash(w.toAddress, 8, 4)}
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        ) : (
          <span className="text-slate-500 dark:text-slate-400">not set</span>
        ),
    },
    {
      key: 'network',
      header: 'Network',
      hideOnMobile: true,
      sortValue: (w) => w.network ?? 'BEP20',
      render: (w) => <NetworkLabel network={w.network} />,
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (w) => w.status,
      render: (w) => (
        <div>
          <Badge status={w.status} />
          {/* The reason a withdrawal failed is the whole point of the row, so it
              is printed rather than truncated into a tooltip nobody opens. */}
          {w.error && (
            <p className="mt-1 max-w-[22rem] text-xs leading-snug text-red-600 dark:text-red-400">
              {w.error}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'tx',
      header: 'Tx',
      hideOnMobile: true,
      render: (w) =>
        w.txHash ? (
          <a
            href={txLink(w.txHash, w.network)}
            target="_blank"
            rel="noreferrer"
            className="link-ink inline-flex items-center gap-1 font-mono text-xs"
          >
            {shortHash(w.txHash)} <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        ) : (
          <span className="text-slate-500 dark:text-slate-400">not broadcast</span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Money in"
        title="Revenue"
        subtitle="Commission the gateway has earned, per chain, and every withdrawal of it."
        actions={
          isSuper ? (
            <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
              <Wallet className="h-4 w-4" /> Withdraw commission
            </button>
          ) : (
            <span className="runhead">Read-only · ops role</span>
          )
        }
      />

      {balanceQuery.isError ? (
        <ErrorState
          message={apiErrorMessage(balanceQuery.error)}
          onRetry={() => balanceQuery.refetch()}
        />
      ) : (
        networkBalances.map((b) => {
          const net = b.network ?? 'BEP20';
          return (
            <section key={net} className="mb-10">
              <BandHead
                aside={
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    held in the {net} central wallet
                  </span>
                }
              >
                {networkLabel(net)}
              </BandHead>
              <div className="mt-2 grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-3">
                {/* Available first, because it is the only one of the three you
                    can do anything with. Emerald: this is money that has
                    arrived and is yours to move. */}
                <StatCard
                  label="Available to withdraw"
                  value={formatUsdt(b.available)}
                  icon={Wallet}
                  tone="emerald"
                  loading={balanceQuery.isLoading}
                  hint={`${b.currency ?? currency} · payable from the ${net} wallet now`}
                />
                <StatCard
                  label="Accrued"
                  value={formatUsdt(b.accrued)}
                  icon={TrendingUp}
                  loading={balanceQuery.isLoading}
                  hint={`${b.currency ?? currency} · total ever earned on ${net}`}
                />
                <StatCard
                  label="Withdrawn"
                  value={formatUsdt(b.withdrawn)}
                  icon={Coins}
                  loading={balanceQuery.isLoading}
                  hint={`${b.currency ?? currency} · already taken out`}
                />
              </div>
            </section>
          );
        })
      )}

      <section>
        <BandHead>Withdrawal history</BandHead>
        <div className="mt-3">
          <DataTable
            columns={columns}
            rows={historyQuery.data ?? []}
            rowKey={(w) => w.id}
            loading={historyQuery.isLoading}
            error={historyQuery.isError ? apiErrorMessage(historyQuery.error) : null}
            onRetry={() => historyQuery.refetch()}
            emptyMessage="No commission has been withdrawn yet."
            emptyHint="Every withdrawal is recorded here with the chain it settled on and the transaction that carried it."
            label="Commission withdrawals"
            defaultSortKey="createdAt"
            defaultSortDir="desc"
            skeletonRows={8}
            pageSize={15}
          />
        </div>
        <p className="measure-wide mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          Amounts are never summed across chains: commission earned on one chain
          can only be withdrawn from that chain's central wallet.
        </p>
      </section>

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
          <Wallet className="h-4 w-4 shrink-0" aria-hidden /> Withdraw commission
        </span>
      }
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={mutation.isPending}
            onClick={onSubmit}
          >
            {mutation.isPending ? (
              <Loader2 className="motion-keep h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            Withdraw
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {mutation.isError && <FormError>{apiErrorMessage(mutation.error)}</FormError>}
        {fieldError && <FormError title="Check this first">{fieldError}</FormError>}

        {balances.length > 1 && (
          <div>
            <label className="label" htmlFor="wd-network">
              Network
            </label>
            <select
              id="wd-network"
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
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Paid from the {network} central wallet. Commission is not
              transferable between chains.
            </p>
          </div>
        )}

        <div>
          <div className="flex items-baseline justify-between gap-3">
            <label className="label" htmlFor="wd-amount">
              Amount ({currency})
            </label>
            <button
              type="button"
              className="mb-1.5 text-xs font-medium text-brand-600 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-brand-400"
              onClick={() => setAmount(balance?.available ?? '')}
            >
              Max: <span className="num">{formatUsdt(balance?.available)}</span>
            </button>
          </div>
          <input
            id="wd-amount"
            className="input num"
            placeholder="100.00"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>

        <div>
          <label className="label" htmlFor="wd-address">
            Destination address ({network})
          </label>
          <input
            id="wd-address"
            className="input font-mono text-sm"
            placeholder={network === 'TRC20' ? 'T…' : '0x…'}
            value={toAddress}
            onChange={(e) => setToAddress(e.target.value)}
          />
          <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            Must be a {network === 'TRC20' ? 'Tron (T…)' : 'BEP20 (0x…)'} address.
            On-chain transfers are irreversible.
          </p>
        </div>

        <p className="measure text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          Available to withdraw: <span className="num">{formatUsdt(balance?.available)}</span>{' '}
          {currency}. The withdrawal is queued and broadcast on {network} by the
          settlement worker.
        </p>
      </div>
    </Modal>
  );
}
