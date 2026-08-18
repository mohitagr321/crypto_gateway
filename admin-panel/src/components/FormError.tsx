import type { ReactNode } from 'react';

/**
 * A WHOLE-FORM FAILURE — "the server said no", "these two passwords differ".
 *
 * Every one of these used to be a rounded panel filled with red-50, which on a page
 * made of rules read as a second surface and, in dark mode, as a red box
 * floating over the sheet. The fix at the time was to strip it back to ink on a
 * 2px red margin rule; on a page made of lit surfaces that has the opposite
 * problem — a line of type with a stroke beside it, floating on the canvas next
 * to a filled input, reads as unfinished rather than as restrained.
 *
 * SO IT IS A `.well` WITH A LIT EDGE. `.well` is the sanctioned inset surface:
 * one step off the surface it sits on, no rim light, because light does not
 * catch on the top edge of a hole. The state ink is spent on the LEFT EDGE
 * alone — a 2px rule where the hairline would be — rather than on a fill, so the
 * block reads as part of the form it belongs to instead of as an alarm painted
 * over it. The running head gives the failure a name, which is what stops the
 * operator inferring one from the colour.
 *
 * COLOUR IS NEVER THE ONLY CARRIER: the running head is a word, the ink is the
 * confirmation, and `role` tells assistive tech which of the three this is.
 *
 * Red is the ink for "this failed, or you are about to lose something", which is
 * exactly what it means here — the same meaning it carries on a failed payout.
 */
export default function FormError({
  children,
  title = 'That did not work',
}: {
  children: ReactNode;
  title?: string;
}) {
  return (
    <div role="alert" className="well border-l-2 border-l-red-600 px-3.5 py-3 dark:border-l-red-400">
      <span className="runhead text-red-600 dark:text-red-400">{title}</span>
      <p className="measure mt-1.5 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
        {children}
      </p>
    </div>
  );
}

/** The counterpart for a completed action. Emerald: it worked. */
export function FormSuccess({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="well border-l-2 border-l-emerald-600 px-3.5 py-3 dark:border-l-emerald-400"
    >
      <span className="runhead text-emerald-600 dark:text-emerald-400">Done</span>
      <p className="measure mt-1.5 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
        {children}
      </p>
    </div>
  );
}

/**
 * Something is waiting on someone, or a control has been withheld. Amber, with
 * the reason spelled out — an operator who finds a disabled Save button and no
 * explanation assumes the panel is broken.
 *
 * The `neutral` tone takes `--line` for its edge rather than a slate step, so a
 * note that is genuinely just a note is the same hairline as every other
 * hairline in the product and does not read as a fourth state.
 */
export function FormNote({
  children,
  title,
  tone = 'neutral',
}: {
  children: ReactNode;
  title: string;
  tone?: 'neutral' | 'waiting';
}) {
  const edge =
    tone === 'waiting' ? 'border-l-amber-600 dark:border-l-amber-400' : 'border-l-[var(--line)]';
  const head =
    tone === 'waiting'
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-slate-500 dark:text-slate-400';
  return (
    <div className={`well border-l-2 px-3.5 py-3 ${edge}`}>
      <span className={`runhead ${head}`}>{title}</span>
      <p className="measure mt-1.5 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
        {children}
      </p>
    </div>
  );
}

/**
 * One field's complaint, sat directly under the field it belongs to. Deliberately
 * NOT a well: it belongs to the input above it, and boxing it would separate the
 * two.
 */
export function FieldError({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-xs text-red-600 dark:text-red-400">{children}</p>;
}
