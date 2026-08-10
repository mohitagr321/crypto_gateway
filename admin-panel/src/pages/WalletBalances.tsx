import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { NetworkLabel } from '@/components/Badge';
import DataTable, { type Column } from '@/components/DataTable';
import { BandHead, Figure } from '@/components/Editorial';
import ErrorState from '@/components/ErrorState';
import PageHeader from '@/components/PageHeader';
import Spinner from '@/components/Spinner';
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
 * an operator to top it up, and it stops being true the moment they do.
 */
export default function WalletBalances() {
  const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => walletBalances(),
    // Hot-wallet balances decide whether settlement works at all — keep them
    // fresher than the rest of the panel.
    refetchInterval: 60_000,
  });

  if (isLoading) return <Spinner label="Loading wallet balances…" />;
  if (isError || !data) {
    return (
      <>
        <PageHeader
          eyebrow="Platform"
          title="Wallet balances"
          subtitle="Central, gas and per-client balances"
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
        subtitle="What each settlement chain is actually holding, and what it owes merchants."
        meta={`updated ${new Date(dataUpdatedAt).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        })} · refreshes every minute`}
      />

      {lowGasNetworks.map((n) => (
        <div
          key={`low-${n.network}`}
          role="alert"
          className="mb-6 border-l-2 border-amber-600 pl-4 dark:border-amber-400"
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
            <code className="code">{shortHash(n.gas.address, 10, 6)}</code> with{' '}
            {n.feeCurrency}.
          </p>
        </div>
      ))}

      {networks.map((n) => (
        <section key={n.network} className="mb-10">
          <BandHead>{networkLabel(n.network)}</BandHead>
          <div className="mt-2 grid grid-cols-1 gap-x-10 gap-y-8 lg:grid-cols-2">
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
        </section>
      ))}

      <section>
        <BandHead>Owed to merchants</BandHead>
        <div className="mt-3">
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
          />
        </div>
        <p className="measure-wide mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          One row per merchant and chain, never summed — a merchant holding USDT
          on BEP20 and USDT on TRC20 does not hold one combined number of
          anything.
        </p>
      </section>
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
 * One wallet on one chain, set as a ruled column rather than a card.
 *
 * Two figures, side by side and both stated: the stablecoin it holds and the
 * native coin it pays fees with. They are different assets and are never added
 * — a wallet with plenty of USDT and no BNB cannot move a single cent, which is
 * exactly the failure this page exists to make visible.
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
      <div className="rule pt-3">
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
    <div className="rule pt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="runhead">{wallet.label || 'Wallet'}</span>
        <a
          href={addrLink(wallet.address, network)}
          target="_blank"
          rel="noreferrer"
          className="link-ink inline-flex items-center gap-1 font-mono text-xs"
        >
          {shortHash(wallet.address, 10, 6)} <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-8">
        <WalletFigure label="USDT" value={formatUsdt(wallet.usdt)} />
        <WalletFigure
          label={`${wallet.nativeCurrency} · fees`}
          value={formatUsdt(wallet.native, 4)}
          warn={warn}
        />
      </div>

      <p className="measure mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
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
    <div>
      <span className="runhead">{label}</span>
      <Figure
        className={`mt-1 truncate ${warn ? '!text-amber-600 dark:!text-amber-400' : ''}`}
      >
        {value}
      </Figure>
      {warn && (
        <p className="mt-1 text-xs font-medium text-amber-600 dark:text-amber-400">
          Running low
        </p>
      )}
    </div>
  );
}
