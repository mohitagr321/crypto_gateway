import { LogOut, Menu } from 'lucide-react';
import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import Sidebar from './Sidebar';
import ThemeToggle from './ThemeToggle';

/**
 * The app shell.
 *
 * Topbar and spine share one 4rem band and one closing hairline, so the rule
 * runs unbroken across the top of the window and the two read as a single
 * masthead rather than as two panels that happen to line up. The topbar is set
 * on the page ground rather than on white: a console has one sheet, and a
 * lighter strip across the top would be a second surface claiming an importance
 * it does not have.
 */
export default function Layout() {
  const { user, logout } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex h-full">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-slate-50/90 px-4 backdrop-blur sm:px-6 dark:border-slate-800 dark:bg-slate-950/90">
          <button
            type="button"
            className="btn-ghost h-9 w-9 !p-0 lg:hidden"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>

          <span className="runhead hidden sm:block">Gateway administration</span>

          <div className="ml-auto flex items-center gap-3">
            <ThemeToggle />
            {/* Who you are is a fact, not a control: ink and a running head, no
                avatar disc. The disc was a brand-tinted circle with an initial
                in it, which spent the one colour reserved for things you can
                click on something you cannot. */}
            <div className="hidden min-w-0 text-right sm:block">
              <p className="truncate text-sm leading-tight text-slate-900 dark:text-slate-100">
                {user?.email ?? 'Admin'}
              </p>
              <p className="truncate text-[11px] capitalize leading-tight text-slate-500 dark:text-slate-400">
                {user?.role?.replace('_', ' ') ?? '—'}
              </p>
            </div>
            <button
              type="button"
              onClick={logout}
              className="btn-ghost h-9 w-9 !p-0"
              title="Log out"
              aria-label="Log out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
