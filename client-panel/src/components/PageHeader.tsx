import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  /**
   * The running head — which section of the paper this page is in ("Money in",
   * "Money out", "Developers"). Small, quiet and letter-spaced; it orients
   * without competing with the title. Optional, and worth setting on every page
   * that belongs to a group.
   */
  eyebrow?: string;
  /**
   * A quiet line ranged right under the actions: a count, a freshness stamp,
   * "340 payments · updated 14:02". Facts about the page, not controls.
   */
  meta?: ReactNode;
}

/**
 * The page masthead.
 *
 * Running head, title, standfirst on a real measure, and a heavy rule closing
 * the block — the one masthead gesture on the page, used once. `.rule-strong`
 * draws on the top edge, which is right for a band and wrong here, so this uses
 * `.rule-b-strong`: the stroke belongs UNDER the title it terminates.
 *
 * The description sits on `.measure` rather than running the full width of a
 * 1280px dashboard, because a 160-character line is not read, it is skipped.
 */
export default function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  meta,
}: PageHeaderProps) {
  return (
    <header className="rule-b-strong mb-6 flex flex-col gap-3 pb-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <span className="runhead">{eyebrow}</span>}
        <h1
          className={`text-2xl font-semibold tracking-[-0.02em] text-slate-900 dark:text-slate-50 ${
            eyebrow ? 'mt-1.5' : ''
          }`}
        >
          {title}
        </h1>
        {description && (
          <p className="measure mt-1.5 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            {description}
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
