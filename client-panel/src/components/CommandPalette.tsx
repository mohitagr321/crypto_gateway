import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen,
  CornerDownLeft,
  FileBarChart,
  FileText,
  Inbox,
  KeyRound,
  LayoutDashboard,
  Link2,
  LogOut,
  Moon,
  Percent,
  PlusCircle,
  ReceiptText,
  Repeat,
  Search,
  Settings as SettingsIcon,
  Sun,
  Wallet,
  Webhook,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';

/**
 * ⌘K / Ctrl-K command palette.
 *
 * A merchant reconciling payments moves between Payments, Payouts and Webhook
 * logs constantly; making that a keystroke instead of a sidebar hunt is the
 * single biggest speed win available in a dashboard this size. It also gives
 * keyboard-only users a way to reach every destination without tabbing through
 * the whole nav, which is a real accessibility gain rather than a flourish.
 *
 * Deliberately dependency-free: a palette is a filtered list and a keydown
 * handler, and the entry bundle is not worth a library for that.
 */

interface Command {
  id: string;
  label: string;
  icon: LucideIcon;
  group: 'Go to' | 'Actions';
  /** Extra words that should match, beyond the label. */
  keywords?: string;
  perform: (ctx: CommandContext) => void;
}

interface CommandContext {
  navigate: (to: string) => void;
  logout: () => void;
  toggleTheme: () => void;
}

const NAV: { to: string; label: string; icon: LucideIcon; keywords?: string }[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, keywords: 'home overview stats' },
  { to: '/payments', label: 'Payments', icon: ReceiptText, keywords: 'transactions orders' },
  { to: '/payment-links', label: 'Payment links', icon: Link2, keywords: 'checkout hosted url' },
  { to: '/invoices', label: 'Invoices', icon: FileText, keywords: 'bill' },
  { to: '/subscriptions', label: 'Subscriptions', icon: Repeat, keywords: 'recurring billing' },
  { to: '/payouts', label: 'Payouts', icon: Wallet, keywords: 'settlement withdraw' },
  { to: '/unexpected-deposits', label: 'Unexpected deposits', icon: Inbox, keywords: 'wrong asset recover stuck' },
  { to: '/reports', label: 'Reports', icon: FileBarChart, keywords: 'export csv accounting' },
  { to: '/commission', label: 'Commission', icon: Percent, keywords: 'fees pricing rate' },
  { to: '/api-keys', label: 'API keys', icon: KeyRound, keywords: 'credentials secret token hmac' },
  { to: '/webhook-logs', label: 'Webhook logs', icon: Webhook, keywords: 'deliveries retries signature' },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, keywords: 'wallet payout address password ip allowlist' },
  { to: '/docs', label: 'API docs', icon: BookOpen, keywords: 'reference integration' },
];

function buildCommands(isDark: boolean): Command[] {
  return [
    {
      id: 'new-payment',
      label: 'Create a payment',
      icon: PlusCircle,
      group: 'Actions',
      keywords: 'new charge invoice request',
      perform: ({ navigate }) => navigate('/payments/new'),
    },
    {
      id: 'toggle-theme',
      label: isDark ? 'Switch to light theme' : 'Switch to dark theme',
      icon: isDark ? Sun : Moon,
      group: 'Actions',
      keywords: 'dark light appearance mode',
      perform: ({ toggleTheme }) => toggleTheme(),
    },
    {
      id: 'logout',
      label: 'Log out',
      icon: LogOut,
      group: 'Actions',
      keywords: 'sign out exit',
      perform: ({ logout }) => logout(),
    },
    ...NAV.map<Command>((n) => ({
      id: `go-${n.to}`,
      label: n.label,
      icon: n.icon,
      group: 'Go to',
      keywords: n.keywords,
      perform: ({ navigate }) => navigate(n.to),
    })),
  ];
}

export default function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const { logout } = useAuth();
  const { theme, toggle: toggleTheme } = useTheme();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo(() => buildCommands(theme === 'dark'), [theme]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) =>
      `${c.label} ${c.keywords ?? ''}`.toLowerCase().includes(q),
    );
  }, [commands, query]);

  // Reset each time it opens, so it never reopens showing the last search.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      // Focus after paint, otherwise the element is not yet in the document.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setActive(0), [query]);

  const run = useCallback(
    (cmd: Command) => {
      onClose();
      cmd.perform({ navigate, logout, toggleTheme });
    },
    [navigate, logout, toggleTheme, onClose],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % Math.max(results.length, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + results.length) % Math.max(results.length, 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = results[active];
      if (cmd) run(cmd);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  let lastGroup = '';

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />

      <div className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-float dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 dark:border-slate-800">
          <Search size={17} className="shrink-0 text-slate-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search pages and actions…"
            aria-label="Search pages and actions"
            className="w-full bg-transparent py-4 text-sm text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100"
          />
          <kbd className="hidden shrink-0 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-400 sm:block dark:border-slate-700">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[22rem] overflow-y-auto p-2">
          {results.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-slate-400">
              Nothing matches “{query}”.
            </p>
          ) : (
            results.map((cmd, i) => {
              const showHeading = cmd.group !== lastGroup;
              lastGroup = cmd.group;
              return (
                <div key={cmd.id}>
                  {showHeading && (
                    <p className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                      {cmd.group}
                    </p>
                  )}
                  <button
                    type="button"
                    data-index={i}
                    onClick={() => run(cmd)}
                    onMouseEnter={() => setActive(i)}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition ${
                      i === active
                        ? 'bg-brand-50 text-brand-800 dark:bg-brand-500/10 dark:text-brand-200'
                        : 'text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <cmd.icon size={16} className="shrink-0 text-slate-400" />
                    <span className="truncate">{cmd.label}</span>
                    {i === active && (
                      <CornerDownLeft size={13} className="ml-auto shrink-0 text-slate-400" />
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Global ⌘K / Ctrl-K binding. Lives here rather than in Layout so the shortcut
 * and the component that answers it stay together.
 *
 * Ignores the shortcut while the user is typing in a field — a merchant writing
 * a wallet address should not lose it to a palette, and ⌘K is a browser-native
 * shortcut in some inputs.
 */
export function useCommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey)) return;
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable);
      if (typing) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return { open, setOpen };
}
