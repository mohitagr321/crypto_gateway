import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { NetworkLabel } from '@/components/Badge';
import DataTable, { type Column } from '@/components/DataTable';
import ErrorState from '@/components/ErrorState';
import PageHeader from '@/components/PageHeader';
import Section from '@/components/Section';
import { LoadingPanel } from '@/components/Spinner';
import { apiErrorMessage, walletBalances } from '@/lib/api';
import { addrLink, formatUsdt, networkLabel, shortHash } from '@/lib/format';
import type {
  ClientPendingBalance,
  NetworkBalances,
  NetworkWallet,
} from '@/types';

/**
 * WHERE THE MONEY ACTUALLY IS.
 *
 * The dashboard's headline is a flow; this page is the balance sheet, and it is
 * per chain and per wallet because that is the only shape a gas top-up or a
 * payout can be acted on in.
 *
 * A DRY GAS WALLET IS THE MOST IMPORTANT FACT THIS CONSOLE CAN SHOW. Every sweep
 * and every payout on that chain fails silently once it runs out, so it is
 * stated first, in words, above everything else — amber because it is waiting on
 * an operator to top it up, and it stops being true the moment they do. It now
 * gets a real surface rather than a left-hand rule printed on the canvas: an
 * alert that is structurally identical to the paragraph beside it is an alert
 * the eye does not land on, which is the one thing this notice cannot afford.
 *
 * ONE SECTION PER CHAIN, AND NOTHING IS EVER SUMMED ACROSS THEM. The two wallets
 * of a chain are grouped because they fail together — a central wallet full of
 * USDT with a dry gas wallet beside it cannot move a single cent — and that
 * pairing is the whole reason to look at this page.
 */
export default function WalletBalances() {
  const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => walletBalances(),
    // Hot-wallet balances decide whether settlement works at all — keep them
    // fresher than the rest of the panel.
    refetchInterval: 60_000,
  });

  if (isLoading) return <LoadingPanel label="Loading wallet balances…" />;
  if (isError || !data) {
    return (
      <>
        <PageHeader
          eyebrow="Platform"
          title="Wallet balances"
          description="Central, gas and per-client balances"
        />
        <ErrorState message={apiErrorMessage(error)} onRetry={() => refetch()} />
      </>
    );
  }

  // Prefer the per-network payload. Fall back to the legacy BEP20-only fields so
  // the page still renders if the panel is newer than the API it is talking to.
  const networks: NetworkBalances[] =
    data.networks && data.networks.length > 0
      ? data.networks
      : [
          {
            network: 'BEP20',
            feeCurrency: 'BNB',
            central: legacyWallet(data.central, 'BNB'),
            gas: legacyWallet(data.gas, 'BNB'),
            lowGas: false,
          },
        ];

  const columns: Column<ClientPendingBalance>[] = [
    {
      key: 'client',
      header: 'Client',
      sortValue: (c) => c.clientName.toLowerCase(),
      render: (c) => (
        <span className="font-medium text-slate-900 dark:text-slate-100">{c.clientName}</span>
      ),
    },
    {
      key: 'network',
      header: 'Network',
      sortValue: (c) => c.network ?? 'BEP20',
      render: (c) => <NetworkLabel network={c.network} />,
    },
    {
      key: 'pending',
      header: 'Pending',
      numeric: true,
      sortValue: (c) => Number(c.pending ?? 0),
      render: (c) => (
        <span className="text-slate-700 dark:text-slate-300">
          {formatUsdt(c.pending)}
          <span className="text-slate-500 dark:text-slate-400"> USDT</span>
        </span>
      ),
    },
    {
      key: 'available',
      header: 'Available',
      numeric: true,
      sortValue: (c) => Number(c.available ?? 0),
      render: (c) => (
        <span className="font-medium text-slate-900 dark:text-slate-100">
          {formatUsdt(c.available)}
          <span className="font-normal text-slate-500 dark:text-slate-400"> USDT</span>
        </span>
      ),
    },
  ];

  const lowGasNetworks = networks.filter((n) => n.lowGas);

  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Wallet balances"
        description="What each settlement chain is actually holding, and what it owes merchants."
        meta={`updated ${new Date(dataUpdatedAt).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        })} · refreshes every minute`}
      />

      {lowGasNetworks.map((n) => (
        <div
          key={`low-${n.network}`}
          role="alert"
          // A surface, plus one amber edge. The edge is what makes it findable
          // in a column of surfaces without spending a filled amber panel on it
          // — this says "act on me", not "everything is broken".
          className="surface mb-4 min-w-0 border-l-2 border-l-amber-600 px-4 py-4 sm:px-5 dark:border-l-amber-400"
        >
          <span className="runhead text-amber-600 dark:text-amber-400">
            {n.network} gas wallet is low
          </span>
          <p className="measure-wide mt-1.5 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
            <span className="num font-medium">
              {formatUsdt(n.gas.native, 4)} {n.feeCurrency}
            </span>{' '}
            left. Deposit sweeps and payouts on {n.network} will start failing once
            it runs out. Top up{' '}
            <code className="code break-all">{shortHash(n.gas.address, 10, 6)}</code> with{' '}
            {n.feeCurrency}.
          </p>
        </div>
      ))}

      {networks.map((n) => (
        <Section
          key={n.network}
          className="mb-4"
          title={networkLabel(n.network)}
          aside={
            n.lowGas ? (
              <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                Gas running low
              </span>
            ) : undefined
          }
        >
          {/* `auto-fit` rather than `lg:grid-cols-2`: the two wallets sit side by
              side wherever there is room for both and stack wherever there is
              not, with no breakpoint deciding it for them. */}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] gap-x-10 gap-y-6">
            <WalletColumn
              wallet={n.central}
              network={n.network}
              caption="Receives swept funds from deposit addresses; payouts are signed from it."
            />
            <WalletColumn
              wallet={n.gas}
              network={n.network}
              caption={`Tops up deposit addresses with ${n.feeCurrency} so they can pay their own sweep fee.`}
              warn={n.lowGas}
            />
          </div>
        </Section>
      ))}

      <Section className="mt-4" flush title="Owed to merchants">
        <DataTable
          columns={columns}
          rows={data.clientPending ?? []}
          rowKey={(c) => `${c.clientId}:${c.network ?? 'BEP20'}`}
          emptyMessage="No pending client balances."
          emptyHint="Nothing is currently sitting in a merchant's ledger waiting to be paid out."
          label="Per-client pending balances"
          defaultSortKey="available"
          defaultSortDir="desc"
          pageSize={15}
          /**
           * THE STACKED ROW. This table shipped with no `renderMobile` at all,
           * so below `md` an operator was handed a four-column ledger to drag
           * sideways — on the one page whose whole job is answering "what do we
           * owe, and on which chain".
           *
           * AVAILABLE LEADS AND PENDING FOLLOWS, which is the opposite of the
           * column order and deliberate: available is the number a payout can be
           * cut against, and pending is the one that explains it. Both print
           * their asset, because a bare figure in a stacked row has no column
           * head above it to say what it counts.
           */
          renderMobile={(c) => (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-900 dark:text-slate-50">
                  {c.clientName}
                </p>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  <NetworkLabel network={c.network} />
                </p>
              </div>
              <div className="min-w-0 shrink-0 text-right">
                <p className="num break-words text-sm font-medium text-slate-900 dark:text-slate-50">
                  {formatUsdt(c.available)} USDT
                </p>
                <p className="num mt-0.5 break-words text-xs text-slate-500 dark:text-slate-400">
                  available · {formatUsdt(c.pending)} pending
                </p>
              </div>
            </div>
          )}
        />
        <p className="measure-wide pb-1 pt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          One row per merchant and chain, never summed — a merchant holding USDT
          on BEP20 and USDT on TRC20 does not hold one combined number of
          anything.
        </p>
      </Section>
    </>
  );
}

/** Adapt the deprecated BEP20-only shape to the per-network one. */
function legacyWallet(
  w: { address: string; label: string; usdt: string; bnb: string } | undefined,
  nativeCurrency: string,
): NetworkWallet {
  return {
    address: w?.address ?? '',
    label: w?.label ?? '',
    usdt: w?.usdt ?? '0',
    native: w?.bnb ?? '0',
    nativeCurrency,
    configured: Boolean(w?.address),
  };
}

/**
 * One wallet on one chain — a ruled block INSIDE the chain's surface.
 *
 * A hairline is still the right primitive here, and that is worth stating
 * because the redesign replaced rules with surfaces almost everywhere else: this
 * is a list of readouts within a card, not a structure of its own, which is the
 * one job a rule still does better than a box.
 *
 * Two figures, both stated, never added: the stablecoin it holds and the native
 * coin it pays fees with. A wallet with plenty of USDT and no BNB cannot move a
 * single cent, which is exactly the failure this page exists to make visible.
 */
function WalletColumn({
  wallet,
  network,
  caption,
  warn = false,
}: {
  wallet: NetworkWallet;
  network: string;
  caption: string;
  warn?: boolean;
}) {
  // An unconfigured wallet is not the same as an empty one — say so plainly
  // rather than rendering a 0 that looks like a drained wallet.
  if (!wallet.configured) {
    return (
      <div className="rule min-w-0 pt-3">
        <span className="runhead">{wallet.label || 'Wallet'}</span>
        <p className="mt-2 text-base text-slate-700 dark:text-slate-300">
          Not configured for {network}
        </p>
        <p className="measure mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          {caption}
        </p>
      </div>
    );
  }

  return (
    <div className="rule min-w-0 pt-3">
      <span className="runhead">{wallet.label || 'Wallet'}</span>

      {/* ============================================================
          THE TWO FIGURES.

          This was `grid-cols-2` with `truncate` on each figure, which at 360px
          gave a `.figure-lg` about 148px to hold a chain's whole float — so a
          seven-digit central balance rendered as "1,234,5…". A truncated
          balance is silent data loss: it is a number an operator reads wrong
          rather than notices is missing. `auto-fit` lets the pair drop to one
          column when that is what fits, `min-w-0` lets a grid child shrink
          under its content at all, and `break-words` lets a long figure wrap and
          the block grow instead of cutting.
          ============================================================ */}
      <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-x-8 gap-y-4">
        <WalletFigure label="USDT" value={formatUsdt(wallet.usdt)} />
        <WalletFigure
          label={`${wallet.nativeCurrency} · fees`}
          value={formatUsdt(wallet.native, 4)}
          warn={warn}
        />
      </div>

      {/* The address is on its own line rather than ranged right of the running
          head: at the 44px touch floor it would otherwise set the height of the
          head row, and a wallet address is something an operator copies and
          checks rather than glances at. */}
      <a
        href={addrLink(wallet.address, network)}
        target="_blank"
        rel="noreferrer"
        className="link-ink mt-3 inline-flex min-h-[44px] items-center gap-1 break-all font-mono text-xs"
      >
        {shortHash(wallet.address, 10, 6)} <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
      </a>

      <p className="measure text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        {caption}
      </p>
    </div>
  );
}

function WalletFigure({
  label,
  value,
  warn = false,
}: {
  label: ReactNode;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="min-w-0">
      <span className="runhead">{label}</span>
      {/* No `text-*` utility on this, ever: `.figure-lg` is a component-layer
          clamp and a utility wins the cascade, pinning the figure to one size at
          every width. A colour utility is fine — it is not what the clamp
          sets. */}
      <p
        className={`figure-lg mt-1 break-words ${
          warn ? 'text-amber-600 dark:text-amber-400' : ''
        }`}
      >
        {value}
      </p>
      {warn && (
        <p className="mt-1 text-xs font-medium text-amber-600 dark:text-amber-400">
          Running low
        </p>
      )}
    </div>
  );
}
