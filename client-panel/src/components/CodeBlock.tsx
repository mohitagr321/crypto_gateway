import { useState, type ReactNode } from 'react';
import CopyButton from './CopyButton';

export interface CodeTab {
  label: string;
  language?: string;
  code: string;
}

interface CodeBlockProps {
  tabs: CodeTab[];
  title?: ReactNode;
}

/**
 * A SNIPPET, SET AS A WELL RATHER THAN AS A BLACK BOX.
 *
 * It used to paint its own permanent night — `bg-slate-900` with a
 * `bg-slate-950` tab strip — in BOTH themes. On the dark theme that was a card
 * one step darker than the surface it sat on, which inverts the elevation
 * ladder: a raised object cannot be darker than the thing it is raised above.
 * On the light theme it was a hole cut in the page.
 *
 * `.well` is the primitive that was always meant for this — index.css names "a
 * code block" as its first example. It is INSET rather than raised, one step
 * off the surface, and it carries no rim light, because light does not catch on
 * the top edge of a hole. That makes it correct both standing on the marketing
 * canvas and nested inside a `Section` on the docs pages, which is the whole
 * reason a code block must not be a second raised surface.
 *
 * THE TABS ARE 44px BELOW `sm`. They were `px-3 py-2`, about 34px, and a tab
 * strip is the one control on a docs page a reader taps repeatedly. The brand
 * underline on the active tab is the sanctioned decorative use of brand: it
 * marks a thing you genuinely click, exactly as `.link-ink` does.
 *
 * `aria-pressed` rather than a `role="tablist"`: a real tablist owes the reader
 * arrow-key navigation and roving tabindex, and claiming the role without
 * providing them is worse for a keyboard user than a plain group of buttons
 * that behave exactly as they look.
 */
export default function CodeBlock({ tabs, title }: CodeBlockProps) {
  const [active, setActive] = useState(0);
  const current = tabs[active] ?? tabs[0];

  return (
    <div className="well min-w-0 overflow-hidden">
      <div className="rule-b flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-2">
        <div className="flex flex-wrap">
          {tabs.map((tab, i) => (
            <button
              key={tab.label}
              type="button"
              onClick={() => setActive(i)}
              aria-pressed={i === active}
              className={`min-h-[44px] border-b-2 px-3 text-xs font-medium transition-colors duration-[var(--dur-press)] ease-[var(--ease-out)] sm:min-h-[38px] ${
                i === active
                  ? 'border-brand-500 text-slate-900 dark:text-slate-50'
                  : 'border-transparent text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="flex min-w-0 items-center gap-2 py-1 pr-1">
          {title && (
            <span className="min-w-0 truncate text-xs text-slate-500 dark:text-slate-400">
              {title}
            </span>
          )}
          <CopyButton value={current.code} label="Copy" />
        </div>
      </div>
      {/* The one place a horizontal scroller is the right answer: a snippet is
          copied far more often than it is read line by line, and hard-wrapping
          code changes what the reader sees from what they will paste. */}
      <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed text-slate-800 dark:text-slate-200">
        <code className="font-mono">{current.code}</code>
      </pre>
    </div>
  );
}
