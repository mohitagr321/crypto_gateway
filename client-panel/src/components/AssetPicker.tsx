import { useQuery } from '@tanstack/react-query';
import { getAssets } from '@/lib/api';
import type { AssetInfo } from '@/types';

interface Props {
  network: string;
  value: string;
  onChange: (symbol: string) => void;
  disabled?: boolean;
  id?: string;
  /**
   * What the picker is choosing FOR. The consequence of the choice differs:
   * on a payment the customer must send that exact token; on a payout it
   * decides which balance is drawn down.
   */
  context?: 'payment' | 'payout';
}

/**
 * Coin picker, driven by GET /assets so it can only ever offer what the gateway
 * will actually accept. Hard-coding a list here is how a merchant ends up
 * selecting a token the server rejects at submit.
 *
 * Assets are scoped to a network: the same symbol on two chains is two different
 * assets with different contracts and decimals, so changing the network must
 * re-filter this list — see the reconciliation effect in the parent.
 */
export default function AssetPicker({
  network,
  value,
  onChange,
  disabled,
  id = 'asset',
  context = 'payment',
}: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['assets'],
    queryFn: getAssets,
    staleTime: 5 * 60_000,
  });

  const forNetwork: AssetInfo[] = (data ?? []).filter((a) => a.network === network);
  const selected = forNetwork.find((a) => a.symbol === value);

  // Nothing to choose between — render a static label rather than a one-option
  // dropdown, which just looks like a broken control.
  if (!isLoading && forNetwork.length <= 1) {
    const only = forNetwork[0]?.symbol ?? 'USDT';
    return (
      <div>
        <label className="label" htmlFor={id}>
          Asset
        </label>
        <div className="input flex items-center justify-between bg-slate-50 dark:bg-slate-800/60">
          <span className="font-medium">{only}</span>
          <span className="text-xs text-slate-500">
            the only asset enabled on {network}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div>
      <label className="label" htmlFor={id}>
        Asset
      </label>
      <select
        id={id}
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || isLoading}
      >
        {isLoading ? (
          <option>Loading…</option>
        ) : (
          forNetwork.map((a) => (
            <option key={`${a.network}:${a.symbol}`} value={a.symbol}>
              {a.symbol} — {a.name}
              {a.isNative ? ` (${a.network} coin)` : ''}
            </option>
          ))
        )}
      </select>
      <p className="mt-1 text-xs text-slate-500">
        {context === 'payment' ? (
          selected?.isNative ? (
            // A native coin is not a token, and the difference is not academic:
            // there is no contract to check, and an exchange withdrawal must be
            // sent on the right network or it lands somewhere unrecoverable.
            <>
              The customer sends {selected.symbol} itself — the {network} network's
              own coin, not a token on it. Withdrawing from an exchange means
              choosing the {network} network.
            </>
          ) : (
            <>
              The customer must send this exact token on {network}. Anything else
              sent to the deposit address is not credited automatically.
            </>
          )
        ) : (
          <>
            Draws on your {value} balance only — assets are never converted into
            one another.
          </>
        )}
      </p>
    </div>
  );
}

/** Compact asset+network label for tables. */
export function AssetBadge({
  asset,
  network,
}: {
  asset?: string | null;
  network?: string | null;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-medium text-slate-800 dark:text-slate-200">
        {asset ?? 'USDT'}
      </span>
      {network && (
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          {network}
        </span>
      )}
    </span>
  );
}
