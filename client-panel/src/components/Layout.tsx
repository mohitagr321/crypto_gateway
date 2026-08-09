import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { ChevronDown, LogOut, Menu, Search, Settings, UserCircle2 } from 'lucide-react';
import Sidebar from './Sidebar';
import ThemeToggle from './ThemeToggle';
import CommandPalette, { useCommandPalette } from './CommandPalette';
import { useAuth } from '@/context/AuthContext';

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

  return (
    <div className="flex h-full min-h-screen bg-slate-50 dark:bg-slate-950">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-slate-200 bg-white/80 px-4 backdrop-blur-xl dark:border-slate-800 dark:bg-slate-900/80 lg:px-6">
          <button
            type="button"
            className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 lg:hidden dark:hover:bg-slate-800"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>

          {/* Palette trigger. Doubles as the discoverability affordance for the
              ⌘K shortcut — a keyboard shortcut nobody is told about does not
              exist. Renders as a full search field on desktop and collapses to
              an icon on mobile, where there is no keyboard to shortcut. */}
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="group flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-400 transition hover:border-slate-300 hover:text-slate-600 dark:border-slate-700 dark:hover:border-slate-600 dark:hover:text-slate-300 sm:w-64"
            aria-label="Search pages and actions"
          >
            <Search size={15} className="shrink-0" />
            <span className="hidden sm:inline">Search…</span>
            <kbd className="ml-auto hidden rounded border border-slate-200 px-1.5 py-0.5 text-[10px] font-medium sm:block dark:border-slate-700">
              ⌘K
            </kbd>
          </button>

          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <UserMenu displayName={displayName} onLogout={logout} />
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
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
        className="flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        <UserCircle2 size={18} className="shrink-0 text-slate-400" />
        <span className="hidden max-w-[10rem] truncate sm:inline">{displayName}</span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-2 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-float dark:border-slate-700 dark:bg-slate-900"
        >
          <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
            <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
              {displayName}
            </p>
            <p className="mt-0.5 text-xs text-slate-400">Merchant account</p>
          </div>
          <Link
            to="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-slate-700 transition hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <Settings size={15} className="text-slate-400" />
            Settings
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={onLogout}
            className="flex w-full items-center gap-2.5 border-t border-slate-100 px-4 py-2.5 text-left text-sm text-red-600 transition hover:bg-red-50 dark:border-slate-800 dark:text-red-400 dark:hover:bg-red-950/30"
          >
            <LogOut size={15} />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
