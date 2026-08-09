import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Send } from 'lucide-react';
import {
  explorerTx,
  createPayout,
  getAllBalances,
  getAssets,
  getNetworks,
  getSettings,
  listPayouts,
} from '@/lib/api';
import { errorMessage } from '@/lib/api';
import { formatAmount, formatDate, shortHash } from '@/lib/format';
import type { CreatePayoutInput, Payout } from '@/types';
import PageHeader from '@/components/PageHeader';
import AssetPicker, { AssetBadge } from '@/components/AssetPicker';
import DataTable, { type Column } from '@/components/DataTable';
import { PayoutStatusBadge } from '@/components/Badge';
import StatCard from '@/components/StatCard';
import Spinner from '@/components/Spinner';
import { Wallet } from 'lucide-react';

export default function Payouts() {
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: getSettings });
  const payoutsQuery = useQuery({ queryKey: ['payouts'], queryFn: listPayouts });

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<CreatePayoutInput>({
    defaultValues: { amount: '', network: 'BEP20', asset: 'USDT' },
  });

  // A payout can only draw on the balance of its own asset, so the merchant has
  // to say which one. Networks first (the destination wallet is per-network),
  // then the assets available on it.
  const networksQuery = useQuery({
    queryKey: ['networks'],
    queryFn: getNetworks,
    staleTime: 5 * 60_000,
  });
  const networks = networksQuery.data ?? ['BEP20'];
  const selectedNetwork = watch('network') ?? 'BEP20';
  const selectedAsset = watch('asset') ?? 'USDT';

  const assetsQuery = useQuery({
    queryKey: ['assets'],
    queryFn: getAssets,
    staleTime: 5 * 60_000,
  });
  // Same reconciliation as CreatePayment: an asset that is not on the newly
  // chosen network would be submitted and rejected.
  useEffect(() => {
    const available = (assetsQuery.data ?? []).filter(
      (a) => a.network === selectedNetwork,
    );
    if (available.length && !available.some((a) => a.symbol === selectedAsset)) {
      setValue('asset', 'USDT');
    }
  }, [selectedNetwork, selectedAsset, assetsQuery.data, setValue]);

  // Show what is actually withdrawable for the chosen pair, so the merchant is
  // not guessing against a number that includes other assets.
  const balancesQuery = useQuery({
    queryKey: ['balances', 'all'],
    queryFn: getAllBalances,
    staleTime: 15_000,
  });
  const availableHere = balancesQuery.data?.find(
    (b) => b.network === selectedNetwork && b.asset === selectedAsset,
  )?.available;

  const mutation = useMutation({
    mutationFn: (input: CreatePayoutInput) => createPayout(input),
    onSuccess: () => {
      reset();
      queryClient.invalidateQueries({ queryKey: ['payouts'] });
      queryClient.invalidateQueries({ queryKey: ['balances', 'all'] });
    },
  });

  const wallet = settingsQuery.data?.payoutWallet;

  const columns: Column<Payout>[] = [
    {
      key: 'payoutId',
      header: 'Payout ID',
      render: (p) => (
        <span className="font-mono text-xs">{shortHash(p.payoutId, 10, 4)}</span>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      render: (p) => (
        <span className="flex items-center gap-2">
          <span className="font-medium tabular-nums">{formatAmount(p.amount)}</span>
          <AssetBadge asset={p.asset ?? p.currency} network={p.network} />
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (p) => <PayoutStatusBadge status={p.status} />,
    },
    {
      key: 'wallet',
      header: 'Wallet',
      hideOnMobile: true,
      render: (p) => (
        <span className="font-mono text-xs">{shortHash(p.wallet)}</span>
      ),
    },
    {
      key: 'txHash',
      header: 'Tx',
      hideOnMobile: true,
      render: (p) =>
        p.txHash ? (
          <a
            href={explorerTx(p.txHash, p.network)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono text-xs text-brand-600 hover:underline dark:text-brand-400"
          >
            {shortHash(p.txHash)}
            <ExternalLink size={11} />
          </a>
        ) : (
          <span className="text-slate-400">—</span>
        ),
    },
    {
      key: 'createdAt',
      header: 'Created',
      hideOnMobile: true,
      render: (p) => (
        <span className="whitespace-nowrap text-xs text-slate-500">
          {formatDate(p.createdAt)}
        </span>
      ),
    },
  ];

  const onSubmit = handleSubmit((v) => mutation.mutate(v));

  return (
    <>
      <PageHeader
        title="Payouts"
        description="Withdraw a balance to your configured payout wallet. Each asset settles separately."
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-1">
          {/* Scoped to the SELECTED asset. The combined figure the legacy
              /balance returns sums every asset and labels the total USDT, which
              is a number the merchant could never withdraw in one payout. */}
          <StatCard
            label={`Available ${selectedAsset}`}
            value={`${formatAmount(availableHere ?? '0')} ${selectedAsset}`}
            icon={Wallet}
            tone="emerald"
            loading={balancesQuery.isLoading}
            sub={`on ${selectedNetwork} · settles separately from other assets`}
          />

          <form onSubmit={onSubmit} className="card space-y-4 p-5">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
              Request payout
            </h3>

            {mutation.isError && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
                {errorMessage(mutation.error)}
              </div>
            )}
            {mutation.isSuccess && (
              <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                Payout queued. It will appear below shortly.
              </div>
            )}

            {networks.length > 1 && (
              <div>
                <label className="label" htmlFor="payout-network">
                  Network
                </label>
                <select id="payout-network" className="input" {...register('network')}>
                  {networks.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <AssetPicker
              id="payout-asset"
              network={selectedNetwork}
              value={selectedAsset}
              onChange={(sym) => setValue('asset', sym, { shouldDirty: true })}
              context="payout"
            />

            <div>
              <label className="label" htmlFor="amount">
                Amount ({selectedAsset})
              </label>
              <input
                id="amount"
                className="input"
                inputMode="decimal"
                placeholder="100.00"
                {...register('amount', {
                  required: 'Amount is required',
                  pattern: {
                    value: /^\d+(\.\d{1,6})?$/,
                    message: 'Enter a valid amount',
                  },
                  validate: (v) =>
                    Number(v) > 0 || 'Amount must be greater than zero',
                })}
              />
              {errors.amount && (
                <p className="mt-1 text-xs text-red-600">
                  {errors.amount.message}
                </p>
              )}
              {availableHere !== undefined && (
                <p className="mt-1 text-xs text-slate-500">
                  Available: {formatAmount(availableHere)} {selectedAsset} on{' '}
                  {selectedNetwork}
                </p>
              )}
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-800/60">
              <p className="text-slate-500">Payout wallet (BEP20)</p>
              {wallet ? (
                <code className="font-mono text-slate-700 dark:text-slate-200">
                  {shortHash(wallet, 10, 8)}
                </code>
              ) : (
                <span className="text-amber-600 dark:text-amber-400">
                  Not configured — set it in Settings first.
                </span>
              )}
            </div>

            <button
              type="submit"
              className="btn-primary w-full"
              disabled={mutation.isPending || !wallet}
            >
              {mutation.isPending ? (
                <Spinner size={16} />
              ) : (
                <>
                  <Send size={16} /> Request payout
                </>
              )}
            </button>
          </form>
        </div>

        <div className="card lg:col-span-2">
          <div className="border-b border-slate-100 px-5 py-4 dark:border-slate-800">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
              Payout history
            </h3>
          </div>
          <DataTable
            columns={columns}
            rows={payoutsQuery.data ?? []}
            rowKey={(p) => p.payoutId}
            loading={payoutsQuery.isLoading}
            error={
              payoutsQuery.isError
                ? (payoutsQuery.error as { message?: string })?.message
                : null
            }
            onRetry={() => payoutsQuery.refetch()}
            emptyLabel="No payouts yet."
          />
        </div>
      </div>
    </>
  );
}
