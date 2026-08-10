import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { ChevronDown, LogOut, Menu, Search, Settings, UserCircle2 } from 'lucide-react';
import Sidebar from './Sidebar';
import ThemeToggle from './ThemeToggle';
import CommandPalette, { useCommandPalette } from './CommandPalette';
import { useAuth } from '@/context/AuthContext';

/**
 * The app shell.
 *
 * ONE SHEET, DIVIDED BY RULES. The spine, the topbar and the page are all
 * printed on the same ground; a vertical hairline separates the index from the
 * content and a horizontal one runs unbroken across the top of both. The topbar
 * used to be a white panel floating over a grey page, which read as two
 * surfaces stacked — a rule says "the page starts here", and that is the true
 * statement. It also puts the chrome on exactly the ground DataTable resolves
 * `--ledger-ground` to, so a sticky ledger header and the app agree.
 *
 * MOTION: none on mount. The only movement in this file is the mobile drawer
 * (owned by Sidebar) and a chevron rotating on a menu that the user opened.
 * The command palette is mounted and unmounted with no transition at all, by
 * design — see the note in CommandPalette.
 */
export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { user, logout } = useAuth();
  const { open: paletteOpen, setOpen: setPaletteOpen } = useCommandPalette();
  const location = useLocation();

  const displayName =
    (user?.name as string) || (user?.email as string) || 'Merchant';

  // Close the mobile drawer whenever the route changes, otherwise it stays open
  // over the page the user just navigated to.
  useEffect(() => setSidebarOpen(false), [location.pathname]);

  // Escape closes the drawer. It is a modal overlay on mobile — the scrim was
  // the only way out, which is a mouse-only escape hatch on a surface that is
  // mostly used one-handed.
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSidebarOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sidebarOpen]);

  /*
   * THE SHELL IS BOUNDED TO THE VIEWPORT, and it has to be.
   *
   * This was `h-full min-h-screen`, which is a MINIMUM and never a height:
   * `h-full` resolved against a body with no height set and did nothing, so the
   * shell grew to whatever its taller column needed. The spine is the taller
   * column — fourteen links plus the onboarding section — so on a 1280x880
   * laptop the whole app measured 902px and the DOCUMENT scrolled. Two
   * consequences, both measured in a browser rather than assumed:
   *
   *   - `overflow-y-auto` on the nav had never once fired. Nothing bounded its
   *     height, so it had no reason to scroll — the same defect as the ledger's
   *     sticky header before it was given a `maxHeight`.
   *   - the colophon fell off the bottom, and reaching it scrolled the ENTIRE
   *     app, topbar and page and all, against a second scrollbar that existed
   *     only because the nav was long.
   *
   * `h-dvh` gives the shell a real height, so the nav becomes the scroller it
   * was always written to be, the colophon pins to the bottom of the spine, and
   * `main` is the only thing that scrolls the page. Dynamic viewport units
   * rather than `100vh` because on mobile `100vh` is taller than the visible
   * viewport, which would hide the foot of the drawer behind the browser's own
   * chrome.
   */
  return (
    <div className="flex h-dvh bg-slate-50 dark:bg-slate-950">
      {/* The public site has one; the dashboard did not, so a keyboard user
          crossed fourteen nav links to reach the page on every navigation. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-brand-600 focus:px-4 focus:py-2 focus:text-white"
      >
        Skip to content
      </a>

      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-slate-200 bg-slate-50/85 px-4 backdrop-blur-xl lg:px-6 dark:border-slate-800 dark:bg-slate-950/85">
          <button
            type="button"
            className="-ml-1 rounded-md p-2 text-slate-500 outline-none transition-colors duration-[var(--dur-press)] hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-brand-500 lg:hidden dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>

          {/* Palette trigger. Doubles as the discoverability affordance for the
              ⌘K shortcut — a keyboard shortcut nobody is told about does not
              exist. Renders as a full search field on desktop and collapses to
              an icon on mobile, where there is no keyboard to shortcut.

              Set as a RULED FIELD rather than a rounded box: a single hairline
              under the line of type, which goes to ink on hover. That is what a
              field looks like on a printed form, and it is the same gesture the
              rest of the product now uses to say "this is a discrete thing"
              without drawing four borders to do it. */}
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="group flex items-center gap-2 rounded-sm border-b border-slate-300 px-1 py-1.5 text-sm text-slate-500 outline-none transition-colors duration-[var(--dur-press)] hover:border-slate-900 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-brand-500 sm:w-64 dark:border-slate-700 dark:text-slate-400 dark:hover:border-slate-100 dark:hover:text-slate-100"
            aria-label="Search pages and actions"
          >
            <Search size={15} className="shrink-0 text-slate-400" aria-hidden />
            <span className="hidden sm:inline">Search…</span>
            <kbd className="ml-auto hidden text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400 sm:block">
              ⌘K
            </kbd>
          </button>

          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            {/* The vertical hairline that separates the appearance control from
                the account, exactly as the public masthead separates the flag
                from the sections. */}
            <span
              className="hidden h-6 w-px shrink-0 bg-slate-200 sm:block dark:bg-slate-800"
              aria-hidden
            />
            <UserMenu displayName={displayName} onLogout={logout} />
          </div>
        </header>

        <main id="main" className="flex-1 overflow-y-auto p-4 lg:p-6">
          <div className="mx-auto max-w-7xl">
            <Outlet />
          </div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

/**
 * Account menu. Replaces a bare "Logout" button that sat permanently in the
 * topbar — a one-click irreversible action next to navigation is easy to hit by
 * accident, and it wasted the only place an account context belongs.
 *
 * The TRIGGER lost its border: it is a name and a chevron, and a box around it
 * only competed with the ruled field beside it. The PANEL keeps its enclosure,
 * because a popover genuinely is a sheet raised above the page — that is the
 * one case where a border and a shadow are the true statement. Inside it, rows
 * are divided by hairlines rather than by tinted blocks.
 */
function UserMenu({
  displayName,
  onLogout,
}: {
  displayName: string;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-sm px-1 py-1.5 text-sm text-slate-600 outline-none transition-colors duration-[var(--dur-press)] hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-slate-300 dark:hover:text-slate-100"
      >
        <UserCircle2 size={18} className="shrink-0 text-slate-400" aria-hidden />
        <span className="hidden max-w-[10rem] truncate sm:inline">{displayName}</span>
        <ChevronDown
          size={14}
          aria-hidden
          className={`shrink-0 text-slate-400 transition-transform duration-[var(--dur-press)] ease-[var(--ease-out)] ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-2 w-60 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-float dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="px-4 py-3">
            <span className="runhead">Signed in as</span>
            <p className="mt-1 truncate text-sm font-medium text-slate-900 dark:text-slate-100">
              {displayName}
            </p>
          </div>
          <Link
            to="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="rule flex items-center gap-2.5 px-4 py-2.5 text-sm text-slate-700 outline-none transition-colors duration-[var(--dur-press)] hover:bg-slate-100 focus-visible:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 dark:focus-visible:bg-slate-800"
          >
            <Settings size={15} className="text-slate-400" aria-hidden />
            Settings
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={onLogout}
            className="rule flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-red-600 outline-none transition-colors duration-[var(--dur-press)] hover:bg-red-50 focus-visible:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30 dark:focus-visible:bg-red-950/30"
          >
            <LogOut size={15} aria-hidden />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
