import type { ReactNode } from 'react';

/**
 * The page masthead.
 *
 * Running head, title, standfirst on a real measure, and a heavy rule closing
 * the block — the one masthead gesture on the page, used once. `.rule-strong`
 * draws on the TOP edge, which is right for a stacked band and wrong here: the
 * stroke belongs UNDER the title it terminates, so it is spelled out as a
 * bottom border rather than reaching for the primitive.
 *
 * The subtitle sits on `.measure` rather than running the full width of a
 * 1280px console, because a 160-character line is not read, it is skipped.
 */
export default function PageHeader({
  title,
  subtitle,
  actions,
  eyebrow,
  meta,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  /**
   * Which section of the paper this page is in ("Money in", "Merchants",
   * "Monitoring"). Small, quiet and letter-spaced; it orients without competing
   * with the title.
   */
  eyebrow?: string;
  /**
   * A quiet line ranged right under the actions: a count, a freshness stamp,
   * "84 clients · updated 14:02". Facts about the page, not controls.
   */
  meta?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-3 border-b-2 border-slate-900 pb-4 sm:flex-row sm:items-end sm:justify-between dark:border-slate-100">
      <div className="min-w-0">
        {eyebrow && <span className="runhead">{eyebrow}</span>}
        <h1
          className={`text-2xl font-semibold tracking-[-0.02em] text-slate-900 dark:text-slate-50 ${
            eyebrow ? 'mt-1.5' : ''
          }`}
        >
          {title}
        </h1>
        {subtitle && (
          <p className="measure mt-1.5 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            {subtitle}
          </p>
        )}
      </div>

      {(actions || meta) && (
        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
          {meta && (
            <div className="num text-xs leading-snug text-slate-500 dark:text-slate-400">
              {meta}
            </div>
          )}
        </div>
      )}
    </header>
  );
}
