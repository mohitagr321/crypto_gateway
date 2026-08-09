import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink, Flame, Vault } from 'lucide-react';
import Badge from '@/components/Badge';
import DataTable, { type Column } from '@/components/DataTable';
import ErrorState from '@/components/ErrorState';
import PageHeader from '@/components/PageHeader';
import Spinner from '@/components/Spinner';
import { apiErrorMessage, walletBalances } from '@/lib/api';
import { addrLink, formatUsdt, networkTone, shortHash } from '@/lib/format';
import type {
  ClientPendingBalance,
  NetworkBalances,
  NetworkWallet,
} from '@/types';

export default function WalletBalances() {
  const { data, isLoading, isError, error, refetch } = useQuery({
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
        <PageHeader title="Wallet Balances" subtitle="Central, gas and per-client balances" />
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
      render: (c) => <span className="font-medium">{c.clientName}</span>,
    },
    {
      key: 'network',
      header: 'Network',
      sortValue: (c) => c.network ?? 'BEP20',
      render: (c) => <Badge tone={networkTone(c.network)}>{c.network ?? 'BEP20'}</Badge>,
    },
    {
      key: 'pending',
      header: 'Pending',
      align: 'right',
      sortValue: (c) => Number(c.pending ?? 0),
      render: (c) => <span className="tabular-nums">{formatUsdt(c.pending)} USDT</span>,
    },
    {
      key: 'available',
      header: 'Available',
      align: 'right',
      sortValue: (c) => Number(c.available ?? 0),
      render: (c) => <span className="tabular-nums">{formatUsdt(c.available)} USDT</span>,
    },
  ];

  const lowGasNetworks = networks.filter((n) => n.lowGas);

  return (
    <>
      <PageHeader
        title="Wallet Balances"
        subtitle="Central, gas and per-client balances, per settlement network"
      />

      {/* The single most important thing on this page: if a gas wallet is dry,
          every sweep and payout on that chain fails silently until it is topped
          up. Surface it above everything else. */}
      {lowGasNetworks.map((n) => (
        <div
          key={`low-${n.network}`}
          className="mb-4 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-500/40 dark:bg-amber-500/10"
        >
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <p className="font-semibold text-amber-800 dark:text-amber-300">
              {n.network} gas wallet is low ({formatUsdt(n.gas.native, 4)} {n.feeCurrency})
            </p>
            <p className="mt-0.5 text-amber-700 dark:text-amber-400/90">
              Deposit sweeps and payouts on {n.network} will start failing once it
              runs out. Top up{' '}
              <span className="font-mono">{shortHash(n.gas.address, 10, 6)}</span> with{' '}
              {n.feeCurrency}.
            </p>
          </div>
        </div>
      ))}

      {networks.map((n) => (
        <section key={n.network} className="mb-8">
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-sm font-semibold">{n.network}</h2>
            <Badge tone={networkTone(n.network)}>
              {n.network === 'TRC20' ? 'Tron' : 'BNB Smart Chain'}
            </Badge>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <WalletCard
              wallet={n.central}
              network={n.network}
              icon={<Vault className="h-5 w-5" />}
              tone="brand"
              caption="Receives swept funds from deposit addresses; payouts are signed from it"
            />
            <WalletCard
              wallet={n.gas}
              network={n.network}
              icon={<Flame className="h-5 w-5" />}
              tone="amber"
              caption={`Tops up deposit addresses with ${n.feeCurrency} so they can pay their own sweep fee`}
              warn={n.lowGas}
            />
          </div>
        </section>
      ))}

      <h2 className="mb-3 mt-8 text-sm font-semibold">Per-client pending balances</h2>
      <DataTable
        columns={columns}
        rows={data.clientPending ?? []}
        rowKey={(c) => `${c.clientId}:${c.network ?? 'BEP20'}`}
        emptyMessage="No pending client balances."
        pageSize={15}
      />
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

function WalletCard({
  wallet,
  network,
  icon,
  tone,
  caption,
  warn = false,
}: {
  wallet: NetworkWallet;
  network: string;
  icon: React.ReactNode;
  tone: 'brand' | 'amber';
  caption: string;
  warn?: boolean;
}) {
  const toneClass =
    tone === 'brand'
      ? 'bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300'
      : 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300';

  // An unconfigured wallet is not the same as an empty one — say so plainly
  // rather than rendering a 0 that looks like a drained wallet.
  if (!wallet.configured) {
    return (
      <div className="card p-5 opacity-70">
        <div className="mb-4 flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${toneClass}`}>
            {icon}
          </div>
          <div>
            <p className="font-semibold">{wallet.label}</p>
            <p className="text-xs text-gray-500">Not configured for {network}</p>
          </div>
        </div>
        <p className="text-xs text-gray-400">{caption}</p>
      </div>
    );
  }

  return (
    <div className={`card p-5 ${warn ? 'ring-1 ring-amber-400 dark:ring-amber-500/50' : ''}`}>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${toneClass}`}>
            {icon}
          </div>
          <div>
            <p className="font-semibold">{wallet.label}</p>
            <a
              href={addrLink(wallet.address, network)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-xs text-brand-600 hover:underline"
            >
              {shortHash(wallet.address, 10, 6)} <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
        <Badge tone={networkTone(network)}>{network}</Badge>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg bg-gray-50 p-4 dark:bg-gray-800/50">
          <p className="text-xs text-gray-500">USDT</p>
          <p className="text-xl font-semibold tabular-nums">{formatUsdt(wallet.usdt)}</p>
        </div>
        <div
          className={`rounded-lg p-4 ${
            warn
              ? 'bg-amber-50 dark:bg-amber-500/10'
              : 'bg-gray-50 dark:bg-gray-800/50'
          }`}
        >
          <p className="text-xs text-gray-500">{wallet.nativeCurrency} (fees)</p>
          <p
            className={`text-xl font-semibold tabular-nums ${
              warn ? 'text-amber-700 dark:text-amber-400' : ''
            }`}
          >
            {formatUsdt(wallet.native, 4)}
          </p>
        </div>
      </div>
      <p className="mt-3 text-xs text-gray-400">{caption}</p>
    </div>
  );
}
