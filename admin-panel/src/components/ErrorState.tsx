/**
 * A request that failed, stated in words rather than drawn as a centred icon in
 * a box.
 *
 * The card version put an 8px triangle above a centred sentence, which reads as
 * decoration on a console: an operator wants to know WHAT failed and what to do
 * next, and both of those are text. Opened by a rule and a running head in the
 * red state ink, the same shape the ledger's own error frame uses — one language
 * for "this did not load" across the panel.
 */
export default function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="rule pt-3">
      <span className="runhead text-red-600 dark:text-red-400">Could not load</span>
      <p className="measure mt-3 text-base leading-relaxed text-slate-700 dark:text-slate-300">
        {message}
      </p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn-secondary mt-5">
          Retry
        </button>
      )}
    </div>
  );
}
