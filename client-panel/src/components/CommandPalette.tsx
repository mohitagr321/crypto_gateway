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
 *
 * ---------------------------------------------------------------------------
 * IT OPENS INSTANTLY, AND THAT IS A DESIGN DECISION, NOT AN OMISSION.
 *
 * There is no entrance transition on the overlay, the panel or the rows, and
 * none should be added. A keyboard-initiated action is never animated: the user
 * pressed ⌘K because they already know what they want, and by the time a 180ms
 * scale-in has settled they have typed three characters into a panel that was
 * still moving. The same rule governs the selection cursor — arrowing down
 * repaints the active row with no transition, because a cursor that eases is a
 * cursor that lags behind the key that moved it.
 *
 * IT IS A FLOATING PLANE, AND THE ONLY THING THAT CHANGED IS THE MATERIAL.
 *
 * Under the z-plane law the palette lives on plane 3 with the topbar, the dock
 * and every popover — the one plane that gets `.glass` and the one plane that
 * casts. It used to be an opaque white card with a hairline, which is plane 2's
 * material: correct for a stat tile, wrong for a sheet suspended over a page
 * the user has not left. Glass says "this is above, and what you were reading
 * is still there underneath", which is exactly true of a palette.
 *
 * THE SCRIM NO LONGER BLURS. It carried `backdrop-blur-sm` while the panel now
 * carries a real 16px frost, which stacked two full-viewport backdrop filters
 * for one effect — and backdrop-filter repaints its whole backdrop, so the
 * cheapest place to spend it is once. The scrim darkens; the panel frosts.
 *
 * SET AS A RULED INDEX. Groups are opened by a hairline and named by a running
 * head, the selected row is marked by the same brand rail the sidebar uses for
 * the page you are on, and the empty state is a sentence ranged left on a
 * measure rather than a centred apology. One language across the product.
 *
 * IT SURVIVES A SHORT VIEWPORT. `12dvh` and not `12vh`: on mobile Safari `vh`
 * is measured against the viewport WITH the URL bar collapsed, so it is taller
 * than what the user can see and pushes the panel down by more than it claims.
 * The overlay scrolls, and the list is capped against `dvh` as well as against
 * a fixed height — in a 360px-tall landscape viewport the old fixed
 * `max-h-[22rem]` list plus the input simply ran off the bottom with no way to
 * reach it.
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

const LIST_ID = 'command-palette-list';
const optionId = (i: number) => `command-palette-option-${i}`;

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

  /**
   * The flat result list, cut into contiguous runs by group.
   *
   * The headings used to be emitted by mutating a `lastGroup` variable during
   * render, which works only while nothing re-orders the list and cannot be
   * expressed as a valid listbox. Grouping explicitly gives each run a real
   * `role="group"` and keeps the ORIGINAL flat index on every row, so the
   * keyboard maths, the selection cursor and `aria-activedescendant` all keep
   * counting in the same coordinate space.
   */
  const groups = useMemo(() => {
    const out: { name: string; items: { cmd: Command; index: number }[] }[] = [];
    results.forEach((cmd, index) => {
      const last = out[out.length - 1];
      if (last && last.name === cmd.group) last.items.push({ cmd, index });
      else out.push({ name: cmd.group, items: [{ cmd, index }] });
    });
    return out;
  }, [results]);

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[8dvh] sm:pt-[12dvh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      {/* `fixed`, not `absolute`: the wrapper scrolls now, and a scrim that
          scrolls with it leaves the bottom of a long list sitting on the bare
          page. */}
      <div className="fixed inset-0 bg-slate-950/55" onClick={onClose} aria-hidden />

      {/* Plane 3: glass and a cast. The radius has to clear blur/2 — a 16px
          frost inside a 12px corner chews the corners — which is why this is
          `rounded-2xl` (18px) and not the `rounded-lg` it was. */}
      <div className="glass relative w-full max-w-lg overflow-hidden rounded-2xl shadow-float">
        <div className="flex items-center gap-3 border-b border-[var(--line)] px-4">
          <Search size={17} className="shrink-0 text-slate-400" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search pages and actions…"
            aria-label="Search pages and actions"
            role="combobox"
            aria-expanded
            aria-controls={LIST_ID}
            aria-autocomplete="list"
            aria-activedescendant={results[active] ? optionId(active) : undefined}
            autoComplete="off"
            spellCheck={false}
            /* 16px BELOW `sm`, and this is functional rather than typographic —
               the same rule `.input` enforces product-wide, spelled out here
               because this field is hand-rolled. iOS Safari zooms the viewport
               whenever a focused input is under 16px and never zooms back out,
               so a merchant who taps ⌘K's field on a phone is left pinching
               their way out of the page they were reading. */
            className="w-full min-w-0 bg-transparent py-4 text-base text-slate-900 outline-none placeholder:text-slate-400 sm:text-sm dark:text-slate-100"
          />
          {/* slate-500, not slate-400: this is type, and 400 is the step this
              ramp keeps for borders and decorative marks — it measures 2.74:1
              on the light page. Hidden below `sm` regardless, since a phone has
              no Escape key to hint at. */}
          <kbd className="hidden shrink-0 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500 sm:block dark:text-slate-400">
            esc
          </kbd>
        </div>

        <div
          ref={listRef}
          id={LIST_ID}
          role="listbox"
          aria-label="Pages and actions"
          className="max-h-[min(22rem,52dvh)] overflow-y-auto py-1.5"
        >
          {results.length === 0 ? (
            // Ranged left on a measure, with a running head — the same treatment
            // the ledger's empty state uses, rather than a centred line of grey.
            <div className="px-4 py-8" role="presentation">
              <span className="runhead">No match</span>
              <p className="measure mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                Nothing matches “{query}”. Destinations also answer to what they
                do — try “settlement”, “retries”, “secret” or “csv”.
              </p>
            </div>
          ) : (
            groups.map((group, gi) => (
              <div
                key={group.name}
                role="group"
                aria-label={group.name}
                className={gi > 0 ? 'rule mt-1.5 pt-1.5' : ''}
              >
                <p className="runhead px-4 pb-1 pt-1.5" aria-hidden>
                  {group.name}
                </p>
                {group.items.map(({ cmd, index }) => {
                  const isActive = index === active;
                  return (
                    <button
                      key={cmd.id}
                      type="button"
                      id={optionId(index)}
                      role="option"
                      aria-selected={isActive}
                      data-index={index}
                      onClick={() => run(cmd)}
                      onMouseEnter={() => setActive(index)}
                      // NO transition. The cursor must land the instant the key
                      // is pressed — see the note at the top of this file.
                      //
                      // The band is a brand wash rather than a slate one, and
                      // brand is right: this row is the ACTION Enter will take,
                      // which is the one thing brand means. It is the same
                      // tint `.ledger-row-click` uses for the row under the
                      // pointer, so a marked row reads the same everywhere.
                      // 44px below `sm` — this list is thumbed as often as it
                      // is arrowed.
                      className={`relative flex min-h-[44px] w-full items-center gap-3 px-4 py-2.5 text-left text-sm outline-none sm:min-h-0 ${
                        isActive
                          ? 'bg-brand-500/10 text-slate-900 dark:text-slate-50'
                          : 'text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      {/* The same brand rail the sidebar draws on the page you
                          are standing on. Here it marks the row Enter will run,
                          which is likewise a thing you act on, not a state. */}
                      <span
                        className={`absolute inset-y-0 left-0 w-0.5 bg-brand-600 dark:bg-brand-400 ${
                          isActive ? 'opacity-100' : 'opacity-0'
                        }`}
                        aria-hidden
                      />
                      <cmd.icon
                        size={16}
                        aria-hidden
                        className={`shrink-0 ${
                          isActive ? 'text-slate-500 dark:text-slate-300' : 'text-slate-400'
                        }`}
                      />
                      <span className="truncate">{cmd.label}</span>
                      {isActive && (
                        <CornerDownLeft
                          size={13}
                          aria-hidden
                          className="ml-auto shrink-0 text-slate-400"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            ))
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
