import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Send, Wallet } from 'lucide-react';
import {
  createPayout,
  errorMessage,
  explorerTx,
  getAllBalances,
  getAssets,
  getNetworks,
  getSettings,
  listPayouts,
} from '@/lib/api';
import { formatAmount, formatDate, shortHash } from '@/lib/format';
import type { CreatePayoutInput, Payout } from '@/types';
import PageHeader from '@/components/PageHeader';
import AssetPicker from '@/components/AssetPicker';
import DataTable, { type Column } from '@/components/DataTable';
import Section from '@/components/Section';
import { PayoutStatusBadge } from '@/components/Badge';
import StatCard from '@/components/StatCard';
import Spinner from '@/components/Spinner';

/**
 * Asset and network as ONE label, never two independent facts.
 *
 * "1,204.50 USDT" is not an answer to "where did this settle" — the same symbol
 * on two chains is two different assets. `network` is optional on older records
 * that predate the column and are BEP20 by definition, which is the same default
 * `explorerTx` resolves the link with.
 */
const pairLabel = (p: Payout) => `${p.asset ?? p.currency} · ${p.network ?? 'BEP20'}`;

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

  /**
   * THE DESTINATION IS PER-NETWORK, and it used to be read as though it weren't.
   *
   * The page previously showed `payoutWallet` under a hardcoded "(BEP20)" label
   * and gated the submit button on it whatever network was selected. Two ways
   * that went wrong once TRC20 was enabled: a merchant with only a Tron wallet
   * configured found the button permanently disabled, and a merchant with only
   * an EVM wallet could submit a TRC20 payout that the server had to reject —
   * while the page displayed the 0x… address it was NOT going to.
   *
   * AccountSettings models exactly two wallets because there are exactly two
   * address formats here: a Tron address, and the one 0x… address every EVM
   * chain settles to.
   */
  const wallet =
    selectedNetwork === 'TRC20'
      ? (settingsQuery.data?.payoutWalletTrc20 ?? null)
      : (settingsQuery.data?.payoutWallet ?? null);

  // GET /payouts is paginated server-side now; listPayouts() walks the pages so
  // this table still shows the whole history rather than the first page. Beyond
  // its cap `truncated` is true and `total` is what the server actually holds,
  // so the count below never overstates what is on screen without saying so.
  const payouts = payoutsQuery.data?.rows;
  const payoutTotal = payoutsQuery.data?.total ?? 0;
  const payoutsTruncated = payoutsQuery.data?.truncated ?? false;

  const columns: Column<Payout>[] = [
    {
      key: 'payoutId',
      header: 'Payout',
      sortValue: (p) => p.payoutId,
      render: (p) => (
        <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
          {shortHash(p.payoutId, 10, 4)}
        </span>
      ),
    },
    {
      // Money: right-ranged on tabular figures, so decimal points stack down the
      // column and magnitudes can be compared without reading every row.
      key: 'amount',
      header: 'Amount',
      numeric: true,
      sortValue: (p) => Number(p.amount),
      render: (p) => (
        <span className="font-medium text-slate-900 dark:text-slate-50">
          {formatAmount(p.amount)}
        </span>
      ),
    },
    {
      key: 'asset',
      header: 'Asset',
      sortValue: (p) => pairLabel(p),
      render: (p) => (
        <span className="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
          {pairLabel(p)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (p) => p.status,
      render: (p) => <PayoutStatusBadge status={p.status} />,
    },
    {
      key: 'wallet',
      header: 'Destination',
      hideOnMobile: true,
      render: (p) => (
        <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
          {shortHash(p.wallet)}
        </span>
      ),
    },
    {
      key: 'txHash',
      header: 'Transaction',
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
            <ExternalLink size={11} aria-hidden />
          </a>
        ) : (
          // The secondary-text pair, NOT slate-400: at 3.01:1 on the light
          // ground that step is documented as borders-and-icons-only, and
          // dark:slate-500 measures 3.58:1 on the dark ground. A dash that
          // says "no transaction yet" is text and has to be legible.
          <span className="text-slate-500 dark:text-slate-400">—</span>
        ),
    },
    {
      key: 'createdAt',
      header: 'Requested',
      hideOnMobile: true,
      align: 'right',
      className: 'num',
      sortValue: (p) => new Date(p.createdAt).getTime(),
      render: (p) => (
        <span className="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
          {formatDate(p.createdAt)}
        </span>
      ),
    },
  ];

  const onSubmit = handleSubmit((v) => mutation.mutate(v));

  return (
    <>
      <PageHeader
        eyebrow="Money out"
        title="Payouts"
        description="Withdraw a balance to your configured payout wallet. Each asset settles separately."
        meta={
          payouts
            ? `${payoutTotal} payout${payoutTotal === 1 ? '' : 's'}`
            : undefined
        }
      />

      {/* Asymmetric spread, now in surfaces rather than in white space: the
          instrument in the narrow margin column, the ledger it writes into
          across the wide one. The gutter drops from `gap-10` to `gap-3` — a
          wide gutter was how the outgoing design separated two blocks that had
          no edges of their own, and once each block is a lit surface the same
          gap reads as the page falling apart. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
        <div className="grid min-w-0 content-start gap-3 lg:col-span-4">
          {/* Scoped to the SELECTED pair. The combined figure the legacy
              /balance returns sums every asset and labels the total USDT, which
              is a number the merchant could never withdraw in one payout. */}
          <StatCard
            label={`${selectedAsset} · ${selectedNetwork}`}
            value={formatAmount(availableHere ?? '0')}
            icon={Wallet}
            tone="emerald"
            loading={balancesQuery.isLoading}
            sub="available to withdraw — settles separately from every other asset"
          />

          {/* THE FORM, ON A SURFACE. A form is the densest concentration of
              controls in the product and the one place the contract's rule
              bites hardest: a column of fields printed on the bare canvas has
              nothing saying where the instrument starts and stops, so the
              submit button at the bottom looks like it belongs to the page
              rather than to the four fields above it. `Section` supplies the
              running head that `.rule` + `.runhead` used to draw by hand. */}
          <Section title="Request payout">
            <form onSubmit={onSubmit}>
              {/* Outcome messages sit in a `.well` — inset rather than raised.
                  They are a report about what just happened, not another
                  control, and dropping them a step below the surface is what
                  keeps them from competing with the fields underneath. */}
              {mutation.isError && (
                <div className="well mb-5 p-3" role="alert">
                  <span className="runhead text-red-600 dark:text-red-400">
                    Not created
                  </span>
                  <p className="measure mt-1.5 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                    {errorMessage(mutation.error)}
                  </p>
                </div>
              )}
              {mutation.isSuccess && (
                <div className="well mb-5 p-3" role="status">
                  <span className="runhead text-emerald-600 dark:text-emerald-400">
                    Queued
                  </span>
                  <p className="measure mt-1.5 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                    The payout appears in the history as soon as the gateway picks
                    it up.
                  </p>
                </div>
              )}

              <div className="space-y-4">
                {networks.length > 1 && (
                  <div>
                    <label className="label" htmlFor="payout-network">
                      Network
                    </label>
                    <select
                      id="payout-network"
                      className="input"
                      {...register('network')}
                    >
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
                    className="input num"
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
                    <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">
                      {errors.amount.message}
                    </p>
                  )}
                  {availableHere !== undefined && (
                    <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                      <span className="num">{formatAmount(availableHere)}</span>{' '}
                      {selectedAsset} available on {selectedNetwork}
                    </p>
                  )}
                </div>
              </div>

              {/* The destination, as ruled key/value rows rather than a tinted
                  panel. The spine is exactly right for two facts that answer
                  "where is this going" — and inside a surface the hairlines are
                  dividing within a block rather than pretending to be one. The
                  network is named because the wallet is per-network. */}
              <dl className="mt-6">
                <div className="spine-row">
                  <dt className="spine-label">Destination</dt>
                  <dd className="spine-value">
                    {wallet ? (
                      // A wallet address is one unbreakable token. It is elided
                      // here, but `break-all` is what guarantees the narrow
                      // margin column can never be widened by it.
                      <code className="break-all font-mono text-xs">
                        {shortHash(wallet, 10, 8)}
                      </code>
                    ) : (
                      <span className="text-amber-600 dark:text-amber-400">
                        Not configured
                      </span>
                    )}
                  </dd>
                </div>
                <div className="spine-row">
                  <dt className="spine-label">Settles on</dt>
                  <dd className="spine-value">
                    {selectedAsset} · {selectedNetwork}
                  </dd>
                </div>
              </dl>

              {!wallet && !settingsQuery.isLoading && (
                <p className="measure mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  No {selectedNetwork} payout wallet is set, so there is nowhere to
                  send the funds.{' '}
                  <Link to="/settings" className="link-ink">
                    Set one in Settings
                  </Link>
                  .
                </p>
              )}

              <button
                type="submit"
                className="btn-primary mt-6 w-full"
                disabled={mutation.isPending || !wallet}
              >
                {mutation.isPending ? (
                  <Spinner size={16} />
                ) : (
                  <>
                    <Send size={16} aria-hidden /> Request payout
                  </>
                )}
              </button>
            </form>
          </Section>
        </div>

        {/* The ledger's running head and its record count are the Section's
            title and aside — the same two pieces of information the hand-drawn
            `.rule` header carried, on a primitive that puts them at a fixed
            height on every page in the product instead of a per-page guess. */}
        <Section
          className="min-w-0 lg:col-span-8"
          flush
          title="Payout history"
          aside={
            payouts && payouts.length > 0 ? (
              <span className="num text-xs text-slate-500 dark:text-slate-400">
                {payoutsTruncated
                  ? `${payouts.length} most recent of ${payoutTotal}`
                  : `${payouts.length} record${payouts.length === 1 ? '' : 's'}`}
              </span>
            ) : undefined
          }
        >
          <DataTable
            columns={columns}
            rows={payouts ?? []}
            rowKey={(p) => p.payoutId}
            loading={payoutsQuery.isLoading}
            error={
              payoutsQuery.isError
                ? (payoutsQuery.error as { message?: string })?.message
                : null
            }
            onRetry={() => payoutsQuery.refetch()}
            emptyLabel="No payouts yet."
            emptyHint="Request one with the form on this page. It appears here as soon as it is queued, and the transaction hash lands when the gateway broadcasts it."
            label="Payout history"
            // Seven columns, so the phone gets a stacked ledger rather than a
            // sideways drag.
            renderMobile={(p) => (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-all font-mono text-xs text-slate-500 dark:text-slate-400">
                    {shortHash(p.payoutId, 10, 4)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {pairLabel(p)}
                  </p>
                  <p className="num mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {formatDate(p.createdAt)}
                  </p>
                  {/* THE PROOF, PROMOTED ONTO THE PHONE. `Transaction` is a
                      `hideOnMobile` column, so the stacked row used to drop the
                      one fact that answers "did the money actually leave" — the
                      question this page exists for. It is a real link with a
                      44px target rather than a hover affordance, because touch
                      has no hover. */}
                  {p.txHash && (
                    <a
                      href={explorerTx(p.txHash, p.network)}
                      target="_blank"
                      rel="noreferrer"
                      className="link-ink -ml-1 mt-0.5 inline-flex min-h-[44px] items-center gap-1 break-all px-1 font-mono text-xs"
                    >
                      {shortHash(p.txHash)}
                      <ExternalLink size={11} className="shrink-0" aria-hidden />
                    </a>
                  )}
                </div>
                {/* `min-w-0` rather than `shrink-0`: a payout amount must never
                    be clipped by the column it is set in. It yields width and
                    wraps instead. */}
                <div className="min-w-0 text-right">
                  <p className="num lining-nums break-words text-base font-semibold text-slate-900 dark:text-slate-50">
                    {formatAmount(p.amount)}
                  </p>
                  <div className="mt-1.5 flex justify-end">
                    <PayoutStatusBadge status={p.status} />
                  </div>
                </div>
              </div>
            )}
            // The identifier stays put while the rest of the row scrolls, and
            // the box gets a height so its header genuinely pins.
            stickyFirstColumn
            // `dvh`, not `vh`: on mobile Safari `vh` is measured against the
            // taller pre-collapse viewport, so `65vh` is more of the screen than
            // the merchant can actually see.
            maxHeight="65dvh"
          />
        </Section>
      </div>
    </>
  );
}
