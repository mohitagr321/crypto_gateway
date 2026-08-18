import {
  BookOpen,
  FileBarChart,
  FileText,
  Inbox,
  KeyRound,
  LayoutDashboard,
  Link2,
  Percent,
  PlusCircle,
  ReceiptText,
  Repeat,
  Rocket,
  Settings as SettingsIcon,
  Wallet,
  Webhook,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Exact-match only. Needed where one path prefixes another. */
  end?: boolean;
  /** Short form for the mobile dock, where a label gets ~8 characters. */
  short?: string;
}

export interface NavGroup {
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
 * NAVIGATION, GROUPED — and defined ONCE.
 *
 * It used to live inside Sidebar.tsx, which was fine while the sidebar was the
 * only navigation. It is now read by three surfaces that must never disagree
 * about what this product contains: the desktop rail, the mobile dock's "More"
 * sheet, and the command palette.
 *
 * The groups follow the JOB BEING DONE, not the API's shape:
 *
 *   Payments  — money coming in, and the things that ask for it
 *   Billing   — recurring and itemised demands for it
 *   Money     — money going out, and what it costs
 *   Developer — the integration surface
 *   Account   — settings and keys
 *
 * Order within a group is by expected frequency of use, not alphabetically.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    heading: 'Payments',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, short: 'Home' },
      { to: '/payments/new', label: 'Create payment', icon: PlusCircle, short: 'Create' },
      { to: '/payments', label: 'Payments', icon: ReceiptText, end: true, short: 'Payments' },
      { to: '/payment-links', label: 'Payment links', icon: Link2, short: 'Links' },
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

/** The onboarding entry, prepended while setup is incomplete. */
export const SETUP_GROUP: NavGroup = {
  heading: 'Setup',
  highlight: true,
  items: [{ to: '/onboarding', label: 'Get started', icon: Rocket, short: 'Setup' }],
};

/**
 * THE DOCK'S THREE, chosen by what a merchant does on a PHONE rather than by
 * what the rail happens to list first.
 *
 * Three, not five: the fourth slot is "More", and a dock that tries to carry
 * every destination becomes a worse version of the drawer it was meant to
 * replace. Everything not here is one tap away behind More, which opens the
 * full index — so nothing is unreachable, and the three that are here are the
 * three that never need a second tap.
 */
export const DOCK_ITEMS: NavItem[] = [
  NAV_GROUPS[0].items[0], // Dashboard
  NAV_GROUPS[0].items[2], // Payments
  NAV_GROUPS[0].items[1], // Create payment
];

/** Every destination, flattened — for the palette and the "More" sheet. */
export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);
