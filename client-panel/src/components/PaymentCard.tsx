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

/**
 * ONE PAYMENT, ON TWO SURFACES: what to send, and what has happened to it.
 *
 * The split is the whole layout argument. The left surface is an INSTRUCTION —
 * a stranger, or a merchant testing their own integration, reads it top to
 * bottom once and acts on it. The right surface is a READOUT they come back to.
 * Mixing them, which is what a single tall card does, means the address a
 * customer is hunting for sits below a confirmation counter that changes while
 * they look for it.
 *
 * THE ADDRESS IS NEVER TRUNCATED, and this is a correctness rule rather than a
 * layout preference. It used to carry `truncate`, so the one string on the
 * screen that must be read or copied EXACTLY rendered as
 * "0x7a2f…" with no indication anything was missing. `break-all` wraps it
 * instead and the row grows. The same applies to the order id below.
 *
 * THE FIGURE IS `.figure-lg`, WITH NO SIZE UTILITY ON IT. It was `text-2xl`,
 * fixed at 24px from 320px to 4K; the clamp scales it with the viewport, and
 * putting a `text-*` utility back would pin it again — a component-layer clamp
 * always loses to a utility.
 *
 * NOTHING IN HERE IS A TINTED PANEL. The expiry notice used to be a red or
 * amber filled box; it is now the same well every other inset block uses, with
 * the state carried by INK and by the word beside it. Colour confirms; the word
 * carries.
 */
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
    <div className="grid gap-3 lg:grid-cols-2">
      {/* ============================================================
          WHAT TO SEND.
          ============================================================ */}
      <div className="surface min-w-0 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <span className="runhead">Scan to pay</span>
          <PaymentStatusBadge status={payment.status} />
        </div>

        {/* THE QR GROUND IS WHITE IN BOTH THEMES, and that is a scanner
            requirement rather than an oversight. A phone camera reads a code by
            thresholding light modules against dark ones; inverted or
            low-contrast codes are read by some scanners and not others, and the
            failure mode is a customer who cannot pay. So this is the one
            element in the product that does not follow the theme. The hairline
            around it does, so the tile still belongs to the surface. */}
        <div className="mt-4 flex justify-center">
          <div className="rounded-xl bg-white p-3 ring-1 ring-[var(--line)]">
            {useServerQr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={payment.qrCode}
                alt="Payment QR code"
                width={200}
                height={200}
                className="h-auto max-w-full"
              />
            ) : (
              <QRCodeSVG value={payment.address} size={200} level="M" includeMargin />
            )}
          </div>
        </div>

        <div className="mt-5 space-y-4">
          <div className="min-w-0">
            <span className="runhead">Amount</span>
            <p className="figure-lg mt-1.5 break-words">
              {formatAmount(payment.amount)}{' '}
              <span className="text-[0.5em] font-semibold text-slate-500 dark:text-slate-400">
                {payment.currency}
              </span>
            </p>
            {/* Where the crypto amount came from, when it was priced in fiat.
                Shown because "why 52.581765" has to be answerable from the page:
                the rate is frozen on this payment and never re-derived. */}
            {payment.fiat && (
              <p className="measure mt-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
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

          <div className="min-w-0">
            <span className="runhead">Network</span>
            <p className="mt-1.5 font-medium text-slate-900 dark:text-slate-100">
              {payment.network === 'TRC20'
                ? 'TRC20 · Tron'
                : `${payment.network} · BSC (chainId 56)`}
            </p>
          </div>

          <div className="min-w-0">
            <span className="runhead">Deposit address</span>
            {/* `items-start`, not `items-center`: once the address wraps to
                three lines the copy control must stay level with the first
                line, where the eye and the thumb both expect it. */}
            <div className="well mt-1.5 flex items-start gap-2 p-2 pl-3">
              <code className="min-w-0 flex-1 break-all py-1.5 font-mono text-sm text-slate-900 dark:text-slate-100">
                {payment.address}
              </code>
              <CopyButton value={payment.address} />
            </div>
          </div>

          {showCountdown && (
            <div className="well flex items-center gap-2 p-3 text-sm">
              <Clock
                size={16}
                aria-hidden
                className={`shrink-0 ${
                  expired
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-amber-600 dark:text-amber-400'
                }`}
              />
              {expired ? (
                <span className="font-medium text-red-600 dark:text-red-400">
                  Payment window expired
                </span>
              ) : (
                <span className="text-slate-700 dark:text-slate-300">
                  Expires in{' '}
                  <span className="num font-semibold text-amber-600 dark:text-amber-400">
                    {countdown}
                  </span>
                </span>
              )}
            </div>
          )}

          {/* Name the asset and network of THIS payment. This line used to be
              hardcoded to "USDT (BEP20)", so a customer paying USDT on Tron was
              told to send it on BNB Smart Chain — the exact cross-network
              mistake that is unrecoverable. Never hardcode either half. */}
          <p className="measure text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            Send exactly this amount of{' '}
            <span className="font-medium text-slate-900 dark:text-slate-100">
              {payment.asset ?? payment.currency}
            </span>{' '}
            on{' '}
            <span className="font-medium text-slate-900 dark:text-slate-100">
              {payment.network}
            </span>
            . Sending any other asset, or the right asset on a different network,
            cannot be recovered. Underpayments settle as partial.
          </p>
        </div>
      </div>

      {/* ============================================================
          WHAT HAS HAPPENED TO IT.
          ============================================================ */}
      <div className="surface min-w-0 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <span className="runhead">Payment status</span>
          {polling && (
            /* NO PULSE. This is a dashboard route and the frequency boundary
               bans looping animation on one; the utility that used to be here
               loops forever, and it looped hardest on the screen a merchant is
               already anxiously watching. The WORD "live" carries the meaning
               and the dot is shape, not the message — the same idiom as the
               sidebar colophon.

               The class name is deliberately NOT spelled out anywhere in this
               file: Tailwind scans .tsx as raw text, comments included, so
               naming it here would regenerate the looping utility into the
               built stylesheet even with no element using it. */
            <span className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
              Live
            </span>
          )}
        </div>

        {/* The spine: label ranged left, value ranged right against the same
            rule. One key/value idiom across every detail view in the product. */}
        <dl className="mb-5 mt-3">
          {/* `items-center` beats `.spine-row`'s own `items-baseline` — a
              utility outranks a component class on layer order alone, no
              `!important` needed. It has to: this row holds a real control, and
              a button has no text baseline to align a 13px label against. The
              negative margin gives back the height the 44px touch floor takes,
              so this row stays level with the four below it on desktop. */}
          <div className="spine-row items-center">
            <dt className="spine-label">Payment ID</dt>
            <dd className="spine-value flex items-center justify-end gap-1.5 font-mono">
              {shortHash(payment.paymentId, 10, 4)}
              <CopyButton value={payment.paymentId} size={13} className="-my-2 sm:-my-1" />
            </dd>
          </div>
          <div className="spine-row">
            <dt className="spine-label">Order ID</dt>
            <dd className="spine-value break-all font-mono">{payment.orderId}</dd>
          </div>
          <div className="spine-row">
            <dt className="spine-label">Received</dt>
            <dd className="spine-value num">
              {formatAmount(payment.amountReceived)} / {formatAmount(payment.amount)}{' '}
              {payment.currency}
            </dd>
          </div>
          <div className="spine-row">
            <dt className="spine-label">Confirmations</dt>
            <dd className="spine-value num">
              {payment.confirmations} / {requiredConfirmations}
            </dd>
          </div>
          {payment.txHash && (
            <div className="spine-row">
              <dt className="spine-label">Tx hash</dt>
              <dd className="spine-value">
                <a
                  href={explorerTx(payment.txHash, payment.network)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-sm font-mono text-brand-600 hover:underline dark:text-brand-400"
                >
                  {shortHash(payment.txHash)}
                  <ExternalLink size={12} aria-hidden />
                </a>
              </dd>
            </div>
          )}
        </dl>

        {/* Confirmation progress bar */}
        {(payment.status === 'confirming' || payment.status === 'confirmed') && (
          <div className="mb-5">
            <div className="mb-1.5 flex justify-between text-xs text-slate-500 dark:text-slate-400">
              <span>Confirming on-chain</span>
              <span className="num">
                {Math.min(payment.confirmations, requiredConfirmations)}/
                {requiredConfirmations}
              </span>
            </div>
            {/* State, not brand. This bar answers "is my money irreversible
                yet?", which is the definition of a payment state — it used to
                be bg-brand-500, i.e. the CTA colour spent on a status readout.
                Amber while confirming, emerald once confirmed, matching the
                badge above it and the checkout mock on the marketing site.

                It also scales rather than resizes: a width transition is a
                layout animation on every frame, and this bar ticks on every
                new confirmation.

                `--dur-pop` (180ms), NOT `--dur-set` (520ms): the budget on a
                dashboard route is 200ms, and the identical bar on
                PaymentDetail already runs at pop. 520ms was the marketing
                duration, left behind here.

                The track is `--line`, which IS the slate-200/slate-800 pair it
                used to name by hand — the token cannot drift when the ramp is
                retuned, and a hand-picked step can. */}
            <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--line)]">
              <div
                className={`h-full w-full origin-left transition-transform duration-[var(--dur-pop)] ease-[var(--ease-out)] ${
                  payment.status === 'confirmed'
                    ? 'bg-emerald-600 dark:bg-emerald-400'
                    : 'bg-amber-600 dark:bg-amber-400'
                }`}
                style={{
                  transform: `scaleX(${
                    requiredConfirmations > 0
                      ? Math.min(1, payment.confirmations / requiredConfirmations)
                      : 0
                  })`,
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
