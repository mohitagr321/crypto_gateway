import type { ReactNode } from 'react';
import { classNames, networkLabel } from '@/lib/format';

/**
 * Tone names. Every value the console already passes is still accepted — nothing
 * that says `tone="purple"` breaks — but the four semantic names are what NEW
 * code should use: they name the MEANING rather than a hue, which is the only
 * thing that survives a palette change.
 */
type Tone =
  | 'gray'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'red'
  | 'purple'
  | 'neutral'
  | 'settled'
  | 'waiting'
  | 'failed';

/**
 * SIX HUES COLLAPSED ONTO FOUR MEANINGS — byte-for-byte the same collapse the
 * merchant panel's Badge makes, because these two components render the same
 * statuses and an operator with both panels open must not see two greens.
 *
 * The palette this product is set in has exactly four inks and they are not
 * decorative:
 *
 *   emerald  funds arrived / healthy      amber  waiting on someone or something
 *   red      it failed, or it is unsafe   slate  everything else
 *
 * So `blue` (confirming, processing) and `purple` (swept, and the old network
 * chips) resolve into the semantic set rather than adding two more colours to a
 * screen that already has four.
 *
 * The 600 step for light text and the 400 step for dark: the 500 step measures
 * below AA on this ground and never carries text.
 */
const toneInk: Record<Tone, string> = {
  gray: 'text-slate-600 dark:text-slate-400',
  neutral: 'text-slate-600 dark:text-slate-400',
  purple: 'text-slate-600 dark:text-slate-400',
  green: 'text-emerald-600 dark:text-emerald-400',
  settled: 'text-emerald-600 dark:text-emerald-400',
  yellow: 'text-amber-600 dark:text-amber-400',
  waiting: 'text-amber-600 dark:text-amber-400',
  blue: 'text-amber-600 dark:text-amber-400',
  red: 'text-red-600 dark:text-red-400',
  failed: 'text-red-600 dark:text-red-400',
};

/**
 * Amber states are drawn as a HOLLOW RING, everything else as a solid disc.
 *
 * This is the second carrier under the word: colour is never allowed to be the
 * only thing separating two states, and in a greyscale print or for a
 * red/green-blind operator an open ring against a filled dot is a difference you
 * can still see. "Still moving" is hollow; settled, failed and archival are
 * filled.
 */
const HOLLOW: ReadonlySet<Tone> = new Set<Tone>(['yellow', 'waiting', 'blue']);

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
 * A status, set as a MARK AND A WORD rather than a filled pill.
 *
 * The pill was a coloured rectangle with the word inside it; at a glance an
 * operator read the colour and the word was decoration. Ranged as small caps
 * against a dot, the WORD is what you read and the colour and shape are what
 * confirm it — which is the right way round, and it also stops six pills
 * fighting the hairlines for attention down a ledger column.
 */
export default function Badge({
  children,
  tone,
  status,
  dot = true,
  className,
}: {
  children?: ReactNode;
  tone?: Tone;
  status?: string;
  /** The mark. On by default; turn it off where an icon already carries shape. */
  dot?: boolean;
  className?: string;
}) {
  const resolved = tone ?? statusTone(status);
  return (
    <span
      className={classNames(
        'inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium uppercase tracking-[0.1em]',
        toneInk[resolved],
        className,
      )}
    >
      {dot &&
        (HOLLOW.has(resolved) ? (
          <span
            className="h-2 w-2 shrink-0 rounded-full border-[1.5px] border-current"
            aria-hidden
          />
        ) : (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden />
        ))}
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
