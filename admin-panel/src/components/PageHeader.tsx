import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  /**
   * The standfirst. RENAMED FROM `subtitle` to match the merchant panel, which
   * has always called it `description` — see the note on the component below.
   */
  description?: string;
  actions?: ReactNode;
  /**
   * The running head — which section of the product this page is in ("Money in",
   * "Merchants", "Platform"). Small, quiet and letter-spaced; it orients without
   * competing with the title. Worth setting on every page that belongs to a
   * group.
   */
  eyebrow?: string;
  /**
   * A quiet line ranged right under the actions: a count, a freshness stamp,
   * "84 clients · updated 14:02". Facts about the page, not controls.
   */
  meta?: ReactNode;
}

/**
 * THE PAGE MASTHEAD.
 *
 * Running head, title, standfirst on a real measure — and NO RULE UNDER IT. The
 * outgoing version closed the block with a 2px bottom rule in slate-900 / slate-100, which was the correct gesture in a design made of
 * rules and is wrong twice over in one made of surfaces: the first card on the
 * page already draws the line between "this is the header" and "this is the
 * content", and on the dark ground a 2px near-white stroke across the full width
 * of the window is a scar rather than a rule. index.css names that exact
 * treatment as the thing `.rule-strong` was written to replace.
 *
 * THE PROP IS `description`, NOT `subtitle`. This component and the merchant
 * panel's had forked on the name of the same string, which is the kind of
 * divergence that is free to create and expensive to live with: every page
 * copied between the two panels needed an edit that did nothing. The merchant
 * panel's name wins because it is the one the design contract's page shape
 * documents, so new code written against the contract compiles here without a
 * translation step. Existing call sites are listed in the handover report.
 *
 * ACTIONS COME AFTER THE TITLE IN THE DOM, deliberately, and stay there on every
 * width: a screen-reader operator should hear WHERE THEY ARE before being
 * offered what to do there. What changes at `sm` is only the visual arrangement,
 * where they come up onto the title's baseline.
 *
 * The description sits on `.measure` rather than running the full width of a
 * 1400px console: a 160-character line is not read, it is skipped.
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
