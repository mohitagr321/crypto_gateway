import { LogOut, Menu } from 'lucide-react';
import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import Sidebar from './Sidebar';
import ThemeToggle from './ThemeToggle';

export default function Layout() {
  const { user, logout } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex h-full">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Topbar */}
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-4 border-b border-gray-200 bg-white/80 px-4 backdrop-blur dark:border-gray-800 dark:bg-gray-900/80 sm:px-6">
          <button
            className="btn-ghost h-9 w-9 !p-0 lg:hidden"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>

          <div className="hidden text-sm text-gray-500 dark:text-gray-400 sm:block">
            Payment Gateway Administration
          </div>

          <div className="ml-auto flex items-center gap-3">
            <ThemeToggle />
            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium leading-tight">{user?.email ?? 'Admin'}</p>
              <p className="text-[11px] capitalize text-gray-400">{user?.role?.replace('_', ' ')}</p>
            </div>
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700 dark:bg-brand-500/20 dark:text-brand-300">
              {(user?.email ?? 'A').slice(0, 1).toUpperCase()}
            </div>
            <button onClick={logout} className="btn-ghost h-9 w-9 !p-0" title="Log out" aria-label="Log out">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
