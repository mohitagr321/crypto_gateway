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
      <div className="min-w-0">
        {/* A `<span>`, not a `<label htmlFor>`. There is no control in this
            branch to label, and an `htmlFor` pointing at a plain `<div>` is a
            dangling reference a screen reader follows to nothing. `.label`
            still carries the type, so the two branches look identical. */}
        <span className="label">Asset</span>
        {/* `.input` already fills from `--surface-2`, so the slate utilities
            that used to sit here were painting the same colour twice in light
            and fighting it in dark. It wraps rather than squeezing: at 360px
            the reason and the ticker cannot share a line, and the ticker is the
            half that must never be the one that shrinks. */}
        <div className="input flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
          <span className="font-medium text-slate-900 dark:text-slate-100">{only}</span>
          <span className="min-w-0 text-xs text-slate-500 dark:text-slate-400">
            the only asset enabled on {network}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0">
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
      <p className="measure mt-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
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

/**
 * Compact asset+network label for tables.
 *
 * NOT a `<Badge>`, and the distinction is the colour law rather than a
 * shortcut: `.st` is the status lozenge and everything wearing it is read as a
 * STATE. A network is a fact about the payment, not something that happened to
 * it, so it takes the neutral inset pill — `--surface-2` inside a `--line`
 * hairline, the same two tokens `.chip` is built from, at the smaller scale a
 * ledger cell can afford.
 *
 * 11px rather than the 10px it was. 10px uppercase with tracking is a print
 * gesture that does not survive a phone, and this sits in a table cell a
 * merchant reads down a column.
 */
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
        <span className="rounded-full border border-[var(--line)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.06em] text-slate-500 dark:text-slate-400">
          {network}
        </span>
      )}
    </span>
  );
}
