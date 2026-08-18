interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
}

/**
 * A FAILED FETCH, ON ITS OWN SURFACE.
 *
 * It used to be a rule and a running head printed directly on the page, which
 * was the right gesture in a design made of hairlines and reads as unfinished in
 * one made of lit surfaces — and this is exactly where that shows, because every
 * call site renders it immediately under the page header, on the bare canvas,
 * with nothing else on screen.
 *
 * IT IS THE SAME MARKUP AS THE LEDGER'S ERROR STATE, deliberately, and the two
 * must stay identical: a running head in red naming the failure, the reason
 * ranged left on a measure, and one control. An operator who sees a request fail
 * inside a table and then again on a whole page should be reading the same thing
 * twice, not learning two dialects of "it broke".
 *
 * There is no glyph, and that is a decision rather than an omission. Red text
 * plus the words "Could not load" carries it; an icon in amber would have said
 * "waiting on someone" in a palette where amber means exactly that.
 *
 * `role="alert"` because this replaces content the operator asked for — it has
 * to be announced, not merely present. `message` now has a default so a caller
 * with nothing useful from the API still renders a sentence rather than an empty
 * paragraph.
 */
export default function ErrorState({
  message = 'Failed to load data.',
  onRetry,
}: ErrorStateProps) {
  return (
    <div className="surface min-w-0 px-4 py-10 sm:px-5" role="alert">
      <span className="runhead text-red-600 dark:text-red-400">Could not load</span>
      <p className="measure mt-3 text-base leading-relaxed text-slate-700 dark:text-slate-300">
        {message}
      </p>
      {onRetry && (
        <button type="button" className="btn-secondary mt-5" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
