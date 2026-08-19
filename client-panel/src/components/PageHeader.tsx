import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  /**
   * The running head — which section of the product this page is in ("Money
   * in", "Money out", "Developers"). Small, quiet and letter-spaced; it orients
   * without competing with the title. Worth setting on every page that belongs
   * to a group.
   */
  eyebrow?: string;
  /**
   * A quiet line under the actions: a count, a freshness stamp, "340 payments ·
   * updated 14:02". Facts about the page, not controls.
   */
  meta?: ReactNode;
}

/**
 * THE PAGE MASTHEAD.
 *
 * Running head, title, standfirst on a real measure — and NO rule under it.
 * The outgoing version closed the block with a heavy stroke, which was the
 * correct gesture in a design made of rules and is redundant in one made of
 * surfaces: the first card on the page already draws the line between "this is
 * the header" and "this is the content", and a stroke as well is belt and
 * braces.
 *
 * ACTIONS COME FIRST IN THE DOM on small screens? No — deliberately not. They
 * stay after the title, because a screen-reader user should hear WHERE THEY
 * ARE before being offered what to do there. What changes on mobile is only the
 * visual order via flex, and only from `sm` up, where they sit on the same
 * baseline as the title.
 *
 * The description sits on `.measure` rather than running the full width of a
 * 1400px dashboard: a 160-character line is not read, it is skipped.
 */
export default function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  meta,
}: PageHeaderProps) {
  return (
    <header className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
      <div className="min-w-0">
        {eyebrow && <span className="runhead">{eyebrow}</span>}
        <h1
          className={`text-[1.75rem] font-semibold leading-[1.1] tracking-[-0.035em] text-slate-900 sm:text-3xl dark:text-slate-50 ${
            eyebrow ? 'mt-1.5' : ''
          }`}
        >
          {title}
        </h1>
        {description && (
          <p className="measure mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            {description}
          </p>
        )}
      </div>

      {(actions || meta) && (
        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
          {/* THE ACTION ROW STRETCHES ON A PHONE.
              `[&>*]:flex-1` makes every child share the width equally instead
              of shrink-wrapping to its label, which is what left a lone
              "New payment" sitting at 146px against a 343px page looking like
              it had been dropped there. From `sm` the children go back to
              their natural width and range right, which is correct where
              there is a pointer and the label is the target.
              `min-w-0` on the children is what lets a long label actually
              shrink rather than pushing the row wider than the page. */}
          {actions && (
            <div className="flex flex-wrap items-center gap-2 [&>*]:min-w-0 max-sm:[&>*]:flex-1">
              {actions}
            </div>
          )}
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
