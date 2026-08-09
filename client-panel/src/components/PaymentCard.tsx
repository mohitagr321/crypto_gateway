import { QRCodeSVG } from 'qrcode.react';
import { Clock, ExternalLink } from 'lucide-react';
import type { Payment } from '@/types';
import { explorerTx } from '@/lib/api';
import { formatAmount, shortHash } from '@/lib/format';
import { useCountdown } from '@/lib/useCountdown';
import CopyButton from './CopyButton';
import { PaymentStatusBadge } from './Badge';
import PaymentTimeline from './PaymentTimeline';

interface PaymentCardProps {
  payment: Payment;
  /** Whether the background poll is currently active. */
  polling?: boolean;
  requiredConfirmations?: number;
}

export default function PaymentCard({
  payment,
  polling = false,
  requiredConfirmations = 12,
}: PaymentCardProps) {
  const { label: countdown, expired } = useCountdown(payment.expiresAt);
  const showCountdown = payment.status === 'waiting';

  // Prefer server-provided QR data URI if present, else render the address.
  const useServerQr = Boolean(payment.qrCode);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* Left: QR + address */}
      <div className="card flex flex-col items-center p-6">
        <div className="mb-4 flex w-full items-center justify-between">
          <span className="text-sm font-medium text-slate-500">Scan to pay</span>
          <PaymentStatusBadge status={payment.status} />
        </div>

        <div className="rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
          {useServerQr ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={payment.qrCode}
              alt="Payment QR code"
              width={200}
              height={200}
            />
          ) : (
            <QRCodeSVG value={payment.address} size={200} level="M" includeMargin />
          )}
        </div>

        <div className="mt-5 w-full space-y-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Amount
            </p>
            <p className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
              {formatAmount(payment.amount)}{' '}
              <span className="text-base font-medium text-slate-500">
                {payment.currency}
              </span>
            </p>
            {/* Where the crypto amount came from, when it was priced in fiat.
                Shown because "why 52.581765" has to be answerable from the page:
                the rate is frozen on this payment and never re-derived. */}
            {payment.fiat && (
              <p className="mt-1 text-xs text-slate-500">
                {payment.fiat.currency} {formatAmount(payment.fiat.amount)} at{' '}
                {formatAmount(payment.fiat.rate)} {payment.fiat.currency}/
                {payment.currency}
                {payment.fiat.lockedAt && (
                  <>
                    {' '}
                    · locked{' '}
                    {new Date(payment.fiat.lockedAt).toLocaleString(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </>
                )}
              </p>
            )}
          </div>

          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Network
            </p>
            <p className="font-medium text-slate-700 dark:text-slate-200">
              {payment.network === 'TRC20'
                ? 'TRC20 · Tron'
                : `${payment.network} · BSC (chainId 56)`}
            </p>
          </div>

          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
              Deposit address
            </p>
            <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/60">
              <code className="min-w-0 flex-1 truncate font-mono text-sm text-slate-700 dark:text-slate-200">
                {payment.address}
              </code>
              <CopyButton value={payment.address} />
            </div>
          </div>

          {showCountdown && (
            <div
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                expired
                  ? 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                  : 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
              }`}
            >
              <Clock size={16} />
              {expired ? (
                <span>Payment window expired</span>
              ) : (
                <span>
                  Expires in <span className="font-mono font-semibold">{countdown}</span>
                </span>
              )}
            </div>
          )}

          {/* Name the asset and network of THIS payment. This line used to be
              hardcoded to "USDT (BEP20)", so a customer paying USDT on Tron was
              told to send it on BNB Smart Chain — the exact cross-network
              mistake that is unrecoverable. Never hardcode either half. */}
          <p className="text-xs text-slate-400">
            Send exactly this amount of{' '}
            <span className="font-medium text-slate-500 dark:text-slate-300">
              {payment.asset ?? payment.currency}
            </span>{' '}
            on{' '}
            <span className="font-medium text-slate-500 dark:text-slate-300">
              {payment.network}
            </span>
            . Sending any other asset, or the right asset on a different network,
            cannot be recovered. Underpayments settle as partial.
          </p>
        </div>
      </div>

      {/* Right: status + progress */}
      <div className="card p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            Payment status
          </h3>
          {polling && (
            <span className="flex items-center gap-1.5 text-xs text-slate-400">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
              Live
            </span>
          )}
        </div>

        <dl className="mb-5 space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-slate-500">Payment ID</dt>
            <dd className="flex items-center gap-1 font-mono text-slate-700 dark:text-slate-200">
              {shortHash(payment.paymentId, 10, 4)}
              <CopyButton value={payment.paymentId} size={13} />
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-500">Order ID</dt>
            <dd className="font-mono text-slate-700 dark:text-slate-200">
              {payment.orderId}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-500">Received</dt>
            <dd className="text-slate-700 dark:text-slate-200">
              {formatAmount(payment.amountReceived)} / {formatAmount(payment.amount)}{' '}
              {payment.currency}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-500">Confirmations</dt>
            <dd className="text-slate-700 dark:text-slate-200">
              {payment.confirmations} / {requiredConfirmations}
            </dd>
          </div>
          {payment.txHash && (
            <div className="flex justify-between">
              <dt className="text-slate-500">Tx hash</dt>
              <dd>
                <a
                  href={explorerTx(payment.txHash, payment.network)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-brand-600 hover:underline dark:text-brand-400"
                >
                  {shortHash(payment.txHash)}
                  <ExternalLink size={12} />
                </a>
              </dd>
            </div>
          )}
        </dl>

        {/* Confirmation progress bar */}
        {(payment.status === 'confirming' || payment.status === 'confirmed') && (
          <div className="mb-5">
            <div className="mb-1 flex justify-between text-xs text-slate-500">
              <span>Confirming on-chain</span>
              <span>
                {Math.min(payment.confirmations, requiredConfirmations)}/
                {requiredConfirmations}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
              <div
                className="h-full rounded-full bg-brand-500 transition-all"
                style={{
                  width: `${Math.min(
                    100,
                    (payment.confirmations / requiredConfirmations) * 100,
                  )}%`,
                }}
              />
            </div>
          </div>
        )}

        <PaymentTimeline payment={payment} />
      </div>
    </div>
  );
}
