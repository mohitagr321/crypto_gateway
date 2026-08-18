interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
}

/**
 * A FAILED FETCH, ON ITS OWN SURFACE.
 *
 * It used to be a centred column — an amber warning triangle over a grey line
 * of text on the bare page — and both halves of that were wrong here. Centred
 * and ragged is the shape of an apology; and a floating block of type with no
 * surface under it reads as unfinished on a page built from lit surfaces, which
 * is exactly where this appears (Dashboard renders it directly under the page
 * header, on the canvas).
 *
 * IT IS THE SAME MARKUP AS THE LEDGER'S ERROR STATE, deliberately, and the two
 * must stay identical: a running head in red naming the failure, the reason
 * ranged left on a measure, and one control. A merchant who sees a request fail
 * inside a table and then again on a whole page should be reading the same
 * thing twice, not learning two dialects of "it broke".
 *
 * The glyph is gone rather than restyled. Red text plus the word "Could not
 * load" carries it, and an icon in amber would have said "waiting" in a palette
 * where amber means exactly that.
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
