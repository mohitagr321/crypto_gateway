import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import BrandMark from './BrandMark';
import {
  Rocket,
  Link2,
  FileText,
  Repeat,
  Inbox,
  LayoutDashboard,
  PlusCircle,
  ReceiptText,
  Wallet,
  KeyRound,
  Settings as SettingsIcon,
  Webhook,
  Percent,
  FileBarChart,
  BookOpen,
  X,
} from 'lucide-react';
import { getNetworks, getOnboarding, listUnexpectedDeposits } from '@/lib/api';

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Exact-match only. Needed where one path prefixes another. */
  end?: boolean;
}

interface NavGroup {
  heading: string;
  items: NavItem[];
  /**
   * A group whose items are an invitation rather than a destination — set in
   * brand ink, because brand means "something you can act on". Used only by the
   * transient Setup group.
   */
  highlight?: boolean;
}

/**
 * Navigation, GROUPED.
 *
 * It used to be fourteen items in one flat list, which is past the point where
 * anyone scans — a merchant hunting "Webhook logs" had to read every label.
 * The groups follow the job being done, not the API's shape:
 *
 *   Payments  — money coming in, and the things that ask for it
 *   Money     — money going out, and what it costs
 *   Developer — the integration surface
 *   Account   — settings and keys
 *
 * Order within a group is by expected frequency of use, not alphabetically.
 */
const GROUPS: NavGroup[] = [
  {
    heading: 'Payments',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { to: '/payments/new', label: 'Create payment', icon: PlusCircle },
      { to: '/payments', label: 'Payments', icon: ReceiptText, end: true },
      { to: '/payment-links', label: 'Payment links', icon: Link2 },
    ],
  },
  {
    heading: 'Billing',
    items: [
      { to: '/invoices', label: 'Invoices', icon: FileText },
      { to: '/subscriptions', label: 'Subscriptions', icon: Repeat },
    ],
  },
  {
    heading: 'Money',
    items: [
      { to: '/payouts', label: 'Payouts', icon: Wallet },
      { to: '/unexpected-deposits', label: 'Unexpected deposits', icon: Inbox },
      { to: '/reports', label: 'Reports', icon: FileBarChart },
      { to: '/commission', label: 'Commission', icon: Percent },
    ],
  },
  {
    heading: 'Developer',
    items: [
      { to: '/api-keys', label: 'API keys', icon: KeyRound },
      { to: '/webhook-logs', label: 'Webhook logs', icon: Webhook },
      { to: '/docs', label: 'API docs', icon: BookOpen },
    ],
  },
  {
    heading: 'Account',
    items: [{ to: '/settings', label: 'Settings', icon: SettingsIcon }],
  },
];

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

/**
 * The app's SPINE, set as a broadsheet index.
 *
 * It used to be a white panel of fourteen rounded pills floating on the page.
 * Now it is a column of the same sheet the content is printed on — one vertical
 * hairline divides them, each section is opened by a horizontal rule and named
 * by a running head, and destinations are ruled entries rather than boxes. That
 * is the same treatment the public masthead and the ledger already use, which is
 * the whole point of this phase: no visible seam between the site and the
 * product.
 *
 * WORKING DENSITY, NOT EDITORIAL THEATRE. A merchant opens this dozens of times
 * a day, so nothing here has a hero, nothing enters on mount, and the rules buy
 * their whitespace at 12px, not 48px.
 *
 * THE ACTIVE ITEM IS MARKED THREE WAYS — a brand rail in the margin, ink type
 * where the rest of the list is secondary, and `aria-current="page"`, which
 * NavLink sets for us. Brand is correct on that rail: this is navigation, a
 * thing you act on, not a state. Colour is never the only carrier.
 */
export default function Sidebar({ open, onClose }: SidebarProps) {
  // "Get started" appears only while setup is incomplete — once a merchant is
  // configured, a permanent link to a page of ticked boxes is just clutter.
  const onboarding = useQuery({
    queryKey: ['onboarding'],
    queryFn: getOnboarding,
    retry: false,
  });
  // The footer used to hardcode "BEP20 · BSC", which was wrong the moment TRC20
  // shipped. Read the gateway's real capability instead.
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
  // converting) and the finished ones (swept, converted) do not, so badging them
  // would train the merchant to ignore the badge.
  const needsAttention =
    unexpected.data?.filter((d) => d.status === 'detected' || d.status === 'failed')
      .length ?? 0;

  const showGetStarted = onboarding.data && !onboarding.data.complete;

  // Onboarding is a SECTION of the index while it exists, not a floating pill
  // pinned above one. It disappears entirely once setup is complete, taking its
  // rule and running head with it.
  const sections: NavGroup[] = showGetStarted
    ? [
        {
          heading: 'Setup',
          highlight: true,
          items: [{ to: '/onboarding', label: 'Get started', icon: Rocket }],
        },
        ...GROUPS,
      ]
    : GROUPS;

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
        not hidden: the closed mobile drawer kept all fourteen links in the tab
        order, so a keyboard user tabbed through an invisible nav before reaching
        the page. `invisible` fixes that, and transitioning it alongside the
        transform is what keeps the slide-out visible — a discrete property flips
        at the START going visible and at the END going hidden, which is exactly
        the behaviour a drawer wants. `lg:visible` wins on desktop, where the
        element is static and always in the tab order.

        180ms: a drawer must travel its own width, so the 8px cap in the motion
        law cannot apply to it — the DURATION budget does, and this sits under
        it. It is user-initiated, off-screen-only, and never runs on desktop.
      */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[17rem] flex-col border-r border-slate-200 bg-slate-50 transition-[transform,visibility] duration-[var(--dur-pop)] ease-[var(--ease-out)] lg:visible lg:static lg:translate-x-0 dark:border-slate-800 dark:bg-slate-950 ${
          open ? 'visible translate-x-0' : 'invisible -translate-x-full'
        }`}
        aria-label="Main"
      >
        {/* The flag. Same 4rem height and same closing hairline as the topbar
            beside it, so the rule runs unbroken across the top of the app and
            reads as one masthead rather than two panels that happen to align. */}
        <div className="flex h-16 shrink-0 items-center justify-between gap-2 border-b border-slate-200 px-5 dark:border-slate-800">
          <BrandMark size="sm" subtitle="Merchant Panel" />
          <button
            type="button"
            className="-mr-1 rounded-md p-1 text-slate-500 outline-none transition-colors duration-[var(--dur-press)] hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-brand-500 lg:hidden dark:text-slate-400 dark:hover:text-slate-100"
            onClick={onClose}
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        {/* The index. Entries range to the ends of the column so the hover band
            and the active rail meet the rules, the way a ledger row does. */}
        <nav className="flex-1 overflow-y-auto pb-4">
          {sections.map((group, gi) => (
            <div
              key={group.heading}
              className={gi === 0 ? 'pt-4' : 'rule mt-3 pt-3'}
            >
              <p className="runhead px-5">{group.heading}</p>
              <div className="mt-1.5">
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
            /networks rather than written into the page. Set as one line of ink
            under a running head — the row of tinted chips it replaces was four
            small boxes saying what a sentence says.
            Emerald is health here, and the WORD "live" carries the meaning; the
            dot is shape, not the message. */}
        <div className="rule shrink-0 px-5 py-3.5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="runhead">Settling on</h2>
            <span className="inline-flex shrink-0 items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-emerald-600 dark:text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
              Live
            </span>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-700 dark:text-slate-300">
            {(networks.data ?? ['BEP20']).join(' · ')}
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
 * rather than resizes, and it is keyed to the ROUTE changing rather than to
 * this component mounting, which is what the data-driven law asks for.
 *
 * The hover band is deliberately the same slate-100 the ledger's clickable rows
 * use, full-bleed to the column rules. One hover language across the product.
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
        `group relative flex items-center gap-3 px-5 py-2 text-sm outline-none transition-colors duration-[var(--dur-press)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
          isActive
            ? 'font-medium text-slate-900 dark:text-slate-50'
            : highlight
              ? 'text-brand-700 hover:bg-slate-100 dark:text-brand-300 dark:hover:bg-slate-800'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={`absolute inset-y-0 left-0 w-0.5 origin-center bg-brand-600 transition-transform duration-[var(--dur-press)] ease-[var(--ease-out)] dark:bg-brand-400 ${
              isActive ? 'scale-y-100' : 'scale-y-0'
            }`}
            aria-hidden
          />
          <Icon
            size={16}
            className={`shrink-0 ${
              isActive
                ? 'text-slate-900 dark:text-slate-50'
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
            // ("Unexpected deposits") is the word that carries the meaning, and
            // the screen-reader text below spells it out.
            <span className="num ml-auto shrink-0 text-xs font-medium text-amber-600 dark:text-amber-400">
              {badge}
              <span className="sr-only"> needing attention</span>
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}
