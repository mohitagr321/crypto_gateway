import { useQuery } from '@tanstack/react-query';
import { Wallet } from 'lucide-react';
import { getAllBalances } from '@/lib/api';
import { formatAmount } from '@/lib/format';

/**
 * Per-asset balance cards, one per (network, asset) the merchant actually holds.
 *
 * Deliberately NOT a single total. Balances are not fungible across assets or
 * chains — a USDC balance cannot fund a USDT payout, and BEP20 funds cannot
 * settle to a Tron wallet — so a combined figure would be a number the merchant
 * can never withdraw as one payout.
 */
export default function BalanceStrip() {
  const { data, isLoading } = useQuery({
    queryKey: ['balances', 'all'],
    queryFn: getAllBalances,
    staleTime: 15_000,
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="card h-24 animate-pulse bg-slate-100 dark:bg-slate-800/60" />
        ))}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="card flex items-center gap-3 p-5 text-sm text-slate-500">
        <Wallet size={18} className="text-slate-400" />
        No balances yet — they appear here once a payment confirms.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {data.map((b) => (
        <div key={`${b.network}:${b.asset}`} className="card p-5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {b.asset}
            </span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              {b.network}
            </span>
          </div>
          {/* Tabular numerals so columns of money line up digit-for-digit. */}
          <p className="mt-2 text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-50">
            {formatAmount(b.available)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            available
            {Number(b.pending) > 0 && (
              <> · {formatAmount(b.pending)} pending</>
            )}
          </p>
        </div>
      ))}
    </div>
  );
}
