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
import { classNames } from '@/lib/format';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Roles allowed to see this item. Omit for all authenticated roles. */
  roles?: Role[];
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/clients', label: 'Clients', icon: Users },
  { to: '/transactions', label: 'Transactions', icon: ArrowLeftRight },
  { to: '/payouts', label: 'Payouts', icon: Send },
  { to: '/revenue', label: 'Revenue', icon: Coins },
  { to: '/commissions', label: 'Commissions', icon: Percent, roles: ['super_admin'] },
  { to: '/webhook-logs', label: 'Webhook Logs', icon: Webhook },
  { to: '/wallets', label: 'Wallet Balances', icon: Wallet },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
];

export default function Sidebar({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { role } = useAuth();
  const items = NAV.filter((item) => !item.roles || (role && item.roles.includes(role)));

  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={onClose} aria-hidden />
      )}

      <aside
        className={classNames(
          'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-gray-200 bg-white transition-transform dark:border-gray-800 dark:bg-gray-900 lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="flex h-16 items-center justify-between border-b border-gray-200 px-5 dark:border-gray-800">
          <div className="flex items-center gap-2">
            {/* Asset-neutral mark. The ₮ tile and the "USDT · BEP20" subtitle
                both predate ERC20, Bitcoin and the native coins — an operator
                reconciling a BTC payout should not be told this is a USDT
                gateway. Name and mark now come from lib/brand.ts and
                PayCrypoMark, so this screen cannot drift from the merchant
                panel the way the hardcoded string did. */}
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-white">
              <PayCrypoMark size={17} />
            </div>
            <div className="leading-tight">
              <p className="text-sm font-semibold">{BRAND_NAME}</p>
              <p className="text-[11px] text-gray-400">{BRAND_CONSOLE_LABEL}</p>
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost h-8 w-8 !p-0 lg:hidden" aria-label="Close menu">
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {items.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={onClose}
              className={({ isActive }) =>
                classNames(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition',
                  isActive
                    ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300'
                    : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'
                )
              }
            >
              <Icon className="h-[18px] w-[18px]" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-gray-200 p-4 text-[11px] text-gray-400 dark:border-gray-800">
          Role: <span className="font-medium capitalize">{role?.replace('_', ' ') ?? '—'}</span>
        </div>
      </aside>
    </>
  );
}
