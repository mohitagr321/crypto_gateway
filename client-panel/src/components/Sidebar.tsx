import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import BrandMark from './BrandMark';
import { NAV_GROUPS, SETUP_GROUP } from '@/lib/nav';
import type { NavGroup, NavItem } from '@/lib/nav';
import { getNetworks, getOnboarding, listUnexpectedDeposits } from '@/lib/api';

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

/**
 * THE RAIL.
 *
 * It sits on the CANVAS plane, not the surface plane: no fill, no shadow, one
 * hairline separating it from the page. That is deliberate and it is what makes
 * the depth field read as continuous behind the whole app — a filled rail would
 * cut a rectangle out of the atmosphere and the illusion would end at its edge.
 *
 * WORKING DENSITY, NOT THEATRE. A merchant opens this dozens of times a day, so
 * nothing here has a hero, nothing enters on mount, and the groups buy their
 * whitespace at 12px rather than 48.
 *
 * THE ACTIVE ITEM IS MARKED THREE WAYS — a lit rail in the margin, a brand wash
 * behind the row, and `aria-current="page"`, which NavLink sets for us. Colour
 * is never the only carrier.
 *
 * ON MOBILE it is a drawer, and VISIBILITY IS PART OF THE DRAWER rather than
 * just its transform. Off-screen is not hidden: the closed drawer kept all
 * fourteen links in the tab order, so a keyboard user tabbed through an
 * invisible nav before reaching the page. `invisible` fixes that, and
 * transitioning it alongside the transform is what keeps the slide-out visible
 * — a discrete property flips at the START going visible and at the END going
 * hidden, which is exactly the behaviour a drawer wants.
 */
export default function Sidebar({ open, onClose }: SidebarProps) {
  // "Get started" appears only while setup is incomplete — once a merchant is
  // configured, a permanent link to a page of ticked boxes is just clutter.
  const onboarding = useQuery({
    queryKey: ['onboarding'],
    queryFn: getOnboarding,
    retry: false,
  });
  // The colophon used to hardcode "BEP20 · BSC", which was wrong the moment
  // TRC20 shipped. Read the gateway's real capability instead.
  const networks = useQuery({
    queryKey: ['networks'],
    queryFn: getNetworks,
    staleTime: 5 * 60_000,
  });
  // Unexpected deposits are money sitting in the wrong place. A count here is
  // the only passive signal a merchant gets that something needs attention —
  // otherwise the page is only found by someone already looking for it.
  const unexpected = useQuery({
    queryKey: ['unexpected-deposits'],
    queryFn: listUnexpectedDeposits,
    retry: false,
    staleTime: 60_000,
  });

  // `detected` = seen but not yet dealt with; `failed` = recovery was attempted
  // and did not work. Both need a human. The in-flight states (sweeping,
  // converting) and the finished ones do not, so badging them would train the
  // merchant to ignore the badge.
  const needsAttention =
    unexpected.data?.filter((d) => d.status === 'detected' || d.status === 'failed').length ?? 0;

  const showGetStarted = onboarding.data && !onboarding.data.complete;
  const sections: NavGroup[] = showGetStarted ? [SETUP_GROUP, ...NAV_GROUPS] : NAV_GROUPS;

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-30 bg-slate-950/70 backdrop-blur-sm lg:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[17rem] flex-col border-r border-[var(--line-soft)] bg-[var(--ground)] transition-[transform,visibility] duration-[var(--dur-pop)] ease-[var(--ease-out)] lg:visible lg:static lg:z-10 lg:translate-x-0 lg:bg-transparent ${
          open ? 'visible translate-x-0' : 'invisible -translate-x-full'
        }`}
        aria-label="Main"
      >
        {/* The flag, on the same 4rem line as the topbar beside it so the two
            read as one masthead rather than as two panels that happen to
            align. */}
        <div className="flex h-16 shrink-0 items-center justify-between gap-2 px-4">
          <BrandMark size="sm" subtitle="Merchant" />
          <button
            type="button"
            className="-mr-1 grid h-9 w-9 place-items-center rounded-lg text-slate-500 transition-colors duration-[var(--dur-press)] hover:bg-[var(--hover)] hover:text-slate-900 lg:hidden dark:text-slate-400 dark:hover:text-slate-100"
            onClick={onClose}
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          {sections.map((group, gi) => (
            <div key={group.heading} className={gi === 0 ? '' : 'mt-4'}>
              <p className="runhead px-3 pb-1.5">{group.heading}</p>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <NavItemLink
                    key={item.to}
                    item={item}
                    onClose={onClose}
                    highlight={group.highlight}
                    badge={
                      item.to === '/unexpected-deposits' && needsAttention > 0
                        ? needsAttention
                        : undefined
                    }
                  />
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* The colophon: what this gateway can actually settle, read from
            /networks rather than written into the page. Emerald is health here,
            and the WORD "live" carries the meaning; the dot is shape, not the
            message. */}
        <div className="shrink-0 px-3 pb-4">
          <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] px-3.5 py-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="runhead">Settling on</h2>
              <span className="inline-flex shrink-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-600 dark:text-emerald-400">
                <span
                  className="st-dot h-1.5 w-1.5 rounded-full bg-current"
                  aria-hidden
                />
                Live
              </span>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              {(networks.data ?? ['BEP20']).join(' · ')}
            </p>
          </div>
        </div>
      </aside>
    </>
  );
}

/**
 * One entry in the rail.
 *
 * The lit rail in the margin is drawn with `scaleY` from the centre — transform
 * only, 120ms — so it DRAWS rather than resizes, and it is keyed to the ROUTE
 * changing rather than to this component mounting, which is what the
 * data-driven motion law asks for.
 */
function NavItemLink({
  item,
  onClose,
  badge,
  highlight = false,
}: {
  item: NavItem;
  onClose: () => void;
  badge?: number;
  highlight?: boolean;
}) {
  const { to, label, icon: Icon, end } = item;
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClose}
      className={({ isActive }) =>
        `nav-item group ${isActive ? 'nav-item-on' : ''} ${
          !isActive && highlight ? 'text-brand-600 dark:text-brand-400' : ''
        }`
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={`rail-brand absolute inset-y-1.5 -left-3 w-[3px] origin-center rounded-r-full transition-transform duration-[var(--dur-press)] ease-[var(--ease-out)] ${
              isActive ? 'scale-y-100' : 'scale-y-0'
            }`}
            aria-hidden
          />
          <Icon
            size={16}
            className={`shrink-0 transition-colors ${
              isActive
                ? 'text-brand-600 dark:text-brand-400'
                : highlight
                  ? 'text-brand-600 dark:text-brand-400'
                  : 'text-slate-400 group-hover:text-slate-500 dark:group-hover:text-slate-300'
            }`}
            aria-hidden
          />
          <span className="truncate">{label}</span>
          {badge !== undefined && (
            // Ranged right on tabular figures, like every other count in the
            // product. Amber says "waiting on someone"; the label it sits beside
            // carries the meaning, and the screen-reader text spells it out.
            <span className="num ml-auto shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-amber-600 dark:text-amber-400">
              {badge}
              <span className="sr-only"> needing attention</span>
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}
