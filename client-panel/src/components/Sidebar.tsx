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
const GROUPS: { heading: string; items: NavItem[] }[] = [
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

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/60 backdrop-blur-sm lg:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[17rem] flex-col border-r border-slate-200 bg-white transition-transform duration-300 ease-out dark:border-slate-800 dark:bg-slate-900 lg:static lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        aria-label="Main"
      >
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-slate-200 px-5 dark:border-slate-800">
          <BrandMark size="sm" subtitle="Merchant Panel" />
          <button
            type="button"
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 lg:hidden dark:hover:bg-slate-800"
            onClick={onClose}
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {showGetStarted && (
            <div className="mb-4">
              <NavItemLink
                item={{ to: '/onboarding', label: 'Get started', icon: Rocket }}
                onClose={onClose}
                highlight
              />
            </div>
          )}

          {GROUPS.map((group, gi) => (
            <div key={group.heading} className={gi > 0 ? 'mt-5' : ''}>
              <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400 dark:text-slate-500">
                {group.heading}
              </p>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <NavItemLink
                    key={item.to}
                    item={item}
                    onClose={onClose}
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

        <div className="shrink-0 border-t border-slate-200 px-4 py-3 dark:border-slate-800">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">
            Settling on
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {(networks.data ?? ['BEP20']).map((n) => (
              <span
                key={n}
                className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              >
                <span className="h-1 w-1 rounded-full bg-emerald-500" />
                {n}
              </span>
            ))}
          </div>
        </div>
      </aside>
    </>
  );
}

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
        `group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
          isActive
            ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300'
            : highlight
              ? 'text-brand-700 ring-1 ring-inset ring-brand-200 hover:bg-brand-50 dark:text-brand-300 dark:ring-brand-500/30 dark:hover:bg-brand-500/10'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100'
        }`
      }
    >
      {({ isActive }) => (
        <>
          {/* Active rail. A left marker survives at a glance in a way a
              background tint alone does not, especially in dark mode. */}
          <span
            className={`absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-brand-600 transition-opacity dark:bg-brand-400 ${
              isActive ? 'opacity-100' : 'opacity-0'
            }`}
            aria-hidden
          />
          <Icon size={17} className="shrink-0" />
          <span className="truncate">{label}</span>
          {badge !== undefined && (
            <span className="ml-auto inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
              {badge}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}
