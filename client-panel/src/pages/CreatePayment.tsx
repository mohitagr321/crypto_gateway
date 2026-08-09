import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowLeft, PlusCircle } from 'lucide-react';
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
import Spinner from '@/components/Spinner';

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
          title="Payment created"
          description="Share this with your customer. Status updates automatically."
          actions={
            <button className="btn-secondary" onClick={startNew}>
              <PlusCircle size={16} /> New payment
            </button>
          }
        />
        <PaymentCard payment={activePayment} polling={polling} />
        <div className="mt-4">
          <Link
            to={`/payments/${activePayment.paymentId}`}
            className="text-sm text-brand-600 hover:underline dark:text-brand-400"
          >
            Open full payment detail →
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Create Payment"
        description="Generate a fresh deposit address + QR for a customer order."
        actions={
          <Link to="/payments" className="btn-ghost">
            <ArrowLeft size={16} /> All payments
          </Link>
        }
      />

      <div className="mx-auto max-w-xl">
        <form onSubmit={onSubmit} className="card space-y-5 p-6">
          {createMutation.isError && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
              {errorMessage(createMutation.error)}
            </div>
          )}

          <AssetPicker
            network={selectedNetwork}
            value={selectedAsset}
            onChange={(sym) => setValue('asset', sym, { shouldDirty: true })}
          />

          {networks.length > 1 && (
            <div>
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
              <p className="mt-1 text-xs text-slate-400">
                The deposit address is valid only on the selected network.
              </p>
            </div>
          )}

          {/* ---- Price in crypto, or in the merchant's own currency ---- */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="label mb-0">Price</span>
              <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs font-medium dark:bg-slate-800">
                <button
                  type="button"
                  className={`rounded-md px-2.5 py-1 transition ${
                    !fiatMode
                      ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
                      : 'text-slate-500'
                  }`}
                  onClick={() => setFiatMode(false)}
                >
                  {selectedAsset}
                </button>
                <button
                  type="button"
                  className={`rounded-md px-2.5 py-1 transition ${
                    fiatMode
                      ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
                      : 'text-slate-500'
                  }`}
                  onClick={() => setFiatMode(true)}
                >
                  Fiat
                </button>
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
                {/* A preview, not the quote. The binding rate is struck
                    server-side at creation and returned on the payment. */}
                <p className="mt-1.5 text-xs text-slate-500">
                  {preview
                    ? `≈ ${preview} ${selectedAsset} at ${rateLabel}. The exact amount is locked when the payment is created.`
                    : `Converted to ${selectedAsset} when the payment is created, and held for that payment.`}
                </p>
                {ratesQuery.data?.source?.endsWith(':stale') && (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                    Rates are a few minutes old — the gateway is still refreshing
                    them. Payments are quoted from the freshest rate available.
                  </p>
                )}
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
                  <p className="mt-1 text-xs text-red-600">{errors.amount.message}</p>
                )}
              </>
            )}
          </div>

          <div>
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
              <p className="mt-1 text-xs text-red-600">
                {errors.orderId.message}
              </p>
            )}
          </div>

          <div>
            <label className="label" htmlFor="description">
              Description <span className="text-slate-400">(optional)</span>
            </label>
            <textarea
              id="description"
              className="input min-h-[80px] resize-y"
              placeholder="Order #789 — Pro plan"
              {...register('description')}
            />
          </div>

          <button
            type="submit"
            className="btn-primary w-full"
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? (
              <Spinner size={16} />
            ) : (
              <>
                <PlusCircle size={16} /> Create payment
              </>
            )}
          </button>
        </form>
      </div>
    </>
  );
}
