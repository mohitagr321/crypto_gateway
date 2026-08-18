import type { ReactNode } from 'react';
import type { PaymentStatus, PayoutStatus, WebhookDeliveryStatus } from '@/types';

/**
 * Tone names. The seven original values are all still accepted — nothing that
 * passes `tone="purple"` breaks — but the semantic names are what NEW code
 * should use: they name the meaning rather than a hue, which is the only thing
 * that survives a palette change.
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
 * The palette this product is set in has exactly four inks and they are not
 * decorative:
 *
 *   emerald  funds arrived        amber  waiting on someone or something
 *   red      it failed            slate  everything else
 *
 * So `blue` (confirming) and `purple` (partial) resolve to amber — both are
 * states where something is still owed — and `indigo` resolves to slate,
 * because indigo is the BRAND hue and brand means "you can act on this", never
 * a state.
 *
 * The 600 step for light text and the 400 step for dark: the 500 step measures
 * below the threshold on this ground and never carries text.
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
 * WHICH TONES ARE STILL IN FLIGHT.
 *
 * These get `.st-live`, which pulses the dot's halo. It is the one looping
 * animation this design permits on a dashboard route, and it earns the
 * exception by being INFORMATION: it marks exactly the rows a merchant is
 * actively waiting on, and it is the difference between a table you read and a
 * table you scan. It travels nowhere and animates box-shadow only, so it cannot
 * reflow anything, and `prefers-reduced-motion` switches it off.
 *
 * Nothing terminal pulses. A settled payment that kept blinking would train the
 * merchant to ignore the blink, which would cost the states that need it.
 */
const LIVE: ReadonlySet<Tone> = new Set<Tone>(['yellow', 'waiting', 'blue', 'purple']);

/**
 * A status, set as a LIT LOZENGE.
 *
 * The previous system set a status as a bare word and a dot, which was right
 * for a page built from hairlines and wrong for one built from surfaces: on a
 * lit card a bare word reads as a label rather than as a state, and down a
 * ledger column it disappeared into the rows.
 *
 * THREE CARRIERS, AND COLOUR IS NEVER THE ONE THAT MATTERS:
 *   the WORD    always present, and it is what you actually read
 *   the SHAPE   in-flight states pulse; terminal states are still
 *   the COLOUR  confirms the other two
 *
 * That ordering is what keeps the ledger readable in greyscale and for a
 * red/green-blind reader.
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
    <span className={`st ${toneInk[tone]} ${dot && LIVE.has(tone) ? 'st-live' : ''}`}>
      {dot && <span className="st-dot" aria-hidden />}
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
  // `unresolved` is not `waiting`: nothing will move it on by itself. The
  // transfer may or may not be on chain, the balance stays reserved either way,
  // and it takes an operator to settle it — so it reads as needing attention
  // rather than as something in flight.
  unresolved: 'failed',
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
