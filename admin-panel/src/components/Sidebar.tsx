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
 * The console's SPINE, set as a broadsheet index.
 *
 * It used to be a white panel of nine rounded pills floating on the page. Now it
 * is a column of the same sheet the content is printed on — one vertical
 * hairline divides them, each section is opened by a horizontal rule and named
 * by a running head, and destinations are ruled entries rather than boxes. That
 * is the treatment the merchant panel's spine already uses, which is the whole
 * point of this phase: no visible seam between the two windows of one product.
 *
 * WORKING DENSITY, NOT EDITORIAL THEATRE. An operator opens this dozens of times
 * a day, so nothing here has a hero, nothing enters on mount, and the rules buy
 * their whitespace at 12px, not 48px.
 *
 * THE ACTIVE ITEM IS MARKED THREE WAYS — a brand rail in the margin, ink type
 * where the rest of the list is secondary, and `aria-current="page"`, which
 * NavLink sets for us. Brand is correct on that rail: this is navigation, a
 * thing you act on, not a state. Colour is never the only carrier.
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
          className="fixed inset-0 z-30 bg-slate-950/60 backdrop-blur-sm lg:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}

      {/*
        THE COLUMN RULE. `border-r` is the only thing separating the spine from
        the page — same ground, same paper, one hairline. A panel colour and a
        shadow would say "this is a different surface", which is not true.

        VISIBILITY IS PART OF THE DRAWER, not just its transform. Off-screen is
        not hidden: the closed mobile drawer kept every link in the tab order, so
        a keyboard operator tabbed through an invisible nav before reaching the
        page. Transitioning `visibility` alongside the transform is what keeps
        the slide-out visible — a discrete property flips at the START going
        visible and at the END going hidden, which is exactly what a drawer
        wants. `lg:visible` wins on desktop, where the element is static.

        180ms: a drawer must travel its own width, so the 8px cap in the motion
        law cannot apply to it — the DURATION budget does, and this sits under
        it. It is user-initiated, off-screen-only, and never runs on desktop.
      */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-slate-200 bg-slate-50 transition-[transform,visibility] duration-[var(--dur-pop)] ease-[var(--ease-out)] lg:visible lg:static lg:translate-x-0 dark:border-slate-800 dark:bg-slate-950 ${
          open ? 'visible translate-x-0' : 'invisible -translate-x-full'
        }`}
        aria-label="Main"
      >
        {/* The flag. Same 4rem height and same closing hairline as the topbar
            beside it, so the rule runs unbroken across the top of the app and
            reads as one masthead rather than two panels that happen to align.

            Asset-neutral mark: the ₮ tile and the "USDT · BEP20" subtitle both
            predate ERC20, Bitcoin and the native coins — an operator
            reconciling a BTC payout should not be told this is a USDT gateway. */}
        <div className="flex h-16 shrink-0 items-center justify-between gap-2 border-b border-slate-200 px-5 dark:border-slate-800">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-white">
              <PayCrypoMark size={17} />
            </div>
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-50">
                {BRAND_NAME}
              </p>
              <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                {BRAND_CONSOLE_LABEL}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 rounded-md p-1 text-slate-500 outline-none transition-colors duration-[var(--dur-press)] hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-brand-500 lg:hidden dark:text-slate-400 dark:hover:text-slate-100"
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        {/* The index. Entries range to the ends of the column so the hover band
            and the active rail meet the rules, the way a ledger row does. */}
        <nav className="flex-1 overflow-y-auto pb-4">
          {sections.map((group, gi) => (
            <div key={group.heading} className={gi === 0 ? 'pt-4' : 'rule mt-3 pt-3'}>
              <p className="runhead px-5">{group.heading}</p>
              <div className="mt-1.5">
                {group.items.map((item) => (
                  <NavItemLink key={item.to} item={item} onClose={onClose} />
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* The colophon. Which role you are signed in as decides what half this
            console will let you do, so it is a standing fact about the session
            rather than a decoration — set as one line of ink under a running
            head. */}
        <div className="rule shrink-0 px-5 py-3.5">
          <h2 className="runhead">Signed in as</h2>
          <p className="mt-1.5 text-xs capitalize leading-relaxed text-slate-700 dark:text-slate-300">
            {role?.replace('_', ' ') ?? 'Unknown role'}
            {role === 'ops' && (
              <span className="block text-slate-500 dark:text-slate-400">
                Read-only for client and commission changes
              </span>
            )}
          </p>
        </div>
      </aside>
    </>
  );
}

/**
 * One entry in the index.
 *
 * No pill, no tint, no radius: a destination is a line of type, and the only
 * ornament it gets is the 2px brand rail that appears when you are standing on
 * it. The rail scales from its centre — transform only, 120ms — so it draws
 * rather than resizes, and it is keyed to the ROUTE changing rather than to this
 * component mounting, which is what the data-driven law asks for.
 *
 * The hover band is deliberately the same slate-100 the ledger's clickable rows
 * use, full-bleed to the column rules. One hover language across the product.
 */
function NavItemLink({ item, onClose }: { item: NavItem; onClose: () => void }) {
  const { to, label, icon: Icon, end } = item;
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClose}
      className={({ isActive }) =>
        `group relative flex items-center gap-3 px-5 py-2 text-sm outline-none transition-colors duration-[var(--dur-press)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
          isActive
            ? 'font-medium text-slate-900 dark:text-slate-50'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={`absolute inset-y-0 left-0 w-0.5 origin-center rail-brand transition-transform duration-[var(--dur-press)] ease-[var(--ease-out)] ${
              isActive ? 'scale-y-100' : 'scale-y-0'
            }`}
            aria-hidden
          />
          <Icon
            size={16}
            className={`shrink-0 ${
              isActive
                ? 'text-slate-900 dark:text-slate-50'
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
