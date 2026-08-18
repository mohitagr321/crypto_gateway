import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

interface SectionProps {
  /** The running head. Names the block; does not compete with what is in it. */
  title: ReactNode;
  /** Ranged right on the same line — a "View all" link, a filter, a count. */
  aside?: ReactNode;
  children: ReactNode;
  /**
   * Drop the body's bottom padding for a section whose whole content is a
   * ledger. A table ranges to the edges of its own surface; padding would inset
   * the rows from the rules that divide them.
   */
  flush?: boolean;
  className?: string;
}

/**
 * A SECTION, ON ITS OWN SURFACE.
 *
 * This is the page-level primitive the whole product is now assembled from, and
 * it replaces the "band" the outgoing design used — a block of content opened
 * by a hairline and printed straight onto the page.
 *
 * WHY THE CHANGE. A stack of bands divided by rules gives the eye no target: it
 * is one continuous column, and every heading in it has the same status as
 * every other. Grouping related data onto a raised, rim-lit surface lets a
 * merchant's eye land on ONE thing — "balances", "recent payments" — and the
 * page becomes the spaces between those things rather than an undifferentiated
 * run of type.
 *
 * IT IS NOT A `.spot`. The metric tiles light under the cursor because they are
 * small, discrete and read as objects; a section is a container, and lighting a
 * whole region as the pointer crosses it is noise rather than depth. Spotlight
 * the things inside it instead.
 */
export default function Section({
  title,
  aside,
  children,
  flush = false,
  className = '',
}: SectionProps) {
  return (
    <section className={`surface min-w-0 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3.5 sm:px-5">
        <h2 className="runhead text-slate-700 dark:text-slate-200">{title}</h2>
        {aside}
      </div>
      <div className={flush ? 'px-4 pb-2 sm:px-5' : 'px-4 pb-4 sm:px-5 sm:pb-5'}>{children}</div>
    </section>
  );
}

/**
 * "View all →", the repeated affordance beside a section head. Brand ink,
 * because it is a thing you can act on — which is the one job brand has.
 *
 * A router `Link`, not an `<a href>`: a bare anchor inside a SPA does a full
 * document navigation, which throws away the query cache and re-downloads the
 * bundle to move between two routes that are already loaded.
 */
export function MoreLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
    >
      {children} <ArrowRight size={13} aria-hidden />
    </Link>
  );
}
