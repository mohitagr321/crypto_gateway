import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { ChevronDown, LogOut, Menu, Search, Settings, UserCircle2 } from 'lucide-react';
import Sidebar from './Sidebar';
import MobileDock from './MobileDock';
import DepthField from './DepthField';
import ThemeToggle from './ThemeToggle';
import CommandPalette, { useCommandPalette } from './CommandPalette';
import { useAuth } from '@/context/AuthContext';
import { useSpotlight } from '@/lib/useSpotlight';

/**
 * THE APP SHELL.
 *
 * THREE Z-PLANES AND NO MORE, which is the discipline the whole design rests
 * on. Assign depth per PLANE, never per component, or the fiction collapses:
 *
 *   0  FIELD     the drifting aurora, the grid and the grain. Fixed, behind
 *                everything, never interactive.
 *   1  CANVAS    the page itself and the navigation rail. Transparent — they
 *                are printed ON the field, which is why the rail has a hairline
 *                rather than a fill.
 *   2  SURFACE   cards, the ledger, the metric tiles. Raised: lighter than the
 *                canvas, rim-lit, and the only plane that casts.
 *   3  FLOATING  the topbar, the mobile dock, the palette, popovers. The only
 *                plane that gets glass.
 *
 * WHY THE RAIL IS NOT GLASS. Glass is expensive (each element repaints its
 * backdrop every scroll frame) and it is a signal — it means "this is floating
 * above the page". The rail is not floating, it is beside. Spending glass on it
 * would both cost frames and dilute the one thing glass says.
 *
 * MOTION: none on mount. The only movement in this file is the mobile drawer
 * and a chevron rotating on a menu the user opened. The command palette mounts
 * and unmounts with no transition at all, by design — see CommandPalette.
 *
 * THE SHELL IS BOUNDED TO THE VIEWPORT, and it has to be. `h-dvh` rather than
 * `min-h-screen`: a minimum is not a height, so the shell used to grow to
 * whatever its taller column needed, `overflow-y-auto` on the nav never once
 * fired, and reaching the foot of the rail scrolled the ENTIRE app against a
 * second scrollbar. Dynamic viewport units rather than `100vh` because on
 * mobile `100vh` is taller than the visible viewport, which hides the foot of
 * the drawer behind the browser's own chrome.
 */
export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { user, logout } = useAuth();
  const { open: paletteOpen, setOpen: setPaletteOpen } = useCommandPalette();
  const location = useLocation();

  // One delegated pointer listener for every `.spot` surface in the app.
  useSpotlight();

  const displayName = (user?.name as string) || (user?.email as string) || 'Merchant';

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

  return (
    <div className="relative flex h-dvh">
      <DepthField />

      {/* The public site has one; the dashboard did not, so a keyboard user
          crossed fourteen nav links to reach the page on every navigation. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-brand-600 focus:px-4 focus:py-2 focus:text-white"
      >
        Skip to content
      </a>

      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <header className="glass sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-x-0 border-t-0 px-4 lg:px-6">
          <button
            type="button"
            className="-ml-1 grid h-10 w-10 place-items-center rounded-lg text-slate-500 transition-colors duration-[var(--dur-press)] hover:bg-[var(--hover)] hover:text-slate-900 lg:hidden dark:text-slate-400 dark:hover:text-slate-100"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>

          {/* Palette trigger. Doubles as the discoverability affordance for the
              ⌘K shortcut — a keyboard shortcut nobody is told about does not
              exist. A full field on desktop; on mobile it collapses to the icon
              alone, where there is no keyboard to shortcut and the space is
              worth more than the hint. */}
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="group flex h-10 items-center gap-2.5 rounded-full border border-[var(--line)] bg-[var(--surface-2)] px-3.5 text-sm text-slate-500 transition-colors duration-[var(--dur-press)] hover:border-brand-500/50 hover:text-slate-900 sm:w-72 dark:text-slate-400 dark:hover:text-slate-100"
            aria-label="Search pages and actions"
          >
            <Search size={15} className="shrink-0 text-slate-400" aria-hidden />
            <span className="hidden sm:inline">Search payments, links, keys…</span>
            <kbd className="ml-auto hidden rounded border border-[var(--line)] px-1.5 py-px font-mono text-[10px] text-slate-400 sm:block">
              ⌘K
            </kbd>
          </button>

          <div className="ml-auto flex items-center gap-1.5">
            <ThemeToggle />
            <span className="hidden h-6 w-px shrink-0 bg-[var(--line)] sm:block" aria-hidden />
            <UserMenu displayName={displayName} onLogout={logout} />
          </div>
        </header>

        {/*
          `pb-28` on small screens is the dock's clearance. The dock is fixed and
          floats over the page, so without it the last row of every list sits
          permanently underneath it — which is the classic bottom-navigation bug
          and is invisible until someone scrolls to the end of a real table.
        */}
        <main
          id="main"
          className="flex-1 overflow-y-auto px-4 pb-28 pt-5 lg:px-6 lg:pb-10 lg:pt-6"
        >
          <div className="mx-auto max-w-[88rem]">
            <Outlet />
          </div>
        </main>
      </div>

      <MobileDock />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

/**
 * Account menu. Replaces a bare "Logout" button that sat permanently in the
 * topbar — a one-click irreversible action next to navigation is easy to hit by
 * accident, and it wasted the only place an account context belongs.
 *
 * The PANEL is the one place in the shell that gets `shadow-float`: a popover
 * genuinely is a sheet raised above the page, which is the single case where a
 * cast shadow is the true statement rather than decoration.
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
        className="flex h-10 items-center gap-2 rounded-full px-2 text-sm text-slate-600 transition-colors duration-[var(--dur-press)] hover:bg-[var(--hover)] hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100"
      >
        <UserCircle2 size={19} className="shrink-0 text-slate-400" aria-hidden />
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
          className="surface absolute right-0 z-30 mt-2 w-60 overflow-hidden p-1 shadow-float"
        >
          <div className="px-3 py-2.5">
            <span className="runhead">Signed in as</span>
            <p className="mt-1 truncate text-sm font-medium text-slate-900 dark:text-slate-100">
              {displayName}
            </p>
          </div>
          <Link
            to="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm text-slate-700 transition-colors duration-[var(--dur-press)] hover:bg-[var(--hover)] dark:text-slate-300"
          >
            <Settings size={15} className="text-slate-400" aria-hidden />
            Settings
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={onLogout}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm text-red-600 transition-colors duration-[var(--dur-press)] hover:bg-red-500/10 dark:text-red-400"
          >
            <LogOut size={15} aria-hidden />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
