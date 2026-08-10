import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowLeft, PlusCircle } from 'lucide-react';
import {
  createPayment,
  getPayment,
  getAssets,
  getNetworks,
  getRates,
  networkLabel,
} from '@/lib/api';
import { isTerminal } from '@/lib/format';
import { errorMessage } from '@/lib/api';
import type { CreatePaymentInput, Payment } from '@/types';
import PageHeader from '@/components/PageHeader';
import AssetPicker from '@/components/AssetPicker';
import PaymentCard from '@/components/PaymentCard';

/**
 * Create one payment by hand.
 *
 * SET AS A FORM ON A PAGE, NOT A FORM IN A BOX. The fields are separated by
 * hairlines and sit in the wide column of an asymmetric grid; the narrow margin
 * column carries the running head and the two facts that decide whether the
 * merchant fills this in correctly — that the address is bound to one
 * (network, asset) pair, and that a fiat price is struck once and never
 * revisited. Those notes used to be absent, or buried under the control they
 * qualified, which is where nobody reads them.
 *
 * MOTION: none on mount. The only moving thing is the fiat estimate, and it
 * moves because a value changed (the merchant typed), not because the page
 * rendered. The submit button says "Creating payment…" rather than spinning:
 * a looping glyph is banned on a dashboard route, and a sentence is a better
 * answer to "what is happening" anyway.
 *
 * BEHAVIOUR IS UNCHANGED. Exactly one pricing basis is submitted, the asset is
 * reconciled against the selected network, the created payment is polled until
 * it reaches a terminal status, and the payments list is invalidated on
 * success.
 */
export default function CreatePayment() {
  const queryClient = useQueryClient();
  const [payment, setPayment] = useState<Payment | null>(null);
  // Price in crypto (the original behaviour) or in the merchant's own currency.
  // Exactly one is submitted — the API rejects both, and sending both would
  // leave two answers to what the customer owes.
  const [fiatMode, setFiatMode] = useState(false);
  const [fiatCurrency, setFiatCurrency] = useState('USD');

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<CreatePaymentInput>({
    defaultValues: {
      amount: '',
      fiatAmount: '',
      orderId: '',
      description: '',
      network: 'BEP20',
      asset: 'USDT',
    },
  });

  // Only offer networks the gateway can actually settle on. Falls back to BEP20.
  const networksQuery = useQuery({
    queryKey: ['networks'],
    queryFn: getNetworks,
    staleTime: 5 * 60_000,
  });
  const networks = networksQuery.data ?? ['BEP20'];

  // Assets are scoped to a network — the same symbol on two chains is two
  // different assets. When the network changes, an asset that is not available
  // on the new one would be submitted and rejected, so reset to USDT (which is
  // enabled on every enabled network by construction).
  const selectedNetwork = watch('network') ?? 'BEP20';
  const selectedAsset = watch('asset') ?? 'USDT';
  const assetsQuery = useQuery({
    queryKey: ['assets'],
    queryFn: getAssets,
    staleTime: 5 * 60_000,
  });
  useEffect(() => {
    const available = (assetsQuery.data ?? []).filter(
      (a) => a.network === selectedNetwork,
    );
    if (available.length && !available.some((a) => a.symbol === selectedAsset)) {
      setValue('asset', 'USDT');
    }
  }, [selectedNetwork, selectedAsset, assetsQuery.data, setValue]);

  // Drives the currency list and the live preview below. The server holds the
  // authoritative rate; this is only so the merchant sees roughly what they are
  // about to charge before they commit to it.
  const ratesQuery = useQuery({
    queryKey: ['rates'],
    queryFn: getRates,
    staleTime: 60_000,
  });

  const fiatAmount = watch('fiatAmount');
  const liveRate = ratesQuery.data?.rates?.[fiatCurrency]?.[selectedAsset];
  const preview =
    fiatMode && liveRate && Number(fiatAmount) > 0
      ? // Rounded UP at 6 dp, mirroring the server so the preview does not
        // disagree with the quote by a digit.
        (Math.ceil((Number(fiatAmount) / Number(liveRate)) * 1e6) / 1e6).toFixed(6)
      : null;
  const rateLabel = liveRate
    ? `1 ${selectedAsset} = ${Number(liveRate).toLocaleString(undefined, {
        maximumFractionDigits: 4,
      })} ${fiatCurrency}`
    : '';

  const createMutation = useMutation({
    mutationFn: (input: CreatePaymentInput) => createPayment(input),
    onSuccess: (data) => {
      setPayment(data);
      queryClient.invalidateQueries({ queryKey: ['payments'] });
    },
  });

  // Live status polling once we have a payment, until it reaches a terminal state.
  const pollingQuery = useQuery({
    queryKey: ['payment', payment?.paymentId],
    queryFn: () => getPayment(payment!.paymentId),
    enabled: Boolean(payment) && !isTerminal(payment!.status),
    refetchInterval: (query) => {
      const data = query.state.data as Payment | undefined;
      if (data && isTerminal(data.status)) return false;
      return 5000;
    },
  });

  // Prefer freshest polled snapshot.
  const activePayment = pollingQuery.data ?? payment;
  const polling =
    Boolean(activePayment) && !isTerminal(activePayment!.status);

  // Send exactly one pricing basis. Leaving the unused field in the payload
  // would trip the API's mutual-exclusion check with a confusing error.
  const onSubmit = handleSubmit((values) =>
    createMutation.mutate(
      fiatMode
        ? { ...values, amount: undefined, fiatCurrency }
        : { ...values, fiatAmount: undefined, fiatCurrency: undefined },
    ),
  );

  const startNew = () => {
    setPayment(null);
    reset();
    createMutation.reset();
  };

  if (activePayment) {
    return (
      <>
        <PageHeader
          eyebrow="Payments"
          title="Payment created"
          description="Share the address or the QR with your customer. This page follows the payment until it settles."
          actions={
            <>
              <button className="btn-secondary" onClick={startNew}>
                <PlusCircle size={16} /> New payment
              </button>
              <Link to={`/payments/${activePayment.paymentId}`} className="btn-ghost">
                Open full detail
              </Link>
            </>
          }
          // A freshness stamp, not a state: the badge on the card carries the
          // payment's own status, and this line only says whether the page is
          // still asking.
          meta={
            polling ? 'Following this payment · refreshed every 5s' : 'Final status — polling stopped'
          }
        />
        <PaymentCard payment={activePayment} polling={polling} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Payments"
        title="Create a payment"
        description="Issue a deposit address and QR for one customer order."
        actions={
          <Link to="/payments" className="btn-ghost">
            <ArrowLeft size={16} /> All payments
          </Link>
        }
      />

      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-12">
        {/* The margin column. Everything a merchant needs to know BEFORE
            filling the form in, rather than after the address is issued and
            the mistake is permanent. */}
        <aside className="col-aside lg:col-span-4">
          <span className="runhead">One order, one address</span>
          <p className="mt-3">
            The address this creates is derived for this payment alone and is
            valid only on the network you choose. It is never reused, and funds
            sent on any other chain cannot be credited.
          </p>
          <dl className="mt-6">
            <div className="rule flex items-baseline justify-between gap-4 py-2.5">
              <dt>Pair</dt>
              <dd className="text-right font-medium text-slate-900 dark:text-slate-100">
                {selectedAsset} · {selectedNetwork}
              </dd>
            </div>
            <div className="rule flex items-baseline justify-between gap-4 py-2.5">
              <dt>Priced in</dt>
              <dd className="text-right font-medium text-slate-900 dark:text-slate-100">
                {fiatMode ? fiatCurrency : selectedAsset}
              </dd>
            </div>
            <div className="rule flex items-baseline justify-between gap-4 py-2.5">
              <dt>Rate</dt>
              <dd className="text-right font-medium text-slate-900 dark:text-slate-100">
                {fiatMode ? 'Locked at creation' : 'Not applicable'}
              </dd>
            </div>
          </dl>
        </aside>

        <form onSubmit={onSubmit} className="min-w-0 lg:col-span-7 lg:col-start-6">
          {createMutation.isError && (
            <p
              role="alert"
              className="mb-6 flex gap-2 border-t-2 border-red-600 pt-3 text-sm leading-relaxed text-red-600 dark:border-red-400 dark:text-red-400"
            >
              <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden />
              {errorMessage(createMutation.error)}
            </p>
          )}

          {/* Each field is a ruled block. `first:border-t-0` is a utility and so
              outranks `.rule`, which keeps the opening field from drawing a
              hairline immediately under the masthead rule. */}
          <div>
            <div className="rule pt-5 first:border-t-0 first:pt-0">
              <AssetPicker
                network={selectedNetwork}
                value={selectedAsset}
                onChange={(sym) => setValue('asset', sym, { shouldDirty: true })}
              />
            </div>

            {networks.length > 1 && (
              <div className="rule pt-5 first:border-t-0 first:pt-0">
                <label className="label" htmlFor="network">
                  Network
                </label>
                <select id="network" className="input" {...register('network')}>
                  {networks.map((n) => (
                    <option key={n} value={n}>
                      {networkLabel(n)}
                    </option>
                  ))}
                </select>
                <p className="measure mt-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  The deposit address is valid only on the selected network.
                </p>
              </div>
            )}

            {/* ---- Price in crypto, or in the merchant's own currency ---- */}
            <div className="rule pt-5 first:border-t-0 first:pt-0">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
                <span className="label mb-0">Price</span>
                {/* Ruled tabs rather than a filled segmented control: the ink
                    underline says "this one" without spending a fill, and the
                    two labels are words, not colours. 120ms, colour only. */}
                <div className="flex items-baseline gap-5" role="group" aria-label="Pricing basis">
                  {[
                    { on: !fiatMode, label: selectedAsset, set: () => setFiatMode(false) },
                    { on: fiatMode, label: 'Fiat', set: () => setFiatMode(true) },
                  ].map((t) => (
                    <button
                      key={t.label}
                      type="button"
                      onClick={t.set}
                      aria-pressed={t.on}
                      className={`border-b-2 pb-0.5 text-xs font-medium uppercase tracking-[0.14em] outline-none transition-colors duration-[var(--dur-press)] focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-brand-500 ${
                        t.on
                          ? 'border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-50'
                          : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {fiatMode ? (
                <>
                  <div className="flex gap-2">
                    <select
                      className="input w-28"
                      value={fiatCurrency}
                      onChange={(e) => setFiatCurrency(e.target.value)}
                      aria-label="Currency"
                    >
                      {(ratesQuery.data?.currencies ?? ['USD']).map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    <input
                      className="input num flex-1"
                      inputMode="decimal"
                      placeholder="5000"
                      aria-label="Fiat amount"
                      {...register('fiatAmount')}
                    />
                  </div>

                  {/* THE FIGURE, and the only one this page has earned: what the
                      customer will actually be asked to send. The block is
                      present for the whole of fiat mode and shows an em dash
                      until there is something to convert, so typing changes the
                      number without moving the layout under the cursor.

                      A preview, not the quote. The binding rate is struck
                      server-side at creation and returned on the payment. */}
                  {/* Deliberately NOT aria-live: it re-derives on every
                      keystroke, and a live region here would read the whole
                      figure back after each digit. */}
                  <div className="rule mt-5 pt-4">
                    <span className="runhead">Customer sends about</span>
                    <p className="mt-2 flex flex-wrap items-baseline gap-x-2.5">
                      <span className="figure-lg">{preview ?? '—'}</span>
                      <span className="text-sm font-medium text-slate-500 dark:text-slate-400">
                        {selectedAsset}
                      </span>
                    </p>
                    <p className="figure-label measure">
                      {preview
                        ? `At ${rateLabel}. The exact amount is locked when the payment is created and never revisited.`
                        : `Converted to ${selectedAsset} when the payment is created, and held for that payment.`}
                    </p>
                    {ratesQuery.data?.source?.endsWith(':stale') && (
                      // amber = waiting on something. The rate feed is still
                      // catching up; the WORD carries it, not the hue alone.
                      <p className="measure mt-2 text-xs leading-relaxed text-amber-600 dark:text-amber-400">
                        Waiting on fresh rates — these are a few minutes old.
                        Payments are quoted from the freshest rate available.
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <input
                    id="amount"
                    className="input num"
                    inputMode="decimal"
                    placeholder="50.00"
                    {...register('amount', {
                      pattern: {
                        value: /^\d+(\.\d{1,6})?$/,
                        message: 'Enter a valid amount (up to 6 decimals)',
                      },
                    })}
                  />
                  {errors.amount && (
                    <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">
                      {errors.amount.message}
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="rule pt-5 first:border-t-0 first:pt-0">
              <label className="label" htmlFor="orderId">
                Order ID
              </label>
              <input
                id="orderId"
                className="input"
                placeholder="order_789"
                {...register('orderId', { required: 'Order ID is required' })}
              />
              {errors.orderId && (
                <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">
                  {errors.orderId.message}
                </p>
              )}
            </div>

            <div className="rule pt-5 first:border-t-0 first:pt-0">
              <label className="label" htmlFor="description">
                Description{' '}
                <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <textarea
                id="description"
                className="input min-h-[80px] resize-y"
                placeholder="Order #789 — Pro plan"
                {...register('description')}
              />
            </div>
          </div>

          {/* The heavier stroke a ledger puts above its total: below it is the
              irreversible bit. */}
          <div className="rule-strong mt-8 pt-5">
            <button
              type="submit"
              className="btn-primary w-full"
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? (
                'Creating payment…'
              ) : (
                <>
                  <PlusCircle size={16} /> Create payment
                </>
              )}
            </button>
            <p className="measure mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              Creating issues a new address and starts the expiry window. It does
              not charge anyone.
            </p>
          </div>
        </form>
      </div>
    </>
  );
}
