import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { explorerAddress, explorerTx, getPayment } from '@/lib/api';
import { formatAmount, formatDate, isTerminal, shortHash } from '@/lib/format';
import { useCountdown } from '@/lib/useCountdown';
import type { Payment, PaymentStatus } from '@/types';
import PageHeader from '@/components/PageHeader';
import PaymentTimeline from '@/components/PaymentTimeline';
import { PaymentStatusBadge } from '@/components/Badge';
import CopyButton from '@/components/CopyButton';

/**
 * How many confirmations the gateway waits for before a payment is irreversible.
 *
 * The dashboard payment endpoint does not return this — only the public checkout
 * status does (`CheckoutStatus.requiredConfirmations`) — so it is stated here
 * with the same value PaymentCard has always defaulted to. If the sweeper's
 * threshold ever changes, this constant and PaymentCard's default are the two
 * places that have to move together; better still, the API should return it.
 */
const REQUIRED_CONFIRMATIONS = 12;

/**
 * One sentence per status, because a coloured word is not an explanation.
 *
 * The badge carries the state (word, hue and a hollow-or-solid mark); this says
 * what it MEANS for the merchant's money, which is the question they opened the
 * record to answer.
 */
const STATUS_NOTE: Record<PaymentStatus, string> = {
  waiting:
    'Nothing has arrived yet. The deposit address is live until the window closes.',
  confirming:
    'Funds are on-chain and being confirmed. They are not irreversible until the confirmation count is met.',
  confirmed: 'Enough confirmations. The funds are yours and will be swept.',
  partial:
    'Less than the requested amount arrived. Nothing settles until the balance is paid or you resolve it.',
  failed: 'The payment failed, or a chain reorganisation reversed it.',
  expired: 'The window closed before the full amount arrived.',
  swept: 'Settled and moved to your collection wallet.',
};

/**
 * THE RECORD — one payment, set as a document.
 *
 * A running head, ONE enormous figure (the amount, always), a hairline-ruled
 * spine of facts, then the timeline. The same gesture as the hosted checkout a
 * customer sees, at dashboard density: `.figure-lg` rather than the marketing
 * `.figure-xl`, and no entrance animation of any kind.
 *
 * POLLING IS UNCHANGED: every 8 seconds until the status is terminal, at which
 * point the interval stops and the header says the record is final. The "Live"
 * dot that used to pulse here is gone — it was an infinite animation on a
 * dashboard route, and it throbbed hardest on exactly the payments a merchant is
 * already anxious about. Freshness is stated as a timestamp instead, which is
 * both calmer and more informative.
 *
 * THE ONE MOVING PART is the confirmation track, and it is keyed to the DATA:
 * it scales (never resizes — a width transition is a layout animation on every
 * frame) and only when a new confirmation actually lands. On mount it renders at
 * its final value with nothing to transition from.
 */
export default function PaymentDetail() {
  const { id = '' } = useParams();

  const query = useQuery({
    queryKey: ['payment', id],
    queryFn: () => getPayment(id),
    enabled: Boolean(id),
    refetchInterval: (q) => {
      const data = q.state.data as Payment | undefined;
      if (data && isTerminal(data.status)) return false;
      return 8000;
    },
  });

  const payment = query.data;
  const live = payment ? !isTerminal(payment.status) : false;

  return (
    <>
      <PageHeader
        eyebrow="Money in"
        title="Payment"
        actions={
          <Link to="/payments" className="btn-ghost">
            <ArrowLeft size={16} aria-hidden /> All payments
          </Link>
        }
        meta={
          payment ? (
            <>
              {live ? 'Updating every 8s' : 'Final record'}
              {query.dataUpdatedAt > 0 && (
                <>
                  {' · read '}
                  {new Date(query.dataUpdatedAt).toLocaleTimeString(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </>
              )}
            </>
          ) : undefined
        }
      />

      {query.isLoading ? (
        <LoadingRecord />
      ) : query.isError ? (
        <Dead
          mark="Could not load"
          tone="failed"
          body={
            (query.error as { message?: string })?.message ??
            'The payment could not be fetched.'
          }
          action={
            <button type="button" className="btn-secondary" onClick={() => query.refetch()}>
              Retry
            </button>
          }
        />
      ) : payment ? (
        <Record payment={payment} />
      ) : (
        <Dead
          mark="Not found"
          body="No payment matches this reference. It may belong to another account, or the link may be wrong."
          action={
            <Link to="/payments" className="btn-secondary">
              All payments
            </Link>
          }
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

function Record({ payment }: { payment: Payment }) {
  // The hook ticks once a second regardless; the countdown is only READ while a
  // payment is still waiting, exactly as it was before.
  const { label: countdown, expired } = useCountdown(payment.expiresAt);
  const asset = payment.asset ?? payment.currency;
  const windowOpen = payment.status === 'waiting' && !expired;
  const counting = payment.status === 'confirming' || payment.status === 'confirmed';
  /**
   * Whether more money is still genuinely expected at this address — which is
   * NOT the same question as whether the record is still moving. A `confirming`
   * payment has already been paid and is only waiting on the chain; showing a
   * QR there invites a SECOND transfer for money that is already in flight, and
   * an accidental double payment lands as an unexpected deposit that somebody
   * then has to refund by hand. Only `waiting` (nothing yet) and `partial`
   * (a balance still owed) are payable.
   */
  const payable = payment.status === 'waiting' || payment.status === 'partial';
  const seen = Math.min(payment.confirmations, REQUIRED_CONFIRMATIONS);
  const progress =
    REQUIRED_CONFIRMATIONS > 0 ? Math.min(1, payment.confirmations / REQUIRED_CONFIRMATIONS) : 0;

  return (
    <article>
      {/* ============================================================
          THE HEAD. The figure on the wide column, the state on the
          narrow one — asymmetric, not two equal cards.
          ============================================================ */}
      <div className="grid gap-x-10 gap-y-6 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <span className="runhead">Amount requested</span>
          <p className="mt-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            {/* `.figure-lg`, not `.figure-xl`: the marketing figure clamps to
                7.5rem and would cost a screenful to state one number. */}
            <span className="figure-lg">{formatAmount(payment.amount)}</span>
            <span className="text-base font-medium text-slate-500 dark:text-slate-400">
              {asset} · {payment.network}
            </span>
          </p>

          {/* Where an odd crypto figure came from. The rate is frozen on this
              payment and never re-derived, so "why 52.581765" is answerable
              from the record rather than from a support ticket. */}
          {payment.fiat && (
            <p className="num mt-2 text-xs text-slate-500 dark:text-slate-400">
              Priced at {payment.fiat.currency} {formatAmount(payment.fiat.amount)} · rate{' '}
              {formatAmount(payment.fiat.rate)} {payment.fiat.currency}/{asset}
              {payment.fiat.lockedAt && <> · locked {formatDate(payment.fiat.lockedAt)}</>}
              {payment.fiat.source?.endsWith(':stale') && ' · quote was stale when locked'}
            </p>
          )}

          {payment.description && (
            <p className="measure mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              {payment.description}
            </p>
          )}
        </div>

        <div className="lg:col-span-5">
          <span className="runhead">Status</span>
          <div className="mt-2">
            <PaymentStatusBadge status={payment.status} />
          </div>
          <p className="measure mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
            {STATUS_NOTE[payment.status]}
          </p>

          {/* THE ONE MOVING PART. Square ends: scaleX() on a rounded cap
              stretches it into an oval. Amber while it is still owed,
              emerald once the money is kept — state colour, never brand, and
              the count beside it says the same thing in words. */}
          {counting && (
            <div className="rule mt-4 pt-3">
              <div className="flex items-baseline justify-between gap-4">
                <span className="runhead">Confirmations</span>
                <span className="num lining-nums text-sm text-slate-500 dark:text-slate-400">
                  <span className="font-semibold text-slate-900 dark:text-slate-100">
                    {seen}
                  </span>
                  {' / '}
                  {REQUIRED_CONFIRMATIONS}
                </span>
              </div>
              <div
                className="mt-2 h-[3px] w-full overflow-hidden bg-slate-200 dark:bg-slate-800"
                aria-hidden
              >
                <div
                  className={`h-full w-full origin-left transition-transform duration-[var(--dur-pop)] ease-[var(--ease-out)] ${
                    payment.status === 'confirmed'
                      ? 'bg-emerald-600 dark:bg-emerald-400'
                      : 'bg-amber-600 dark:bg-amber-400'
                  }`}
                  style={{ transform: `scaleX(${progress})` }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ============================================================
          THE SPINE and, in the margin column, the proof: the QR while
          the payment can still be paid, then the timeline.
          ============================================================ */}
      <div className="mt-10 grid gap-x-10 gap-y-10 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <span className="runhead">Record</span>
          <dl className="mt-2">
            <SpineRow label="Order">
              <span className="font-medium">{payment.orderId}</span>
            </SpineRow>

            <SpineRow label="Payment ID">
              <span className="flex items-center justify-end gap-1">
                <code className="min-w-0 break-all font-mono text-xs">{payment.paymentId}</code>
                <CopyButton value={payment.paymentId} size={13} />
              </span>
            </SpineRow>

            {/* Never the symbol alone. An address is only valid on the chain it
                was issued on, and this pair is what says which one. */}
            <SpineRow label="Asset">
              <span className="font-semibold">{asset}</span>
              <span className="text-slate-500 dark:text-slate-400"> on </span>
              <span className="font-semibold">{payment.network}</span>
            </SpineRow>

            <SpineRow label="Received">
              <span className="num lining-nums">
                <span
                  className={
                    payment.status === 'partial'
                      ? 'font-semibold text-amber-600 dark:text-amber-400'
                      : 'font-medium'
                  }
                >
                  {formatAmount(payment.amountReceived)}
                </span>
                <span className="text-slate-500 dark:text-slate-400">
                  {' '}
                  of {formatAmount(payment.amount)} {asset}
                </span>
              </span>
              {payment.status === 'partial' && (
                <span className="block text-xs text-amber-600 dark:text-amber-400">
                  short of the requested amount
                </span>
              )}
            </SpineRow>

            <SpineRow label="Confirmations">
              <span className="num lining-nums">
                {payment.confirmations} of {REQUIRED_CONFIRMATIONS}
              </span>
            </SpineRow>

            <SpineRow label="Transaction">
              {payment.txHash ? (
                <a
                  href={explorerTx(payment.txHash, payment.network)}
                  target="_blank"
                  rel="noreferrer"
                  className="link-ink inline-flex items-center gap-1 font-mono text-xs"
                >
                  {shortHash(payment.txHash, 10, 8)}
                  <ExternalLink size={12} aria-hidden />
                </a>
              ) : (
                <span className="text-slate-500 dark:text-slate-400">
                  not seen on-chain yet
                </span>
              )}
            </SpineRow>

            <SpineRow label="Created">
              <span className="num text-slate-600 dark:text-slate-300">
                {formatDate(payment.createdAt)}
              </span>
            </SpineRow>

            <SpineRow label={windowOpen ? 'Closes in' : 'Window'}>
              {windowOpen ? (
                <>
                  <span className="num lining-nums font-semibold">{countdown}</span>
                  <span className="num text-slate-500 dark:text-slate-400">
                    {' · '}
                    {formatDate(payment.expiresAt)}
                  </span>
                </>
              ) : (
                <>
                  <span className="num text-slate-600 dark:text-slate-300">
                    {formatDate(payment.expiresAt)}
                  </span>
                  {/* The window lapsing and the gateway marking it expired are
                      two different moments, and a merchant looking at a record
                      stuck on "waiting" past its expiry should be told which
                      one they are in rather than left to wonder. */}
                  {payment.status === 'waiting' && (
                    <span className="block text-xs text-amber-600 dark:text-amber-400">
                      window closed · not yet marked expired
                    </span>
                  )}
                </>
              )}
            </SpineRow>
          </dl>

          {/* THE ADDRESS. Kept on every record, not just the open ones: a
              merchant reconciling a late or wrong-asset deposit needs to know
              which address the customer was given. */}
          <div className="rule mt-8 pt-4">
            <span className="runhead">Deposit address · {payment.network}</span>
            <code className="mt-2 block break-all font-mono text-sm leading-relaxed text-slate-900 dark:text-slate-50">
              {payment.address}
            </code>
            <div className="-ml-2 mt-2 flex flex-wrap items-center gap-1">
              <CopyButton value={payment.address} label="Copy address" size={14} />
              <a
                href={explorerAddress(payment.address, payment.network)}
                target="_blank"
                rel="noreferrer"
                className="link-ink inline-flex items-center gap-1 px-2 text-xs font-medium"
              >
                View on explorer
                <ExternalLink size={12} aria-hidden />
              </a>
            </div>
            {payable && (
              <p className="measure mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                Accepts {asset} on {payment.network} only. The right asset on the wrong
                network, or any other token, is not credited automatically and cannot be
                recovered by us.
              </p>
            )}
          </div>
        </div>

        <div className="lg:col-span-5">
          {/* The QR is only worth showing while money is still owed — see
              `payable`. On a settled, failed or expired record it is an
              invitation to send money to an address nothing is watching for,
              and on a confirming one it invites paying twice. */}
          {payable && (
            <div className="mb-8">
              <span className="runhead">
                {payment.status === 'partial' ? 'Scan to pay the balance' : 'Scan to pay'}
              </span>
              {/* The white plate is not decoration: a QR needs a light quiet
                  zone to scan, including in dark mode. The server's own QR is
                  preferred when present — it may encode a payment URI rather
                  than a bare address, and re-rendering it here would silently
                  drop the amount. */}
              <div className="mt-3 w-fit rounded-lg bg-white p-3 ring-1 ring-slate-200 dark:ring-slate-700">
                {payment.qrCode ? (
                  <img src={payment.qrCode} alt="Payment QR code" width={176} height={176} />
                ) : (
                  <QRCodeSVG value={payment.address} size={176} level="M" includeMargin={false} />
                )}
              </div>
              <p className="measure mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                {payment.status === 'partial'
                  ? `The same address still accepts ${asset} on ${payment.network}; only the outstanding balance is owed.`
                  : `Still open — any wallet holding ${asset} on ${payment.network} can pay it.`}
              </p>
            </div>
          )}

          {/* PaymentTimeline draws its step markers with a ring in the colour
              of a CARD, which is what it used to sit inside. This page is set
              on the paper itself, so the ring is repainted to the page ground —
              otherwise every marker wears a visible halo in dark mode. Same
              values, higher specificity, no change to the component. */}
          <div className="[&_li_span]:ring-slate-50 dark:[&_li_span]:ring-slate-950">
            <PaymentTimeline payment={payment} />
          </div>
        </div>
      </div>
    </article>
  );
}

/** A ruled row of the spine: label ranged left, fact ranged right. */
function SpineRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="spine-row">
      <dt className="spine-label">{label}</dt>
      <dd className="spine-value">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Non-record states — set the same way the ledger sets its own, so a failed
// fetch on this page and on the list page read as the same product.
// ---------------------------------------------------------------------------

function Dead({
  mark,
  body,
  action,
  tone = 'neutral',
}: {
  mark: string;
  body: string;
  action?: ReactNode;
  tone?: 'neutral' | 'failed';
}) {
  return (
    <div className="py-10">
      <span className={`runhead ${tone === 'failed' ? 'text-red-600 dark:text-red-400' : ''}`}>
        {mark}
      </span>
      <p className="measure mt-3 text-base leading-relaxed text-slate-700 dark:text-slate-300">
        {body}
      </p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/**
 * The document, ghosted. Static — `.ghost`, never `.skeleton`: the shimmer is
 * an infinite loop and this screen is opened dozens of times a day. The shapes
 * match the real layout so nothing jumps when the payment lands.
 */
function LoadingRecord() {
  return (
    <div aria-busy="true">
      <span className="sr-only" role="status">
        Loading payment…
      </span>

      <div className="grid gap-x-10 gap-y-6 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <span className="ghost h-2.5 w-32" />
          <span className="ghost mt-3 h-9 w-64 max-w-full" />
        </div>
        <div className="lg:col-span-5">
          <span className="ghost h-2.5 w-16" />
          <span className="ghost mt-3 h-3 w-28" />
        </div>
      </div>

      <div className="mt-10 lg:w-7/12">
        <span className="ghost h-2.5 w-20" />
        <div className="mt-2">
          {Array.from({ length: 6 }, (_, i) => (
            <div
              key={i}
              className="rule flex items-center justify-between gap-4 py-3.5"
              // Stepped down the page so the block reads as "not loaded yet"
              // without a single frame of animation.
              style={{ opacity: Math.max(0.25, 1 - i * 0.12) }}
            >
              <span className="ghost h-3 w-24" />
              <span className="ghost h-3 w-40 max-w-[45%]" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
