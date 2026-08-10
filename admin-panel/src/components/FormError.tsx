import type { ReactNode } from 'react';

/**
 * A WHOLE-FORM FAILURE — "the server said no", "these two passwords differ".
 *
 * Every one of these used to be a `rounded-lg bg-red-50` panel, which on a page
 * made of rules reads as a second surface and, in dark mode, as a red box
 * floating over the sheet. Ink on a 2px red margin rule says the same thing at a
 * fraction of the weight, and the running head gives the failure a name instead
 * of leaving the operator to infer one from the colour.
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
    <div role="alert" className="border-l-2 border-red-600 pl-3 dark:border-red-400">
      <span className="runhead text-red-600 dark:text-red-400">{title}</span>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
        {children}
      </p>
    </div>
  );
}

/** The counterpart for a completed action. Emerald: it worked. */
export function FormSuccess({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="border-l-2 border-emerald-600 pl-3 dark:border-emerald-400">
      <span className="runhead text-emerald-600 dark:text-emerald-400">Done</span>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
        {children}
      </p>
    </div>
  );
}

/**
 * Something is waiting on someone, or a control has been withheld. Amber, with
 * the reason spelled out — an operator who finds a disabled Save button and no
 * explanation assumes the panel is broken.
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
  const ink =
    tone === 'waiting'
      ? 'border-amber-600 dark:border-amber-400'
      : 'border-slate-300 dark:border-slate-700';
  const head =
    tone === 'waiting'
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-slate-500 dark:text-slate-400';
  return (
    <div className={`border-l-2 pl-3 ${ink}`}>
      <span className={`runhead ${head}`}>{title}</span>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
        {children}
      </p>
    </div>
  );
}

/** One field's complaint, sat directly under the field it belongs to. */
export function FieldError({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-xs text-red-600 dark:text-red-400">{children}</p>;
}
