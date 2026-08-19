import { useQuery } from '@tanstack/react-query';
import { getAllBalances } from '@/lib/api';
import { formatAmount } from '@/lib/format';

/**
 * Per-asset balances, one INSET TILE per (network, asset) the merchant holds.
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
 *
 * ---------------------------------------------------------------------------
 * WHY WELLS AND NOT RULES. This strip is rendered INSIDE a `Section`, which is
 * already a raised, rim-lit surface. Ruled columns printed straight onto it
 * read as flat panelling on an object that is otherwise built — the figures had
 * no edges and the eye had nothing to land on. A well is the correct answer on
 * a surface: inset rather than raised, so it groups the figure without claiming
 * a second elevation the z-plane law does not allow inside a card.
 *
 * THE FIGURE WRAPS, IT DOES NOT TRUNCATE. It used to carry `truncate`, and a
 * truncated BALANCE is silent data loss: "1,234,567.89" rendering as
 * "1,234,5…" is a number the merchant reads wrong rather than notices is
 * missing. `break-words` plus `min-w-0` on the grid child lets the tile grow
 * instead.
 *
 * THE GRID IS `auto-fit`, NOT `grid-cols-2` — but the floor is 10rem, not the
 * 13rem it started at, and that change is worth explaining because it reverses
 * an earlier decision.
 *
 * 13rem guaranteed one column on any phone, on the reasoning that two columns
 * of money at 360px is ~148px each and a figure would be squeezed. That
 * protects a balance like "1,234,567.89" — and it charged every merchant a
 * strip 830px tall on a 375px screen to do it, which is more than a full
 * viewport for six numbers. It was optimising for the rare figure at the
 * expense of every common one.
 *
 * 7.5rem is what actually fits two columns, and the number is measured rather
 * than chosen: this strip sits inside a Section, so it loses the page gutter
 * AND the section's padding — 258px of usable width on a 320px phone, not 320.
 * Two 10rem tracks plus the gap needed 332px and silently fell back to one
 * column on exactly the screens the change was for.
 *
 * The guarantee that makes a floor this low safe is already in place above:
 * the figure WRAPS. A seven-digit balance takes two lines and its tile grows,
 * which is a visible, honest degradation — and it is rare, where a strip
 * 800px tall was not.
 *
 * THE 13rem FLOOR IS STILL THERE, from `sm` up. `auto-fit` packs in as many
 * tracks as fit, so carrying 7.5rem onto a desktop would not keep the strip at
 * a sensible four across — it would pack in eight narrow ones. The low floor
 * exists to buy a second column on a phone, and nothing above it.
 */
export default function BalanceStrip() {
  const { data, isLoading } = useQuery({
    queryKey: ['balances', 'all'],
    queryFn: getAllBalances,
    staleTime: 15_000,
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,7.5rem),1fr))] gap-2.5 sm:grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] sm:gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="well min-w-0 p-3.5" aria-busy="true">
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
    // No running head of its own: the Section above already names this block,
    // and two heads 30px apart for one thing is the doubling the whole surface
    // language exists to remove. Same shape as the ledger's empty state.
    return (
      <div className="py-6">
        <span className="runhead">Nothing yet</span>
        <p className="measure mt-3 text-base leading-relaxed text-slate-700 dark:text-slate-300">
          Nothing settled yet.
        </p>
        <p className="measure mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
          A balance appears here for each network and asset pair as soon as a
          payment confirms.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,7.5rem),1fr))] gap-2.5 sm:grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] sm:gap-3">
        {data.map((b) => {
          const pending = Number(b.pending) > 0;
          return (
            <div key={`${b.network}:${b.asset}`} className="well min-w-0 p-3.5">
              {/* Asset and network are one label, never two facts. */}
              <span className="runhead">
                {b.asset} · {b.network}
              </span>
              <p className="figure-lg mt-2 break-words">{formatAmount(b.available)}</p>
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
        <p className="measure-wide mt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          Shown per network and asset, never summed — funds are not fungible across
          chains, and each pair settles from its own wallet.
        </p>
      )}
    </div>
  );
}
