import { useQuery } from '@tanstack/react-query';
import { Layers, Percent } from 'lucide-react';
import { getCommission } from '@/lib/api';
import { errorMessage } from '@/lib/api';
import { formatAmount, formatRate, formatDate } from '@/lib/format';
import type { CommissionTier } from '@/types';
import PageHeader from '@/components/PageHeader';
import StatCard from '@/components/StatCard';
import DataTable, { type Column } from '@/components/DataTable';
import { LoadingPanel } from '@/components/Spinner';
import ErrorState from '@/components/ErrorState';
import Badge from '@/components/Badge';

/** Human range label for a tier, e.g. "0.1 – 10 USDT" or "1000+ USDT". */
function tierRange(tier: CommissionTier, currency: string): string {
  const min = formatAmount(tier.minAmount);
  if (tier.maxAmount === null) return `${min}+ ${currency}`;
  return `${min} – ${formatAmount(tier.maxAmount)} ${currency}`;
}

/** Human rate label for a tier, e.g. "$1.00 fixed" or "1% of amount". */
function tierRate(tier: CommissionTier, currency: string): string {
  if (tier.type === 'fixed') return `${formatAmount(tier.value)} ${currency} fixed`;
  return `${formatRate(tier.value)}% of amount`;
}

export default function Commission() {
  const query = useQuery({ queryKey: ['commission'], queryFn: getCommission });
  const c = query.data;

  const tiers = c?.tiers ?? [];
  const isTiered = c?.type === 'tiered' || tiers.length > 0;

  const tierColumns: Column<CommissionTier>[] = [
    {
      key: 'range',
      header: 'Range',
      render: (t) => (
        <span className="font-medium text-slate-700 dark:text-slate-200">
          {tierRange(t, c?.currency ?? 'USDT')}
        </span>
      ),
    },
    {
      key: 'rate',
      header: 'Rate',
      render: (t) => (
        <span className="font-mono">{tierRate(t, c?.currency ?? 'USDT')}</span>
      ),
    },
  ];

  // Worked fee example on a 100 USDT payment (flat plans only).
  const example = 100;
  const pct = c ? Number(c.percent) : 0;
  const fixed = c?.fixedFee ? Number(c.fixedFee) : 0;
  const commissionFee = (example * pct) / 100 + fixed;
  const net = example - commissionFee;

  return (
    <>
      <PageHeader
        title="Commission"
        description="Your current fee schedule. Set by the gateway operator; read-only here."
      />

      {query.isLoading ? (
        <LoadingPanel />
      ) : query.isError ? (
        <ErrorState
          message={errorMessage(query.error)}
          onRetry={() => query.refetch()}
        />
      ) : c && isTiered ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard
              label="Fee schedule"
              value="Tiered"
              icon={Layers}
              tone="brand"
            />
            <StatCard
              label="Slabs"
              value={String(tiers.length)}
              tone="blue"
            />
            <StatCard
              label="Network fee paid by"
              value={<span className="capitalize">{c.networkFeePaidBy}</span>}
              tone={c.networkFeePaidBy === 'admin' ? 'emerald' : 'amber'}
            />
          </div>

          <div className="card p-6">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                Tiered fee schedule
              </h3>
              <Badge tone="gray">effective {formatDate(c.effectiveFrom)}</Badge>
            </div>

            <DataTable
              columns={tierColumns}
              rows={tiers}
              rowKey={(t) => `${t.minAmount}-${t.maxAmount ?? 'max'}`}
              emptyLabel="No tiers configured."
            />

            <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
              <p className="mb-1 font-semibold text-slate-700 dark:text-slate-200">
                How it works
              </p>
              <p>
                The whole payment amount is charged at the rate of the slab it
                falls into — the rates are not stacked across tiers. A payment
                that lands in a given range is billed entirely at that range's
                rate.
              </p>
              {c.networkFeePaidBy === 'client' ? (
                <p className="mt-2">
                  You also cover the on-chain network (gas) fee for the
                  sweep/payout — it is deducted from your side in addition to the
                  commission above.
                </p>
              ) : (
                <p className="mt-2">
                  The gateway operator covers the on-chain network (gas) fee for
                  the sweep/payout.
                </p>
              )}
            </div>
          </div>
        </div>
      ) : c ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard
              label="Commission rate"
              value={`${formatRate(c.percent)}%`}
              icon={Percent}
              tone="brand"
            />
            <StatCard
              label="Fixed fee / tx"
              value={c.fixedFee ? `${formatAmount(c.fixedFee)} ${c.currency}` : '—'}
              tone="blue"
            />
            <StatCard
              label="Network fee paid by"
              value={
                <span className="capitalize">{c.networkFeePaidBy}</span>
              }
              tone={c.networkFeePaidBy === 'admin' ? 'emerald' : 'amber'}
            />
          </div>

          <div className="card p-6">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                How fees are calculated
              </h3>
              <Badge tone="gray">
                effective {formatDate(c.effectiveFrom)}
              </Badge>
            </div>

            <p className="mb-4 text-sm text-slate-600 dark:text-slate-300">
              For each settled payment, the gateway deducts a commission before
              paying out to your wallet:
            </p>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 font-mono text-sm dark:border-slate-700 dark:bg-slate-800/60">
              commission = amount × {formatRate(c.percent)}%
              {c.fixedFee ? ` + ${formatAmount(c.fixedFee)} ${c.currency}` : ''}
              <br />
              net_payout = amount − commission
              {c.networkFeePaidBy === 'client' ? ' − network_fee' : ''}
            </div>

            <div className="mt-5">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Worked example — {example.toFixed(2)} {c.currency} payment
              </p>
              <dl className="space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <dt className="text-slate-500">Gross received</dt>
                  <dd className="text-slate-700 dark:text-slate-200">
                    {example.toFixed(2)} {c.currency}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Commission</dt>
                  <dd className="text-red-600 dark:text-red-400">
                    − {commissionFee.toFixed(2)} {c.currency}
                  </dd>
                </div>
                <div className="flex justify-between border-t border-slate-200 pt-1.5 font-medium dark:border-slate-700">
                  <dt className="text-slate-700 dark:text-slate-200">
                    Net payout
                  </dt>
                  <dd className="text-emerald-600 dark:text-emerald-400">
                    {net.toFixed(2)} {c.currency}
                  </dd>
                </div>
              </dl>
              {c.networkFeePaidBy === 'client' && (
                <p className="mt-2 text-xs text-slate-400">
                  Note: the on-chain network (gas) fee for the sweep/payout is
                  additionally deducted from your side.
                </p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
