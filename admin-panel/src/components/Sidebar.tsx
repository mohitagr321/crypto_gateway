import {
  ArrowLeftRight,
  BarChart3,
  Coins,
  LayoutDashboard,
  Percent,
  Send,
  Users,
  Wallet,
  Webhook,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import PayCrypoMark from '@/components/PayCrypoMark';
import { useAuth } from '@/context/AuthContext';
import type { Role } from '@/types';
import { BRAND_CONSOLE_LABEL, BRAND_NAME } from '@/lib/brand';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Roles allowed to see this item. Omit for all authenticated roles. */
  roles?: Role[];
  /** Exact-match only. Needed where one path prefixes another. */
  end?: boolean;
}

interface NavGroup {
  heading: string;
  items: NavItem[];
}

/**
 * Navigation, GROUPED.
 *
 * It used to be nine items in one flat list, which is already past the point
 * where anyone scans — an operator hunting "Webhook logs" read every label. The
 * groups follow the job being done, not the API's shape:
 *
 *   Overview   what the platform did
 *   Merchants  who is on it, and what they are charged
 *   Money      what moved, out and in
 *   Platform   the machinery that has to keep working
 *
 * Order within a group is by expected frequency of use, not alphabetically.
 * Role filtering is applied per ITEM and a group with nothing left in it is not
 * rendered, so an ops-role operator never sees an empty "Merchants" heading.
 */
const GROUPS: NavGroup[] = [
  {
    heading: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/analytics', label: 'Analytics', icon: BarChart3 },
    ],
  },
  {
    heading: 'Merchants',
    items: [
      { to: '/clients', label: 'Clients', icon: Users },
      { to: '/commissions', label: 'Commissions', icon: Percent, roles: ['super_admin'] },
    ],
  },
  {
    heading: 'Money',
    items: [
      { to: '/transactions', label: 'Transactions', icon: ArrowLeftRight },
      { to: '/payouts', label: 'Payouts', icon: Send },
      { to: '/revenue', label: 'Revenue', icon: Coins },
    ],
  },
  {
    heading: 'Platform',
    items: [
      { to: '/wallets', label: 'Wallet balances', icon: Wallet },
      { to: '/webhook-logs', label: 'Webhook logs', icon: Webhook },
    ],
  },
];

/**
 * THE RAIL.
 *
 * It sits on the CANVAS plane, not the surface plane: no fill, no shadow, one
 * hairline separating it from the page. That is deliberate and it is what makes
 * the depth field read as continuous behind the whole app — a filled rail would
 * cut a rectangle out of the atmosphere and the illusion would end at its edge.
 * The outgoing version painted slate-50 / slate-950 straight onto
 * the column, which is exactly that rectangle; the fill now survives only below
 * `lg`, where the rail is a DRAWER over the page and needs to be opaque so the
 * route behind it does not read through.
 *
 * WORKING DENSITY, NOT THEATRE. An operator opens this dozens of times a day, so
 * nothing here has a hero, nothing enters on mount, and the groups buy their
 * whitespace at 12px rather than 48.
 *
 * THE ACTIVE ITEM IS MARKED THREE WAYS — a lit rail in the margin, a brand wash
 * behind the row, and `aria-current="page"`, which NavLink sets for us. Colour
 * is never the only carrier.
 *
 * ON MOBILE it is a drawer, and VISIBILITY IS PART OF THE DRAWER rather than
 * just its transform. Off-screen is not hidden: the closed drawer kept all nine
 * links in the tab order, so a keyboard operator tabbed through an invisible nav
 * before reaching the page. `invisible` fixes that, and transitioning it
 * alongside the transform is what keeps the slide-out visible — a discrete
 * property flips at the START going visible and at the END going hidden, which
 * is exactly the behaviour a drawer wants.
 *
 * 180ms: a drawer must travel its own width, so the 8px cap in the motion law
 * cannot apply to it — the DURATION budget does, and this sits under it. It is
 * user-initiated, off-screen-only, and never runs on desktop.
 *
 * SAFE AREAS. The drawer is `fixed inset-y-0`, so on a notched phone it spans
 * the notch and the home indicator. It pays the top, bottom and left insets
 * itself; without the bottom one the last nav item sits in the home-indicator
 * strip, which is the classic drawer bug and is invisible until someone with a
 * modern iPhone tries to tap "Webhook logs".
 */
export default function Sidebar({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { role } = useAuth();

  const sections = GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.roles || (role && item.roles.includes(role))),
  })).filter((group) => group.items.length > 0);

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
        className={`fixed inset-y-0 left-0 z-40 flex w-[17rem] flex-col border-r border-[var(--line-soft)] bg-[var(--ground)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pt-[env(safe-area-inset-top)] transition-[transform,visibility] duration-[var(--dur-pop)] ease-[var(--ease-out)] lg:visible lg:static lg:z-10 lg:translate-x-0 lg:bg-transparent ${
          open ? 'visible translate-x-0' : 'invisible -translate-x-full'
        }`}
        aria-label="Main"
      >
        {/* The flag, on the same 4rem line as the topbar beside it so the two
            read as one masthead rather than as two panels that happen to align.

            THE TILE IS A LIGHT SOURCE, NOT AN ELEVATED OBJECT, which is why it
            carries a coloured bloom rather than a grey shadow. The z-plane law
            says nothing outside the floating plane casts — but a bloom is not a
            cast, it is the light the mark itself throws, and it is the same
            statement `.rail-brand` makes further down this file. Brand -> accent
            is the sanctioned travel for it, and the gradient and the ring are
            copied from the merchant panel's BrandMark rather than reinvented:
            the two apps must show one mark.

            Asset-neutral glyph: the ₮ tile this replaced predated ERC20, Bitcoin
            and the native coins, and an operator reconciling a BTC payout should
            not be told this is a USDT gateway. */}
        <div className="flex h-16 shrink-0 items-center justify-between gap-2 px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-600 text-white shadow-[0_0_0_1px_oklch(var(--b-400)/0.35),0_6px_18px_-8px_oklch(var(--b-500)/0.85)]"
              aria-hidden
            >
              <PayCrypoMark size={17} />
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-[15px] font-semibold text-slate-900 dark:text-slate-50">
                {BRAND_NAME}
              </span>
              <span className="block truncate text-[11px] text-slate-500 dark:text-slate-400">
                {BRAND_CONSOLE_LABEL}
              </span>
            </span>
          </div>
          {/* 44px, not the 26px a `p-1` around an 18px glyph computed to. This
              control only exists on a touch device, so there is no pointer case
              to relax it for. */}
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-500 transition-colors duration-[var(--dur-press)] hover:bg-[var(--hover)] hover:text-slate-900 lg:hidden dark:text-slate-400 dark:hover:text-slate-100"
            aria-label="Close menu"
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        {/* The index. `px-3` on the nav rather than full-bleed rows: the active
            wash is now a rounded lozenge behind the row, so it needs a margin to
            be a shape at all — which is the whole difference between "a lit
            object marking where you are" and "a tinted stripe". */}
        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          {sections.map((group, gi) => (
            <div key={group.heading} className={gi === 0 ? '' : 'mt-4'}>
              <p className="runhead px-3 pb-1.5">{group.heading}</p>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <NavItemLink key={item.to} item={item} onClose={onClose} />
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* The colophon. Which role you are signed in as decides what half this
            console will let you do, so it is a standing fact about the session
            rather than a decoration. It sits in a `--surface-2` well rather than
            over a `.rule`, for the reason the whole redesign exists: a rule
            printed on the canvas gives the eye nothing to land on, and this is
            the one piece of standing state on the rail. */}
        <div className="shrink-0 px-3 pb-4">
          <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] px-3.5 py-3">
            <h2 className="runhead">Signed in as</h2>
            <p className="mt-1.5 text-xs capitalize leading-relaxed text-slate-700 dark:text-slate-300">
              {role?.replace('_', ' ') ?? 'Unknown role'}
            </p>
            {role === 'ops' && (
              <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                Read-only for client and commission changes
              </p>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}

/**
 * One entry in the rail.
 *
 * `.nav-item` / `.nav-item-on` rather than a hand-written stack of utilities.
 * That class has existed in index.css the whole time and was dead CSS in both
 * panels, which is also how this row's touch target ended up at ~36px: the
 * class carries `min-height: 38px` and nothing was applying it.
 *
 * 44px BELOW `lg`, 38px FROM IT. The drawer is the only place this row is ever
 * touched — above `lg` the rail is a static column beside a pointer — so the
 * thumb floor is paid exactly where a thumb exists, and on desktop the row is
 * byte-identical to the merchant panel's. This is the same relaxation `.btn`
 * and `.input` make, at the breakpoint where the drawer stops being a drawer
 * rather than at `sm`.
 *
 * The lit rail in the margin is drawn with `scaleY` from the centre — transform
 * only, 120ms — so it DRAWS rather than resizes, and it is keyed to the ROUTE
 * changing rather than to this component mounting, which is what the data-driven
 * motion law asks for. `-left-3` reaches back through the nav's own `px-3` so
 * the rail lands on the column edge while the lozenge keeps its margin.
 */
function NavItemLink({ item, onClose }: { item: NavItem; onClose: () => void }) {
  const { to, label, icon: Icon, end } = item;
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClose}
      className={({ isActive }) =>
        `nav-item group min-h-11 lg:min-h-[38px] ${isActive ? 'nav-item-on' : ''}`
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
                : 'text-slate-400 group-hover:text-slate-500 dark:group-hover:text-slate-300'
            }`}
            aria-hidden
          />
          <span className="truncate">{label}</span>
        </>
      )}
    </NavLink>
  );
}
