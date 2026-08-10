import type { ReactNode } from 'react';
import type { PaymentStatus, PayoutStatus, WebhookDeliveryStatus } from '@/types';

/**
 * Tone names. The seven original values are all still accepted — nothing that
 * passes `tone="purple"` breaks — but four semantic names have been added, and
 * NEW code should use those: they name the meaning rather than a hue, which is
 * the only thing that survives a palette change.
 */
type Tone =
  | 'gray'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'red'
  | 'purple'
  | 'indigo'
  | 'neutral'
  | 'settled'
  | 'waiting'
  | 'failed';

/**
 * SEVEN HUES COLLAPSED ONTO FOUR MEANINGS.
 *
 * The old map painted sky, purple and indigo pills alongside emerald, amber and
 * red, which put six colours on one screen carrying four meanings — and one of
 * them, indigo, was the brand hue, so "swept" and "the button you should press"
 * were the same colour. The palette this product is set in has exactly four
 * inks and they are not decorative:
 *
 *   emerald  funds arrived        amber  waiting on someone or something
 *   red      it failed            slate  everything else
 *
 * So `blue` (confirming) and `purple` (partial) resolve to amber — both are
 * states where something is still owed — and `indigo` resolves to slate.
 *
 * The 600 step for light text and the 400 step for dark: the 500 step measures
 * below AA on this ground and never carries text.
 */
const toneInk: Record<Tone, string> = {
  gray: 'text-slate-600 dark:text-slate-400',
  neutral: 'text-slate-600 dark:text-slate-400',
  indigo: 'text-slate-600 dark:text-slate-400',
  green: 'text-emerald-600 dark:text-emerald-400',
  settled: 'text-emerald-600 dark:text-emerald-400',
  yellow: 'text-amber-600 dark:text-amber-400',
  waiting: 'text-amber-600 dark:text-amber-400',
  blue: 'text-amber-600 dark:text-amber-400',
  purple: 'text-amber-600 dark:text-amber-400',
  red: 'text-red-600 dark:text-red-400',
  failed: 'text-red-600 dark:text-red-400',
};

/**
 * Amber states are drawn as a HOLLOW RING, everything else as a solid disc.
 *
 * This is the second carrier, under the word: colour is never allowed to be
 * the only thing that distinguishes two states, and in a greyscale print or
 * for a red/green-blind reader an open ring against a filled dot is a
 * difference you can still see. "Still moving" is hollow; settled, failed and
 * archival are filled.
 */
const HOLLOW: ReadonlySet<Tone> = new Set<Tone>(['yellow', 'waiting', 'blue', 'purple']);

/**
 * A status, set as a MARK AND A WORD rather than a filled pill.
 *
 * The pill was a coloured rectangle with the word inside it; at a glance a
 * merchant read the colour, and the word was decoration. Ranged as small caps
 * against a dot, the WORD is what you read and the colour and shape are what
 * confirm it — which is the right way round, and it also stops seven pills
 * fighting the hairlines for attention down a ledger column.
 */
export default function Badge({
  tone = 'gray',
  children,
  dot = false,
}: {
  tone?: Tone;
  children: ReactNode;
  dot?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium uppercase tracking-[0.1em] ${toneInk[tone]}`}
    >
      {dot &&
        (HOLLOW.has(tone) ? (
          <span
            className="h-2 w-2 shrink-0 rounded-full border-[1.5px] border-current"
            aria-hidden
          />
        ) : (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden />
        ))}
      {children}
    </span>
  );
}

/**
 * `swept` is green because the money did arrive — sweeping is the bookkeeping
 * move that follows, not a separate outcome. `partial` and `confirming` are
 * both amber: in one the customer still owes the balance, in the other the
 * chain still owes confirmations. The WORD is what tells them apart.
 */
const paymentTone: Record<PaymentStatus, Tone> = {
  waiting: 'waiting',
  confirming: 'waiting',
  confirmed: 'settled',
  partial: 'waiting',
  failed: 'failed',
  expired: 'neutral',
  swept: 'settled',
};

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  // The pulse that used to run on `waiting` and `confirming` is gone. It was an
  // INFINITE animation on the surface a merchant opens dozens of times a day,
  // and it looped hardest on exactly the rows they are already anxious about.
  // The hollow ring says "still moving" without ever moving.
  return (
    <Badge tone={paymentTone[status] ?? 'neutral'} dot>
      {status}
    </Badge>
  );
}

/** `sent` is amber, not a fourth colour: broadcast is not yet confirmed. */
const payoutTone: Record<PayoutStatus, Tone> = {
  queued: 'waiting',
  processing: 'waiting',
  sent: 'waiting',
  confirmed: 'settled',
  failed: 'failed',
};

export function PayoutStatusBadge({ status }: { status: PayoutStatus }) {
  return (
    <Badge tone={payoutTone[status] ?? 'neutral'} dot>
      {status}
    </Badge>
  );
}

const webhookTone: Record<WebhookDeliveryStatus, Tone> = {
  success: 'settled',
  failed: 'failed',
  pending: 'waiting',
};

export function WebhookStatusBadge({ status }: { status: WebhookDeliveryStatus }) {
  return (
    <Badge tone={webhookTone[status] ?? 'neutral'} dot>
      {status}
    </Badge>
  );
}
