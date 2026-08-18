import type { ReactNode } from 'react';
import { classNames, networkLabel } from '@/lib/format';

/**
 * Tone names. Every value the console already passes is still accepted — nothing
 * that says `tone="purple"` breaks — but the four semantic names are what NEW
 * code should use: they name the MEANING rather than a hue, which is the only
 * thing that survives a palette change.
 *
 * THE UNION IS NOW THE MERCHANT PANEL'S, exactly. It was missing `indigo`, which
 * meant a component copied between the two panels failed to typecheck in this
 * direction only — the kind of divergence that costs nothing to create and an
 * afternoon to find.
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
 * SEVEN HUES COLLAPSED ONTO FOUR MEANINGS — byte-for-byte the same collapse the
 * merchant panel's Badge makes, because these two components render the same
 * statuses and an operator with both panels open must not see two greens.
 *
 * The palette this product is set in has exactly four inks and they are not
 * decorative:
 *
 *   emerald  funds arrived / healthy      amber  waiting on someone or something
 *   red      it failed, or it is unsafe   slate  everything else
 *
 * So `blue` (confirming, processing) and `purple` (partial) resolve to amber —
 * both are states where something is still owed — and `indigo` resolves to
 * slate, because indigo is the BRAND hue and brand means "you can act on this",
 * never a state.
 *
 * `purple` USED TO RESOLVE TO SLATE HERE and to amber over there, on the same
 * word. Nothing in this console passes it, so aligning it is free; leaving the
 * two mappings forked was a silent trap for the first page that did.
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
 * WHICH TONES ARE STILL IN FLIGHT.
 *
 * These get `.st-live`, which pulses the dot's halo. It is the one looping
 * animation this design permits on a console route, and it earns the exception
 * by being INFORMATION: it marks exactly the rows an operator is actively
 * waiting on — a payout still broadcasting, a webhook still retrying — and it is
 * the difference between a table you read and a table you scan. It travels
 * nowhere and animates box-shadow only, so it cannot reflow anything, and
 * `prefers-reduced-motion` switches it off.
 *
 * Nothing terminal pulses. A settled payment that kept blinking would train the
 * operator to ignore the blink, which would cost the states that need it.
 *
 * This replaces the HOLLOW ring the outgoing badge drew for the same set. The
 * ring was the right second carrier for a design made of hairlines; on a lozenge
 * the shape carrier is motion, and it is a stronger one — a ring and a disc are
 * two 6px marks that differ by a hairline, while a pulse is unmistakable at a
 * glance down a column of forty rows.
 */
const LIVE: ReadonlySet<Tone> = new Set<Tone>(['yellow', 'waiting', 'blue', 'purple']);

/**
 * Every status string this console renders, mapped onto a meaning.
 *
 * `swept` is settled because the money did arrive — sweeping is the bookkeeping
 * move that follows, not a separate outcome. A payout that has been `sent` is
 * amber, not green: broadcast is not yet confirmed, and an operator who reads
 * "sent" as "done" is the person who double-pays a merchant.
 */
const STATUS_TONE: Record<string, Tone> = {
  // clients
  active: 'settled',
  pending: 'waiting',
  suspended: 'failed',
  rejected: 'neutral',
  // payments / transactions
  waiting: 'waiting',
  confirming: 'waiting',
  confirmed: 'settled',
  swept: 'settled',
  partial: 'waiting',
  failed: 'failed',
  expired: 'neutral',
  // payouts and admin withdrawals
  queued: 'waiting',
  processing: 'waiting',
  sent: 'waiting',
  // `unresolved`: the broadcast threw and we do not know whether the transaction
  // reached the chain. Deliberately NOT 'waiting' — nothing automatic will ever
  // move it on, and a row that looks like it is merely queued is a row nobody
  // opens. It needs a human to check the explorer, so it gets the tone that
  // demands attention. Falling through to 'neutral' would have made the one
  // payout state that requires action the quietest thing on the screen.
  unresolved: 'failed',
  // webhook / generic
  success: 'settled',
  true: 'settled',
  false: 'failed',
};

export function statusTone(status?: string): Tone {
  if (!status) return 'neutral';
  return STATUS_TONE[status.toLowerCase()] ?? 'neutral';
}

/**
 * A status, set as a LIT LOZENGE.
 *
 * The previous system set a status as a bare word and a dot, which was right for
 * a page built from hairlines and wrong for one built from surfaces: on a lit
 * card a bare word reads as a label rather than as a state, and down a ledger
 * column it disappeared into the rows.
 *
 * THREE CARRIERS, AND COLOUR IS NEVER THE ONE THAT MATTERS:
 *   the WORD    always present, and it is what you actually read
 *   the SHAPE   in-flight states pulse; terminal states are still
 *   the COLOUR  confirms the other two
 *
 * That ordering is what keeps the ledger readable in greyscale and for a
 * red/green-blind operator.
 *
 * `dot` NOW DEFAULTS TO FALSE, matching the merchant panel. It defaulted to true
 * here, which is the second half of the same fork as the tone union: the same
 * component, given the same props, rendered differently in the two windows of
 * one product. Every existing call site in this console relies on the old
 * default and therefore needs `dot` added explicitly — they are listed in the
 * handover report, because they live in page files this pass does not own.
 */
export default function Badge({
  children,
  tone,
  status,
  dot = false,
  className,
}: {
  children?: ReactNode;
  tone?: Tone;
  status?: string;
  /** The lit mark. Off by default; pass it on any row-level status readout. */
  dot?: boolean;
  className?: string;
}) {
  const resolved = tone ?? statusTone(status);
  return (
    <span
      className={classNames(
        'st',
        toneInk[resolved],
        dot && LIVE.has(resolved) && 'st-live',
        className,
      )}
    >
      {dot && <span className="st-dot" aria-hidden />}
      {children ?? status}
    </span>
  );
}

/**
 * THE CHAIN, set as a LABEL rather than as a coloured chip.
 *
 * A network is not a state, and the old treatment painted it amber or purple in
 * a column sitting next to a status badge — so a BEP20 row and a "waiting" row
 * were the same colour, in the same table, meaning nothing in common. Here the
 * chain is ink and the human name of it is the quiet half, which also stops the
 * two networks reading as two severities.
 *
 * It is deliberately NOT a `.st` lozenge for the same reason: the lozenge is the
 * shape this product uses to say "this is a state", and spending it on a chain
 * name would put a fifth meaning into a vocabulary that has exactly four.
 *
 * `full` prints "BEP20 · BSC"; the short form is for a column that already has
 * the chain in its header.
 */
export function NetworkLabel({
  network,
  full = false,
}: {
  network?: string | null;
  full?: boolean;
}) {
  const name = network ?? 'BEP20';
  if (!full) {
    return (
      <span className="whitespace-nowrap font-medium text-slate-800 dark:text-slate-200">
        {name}
      </span>
    );
  }
  const [chain, human] = networkLabel(name).split(' · ');
  return (
    <span className="whitespace-nowrap">
      <span className="font-medium text-slate-800 dark:text-slate-200">{chain}</span>
      <span className="text-slate-500 dark:text-slate-400"> · {human}</span>
    </span>
  );
}
