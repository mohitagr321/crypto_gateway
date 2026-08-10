import { useQuery } from '@tanstack/react-query';
import { getAllBalances } from '@/lib/api';
import { formatAmount } from '@/lib/format';

/**
 * Per-asset balances, one ruled column per (network, asset) the merchant holds.
 *
 * DELIBERATELY NOT A SINGLE TOTAL, and this is the invariant to protect if
 * anyone ever asks for one. Balances are not fungible across assets or chains —
 * a USDC balance cannot fund a USDT payout, and BEP20 funds cannot settle to a
 * Tron wallet — so a combined figure would be a number the merchant can never
 * withdraw as one payout. The footnote under the strip says so on the screen,
 * rather than only here.
 *
 * The pair is always named TOGETHER. "1,204.50 USDT" is not an answer to "what
 * can I pay out"; "1,204.50 USDT on BEP20" is.
 */
export default function BalanceStrip() {
  const { data, isLoading } = useQuery({
    queryKey: ['balances', 'all'],
    queryFn: getAllBalances,
    staleTime: 15_000,
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-x-8 gap-y-6 lg:grid-cols-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rule pt-3" aria-busy="true">
            <span className="ghost h-3 w-24" aria-hidden />
            <span className="ghost mt-3 h-7 w-2/3" aria-hidden />
            <span className="ghost mt-2.5 h-2.5 w-16" aria-hidden />
            <span className="sr-only">Loading balances…</span>
          </div>
        ))}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="rule pt-3">
        <span className="runhead">Balances</span>
        <p className="measure mt-3 text-base leading-relaxed text-slate-700 dark:text-slate-300">
          Nothing settled yet.
        </p>
        <p className="measure mt-1.5 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
          A balance appears here for each network and asset pair as soon as a
          payment confirms.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-x-8 gap-y-6 lg:grid-cols-4">
        {data.map((b) => {
          const pending = Number(b.pending) > 0;
          return (
            <div key={`${b.network}:${b.asset}`} className="rule min-w-0 pt-3">
              {/* Asset and network are one label, never two facts. */}
              <span className="runhead truncate">
                {b.asset} · {b.network}
              </span>
              <p className="figure-lg mt-2 truncate">{formatAmount(b.available)}</p>
              <p className="mt-1.5 text-xs leading-snug text-slate-500 dark:text-slate-400">
                available
                {pending && (
                  <>
                    {' · '}
                    {/* amber = waiting on something, and the word carries it too. */}
                    <span className="num text-amber-600 dark:text-amber-400">
                      {formatAmount(b.pending)} pending
                    </span>
                  </>
                )}
              </p>
            </div>
          );
        })}
      </div>

      {data.length > 1 && (
        <p className="measure-wide mt-5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          Shown per network and asset, never summed — funds are not fungible across
          chains, and each pair settles from its own wallet.
        </p>
      )}
    </div>
  );
}
