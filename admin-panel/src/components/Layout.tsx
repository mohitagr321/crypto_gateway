import { ChevronDown, LogOut, Menu, UserCircle2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import DepthField from './DepthField';
import Sidebar from './Sidebar';
import ThemeToggle from './ThemeToggle';
import { useSpotlight } from '@/lib/useSpotlight';

/**
 * THE APP SHELL.
 *
 * THREE Z-PLANES AND NO MORE above the field, which is the discipline the whole
 * design rests on. Assign depth per PLANE, never per component, or the fiction
 * collapses:
 *
 *   0  FIELD     the drifting aurora, the grid and the grain. Fixed, behind
 *                everything, never interactive.
 *   1  CANVAS    the page itself and the navigation rail. Transparent — they
 *                are printed ON the field, which is why the rail has a hairline
 *                rather than a fill.
 *   2  SURFACE   cards, the ledger, the metric tiles. Raised: lighter than the
 *                canvas, rim-lit, and the only plane that casts.
 *   3  FLOATING  the topbar, the account menu, modals. The only plane that gets
 *                glass.
 *
 * WHY THE RAIL IS NOT GLASS. Glass is expensive — each element repaints its
 * backdrop every scroll frame — and it is a signal: it means "this is floating
 * above the page". The rail is not floating, it is beside. Spending glass on it
 * would both cost frames and dilute the one thing glass says. That matters more
 * here than in the merchant panel, because `<main>` is an INNER scroller under a
 * sticky glass topbar, so every wheel tick of every long ledger already pays for
 * one backdrop repaint.
 *
 * WHAT THIS CONSOLE DELIBERATELY DOES NOT TAKE FROM THE MERCHANT PANEL'S SHELL:
 *
 *   NO MOBILE DOCK. The merchant panel floats a pill of primary destinations at
 *   the bottom of a phone, because a merchant checks a payment from a phone all
 *   day. An operator console is a desktop tool — approving merchants, releasing
 *   payouts and reading webhook bodies are all things done at a keyboard — so
 *   the phone case here is "I am away from my desk and something broke", which
 *   the drawer serves. That is also why `<main>` carries no dock clearance: there is
 *   nothing fixed at the bottom for the last table row to hide under.
 *
 *   NO COMMAND PALETTE. There is no palette component in this app to mount, and
 *   inventing a parallel one is exactly the drift this phase exists to stop.
 *   The topbar therefore has no search field — see the report.
 *
 * MOTION: none on mount. The only movement in this file is the mobile drawer
 * and a chevron rotating on a menu the operator opened.
 *
 * SAFE AREAS. `viewport-fit=cover` is set in index.html, so the page now extends
 * under the notch and the home indicator and `env(safe-area-inset-*)` finally
 * resolves to something. Every edge this file owns pays it: the topbar grows by
 * the top inset rather than sliding its content under the status bar, and the
 * horizontal insets matter in LANDSCAPE, which is the orientation an operator
 * actually holds a phone in to read a seven-column ledger.
 *
 * THE SHELL IS BOUNDED TO THE VIEWPORT and `h-full` is load-bearing rather than
 * decorative: index.css sets `html, body, #root { height: 100dvh }`, and this is
 * the element that resolves against it. `dvh` rather than `vh` because on mobile
 * Safari `vh` is the viewport WITHOUT the collapsing toolbar — always taller
 * than what you can see — which is what used to hide the foot of the drawer
 * behind the browser's own chrome.
 */
export default function Layout() {
  const { user, logout } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

  // One delegated pointer listener for every `.spot` surface in the app.
  // Without this the spotlight fails SILENTLY — see lib/useSpotlight.ts.
  useSpotlight();

  // Close the mobile drawer whenever the route changes, otherwise it stays open
  // over the page the operator just navigated to.
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
    <div className="relative flex h-full">
      <DepthField />

      {/* Without this a keyboard operator crossed nine nav links to reach the
          page on every single navigation. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-brand-600 focus:px-4 focus:py-2 focus:text-white"
      >
        Skip to content
      </a>

      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        {/*
          The topbar is the only chrome on the floating plane, so it is the only
          thing here that gets glass. `border-x-0 border-t-0` keeps `.glass`'s
          hairline on the bottom edge alone — a box outline across the top of the
          window would draw a rectangle around nothing.

          The height is 4rem PLUS the top inset rather than 4rem with the inset
          eaten out of it: growing the bar is what keeps the controls on the same
          4rem line as the sidebar flag beside them, whatever the device does
          above it.
        */}
        <header
          className="glass sticky top-0 z-20 flex h-[calc(4rem+env(safe-area-inset-top))] shrink-0 items-center gap-3 border-x-0 border-t-0 pt-[env(safe-area-inset-top)] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] lg:pl-[max(1.5rem,env(safe-area-inset-left))] lg:pr-[max(1.5rem,env(safe-area-inset-right))]"
        >
          {/* 44px, not the 36px this was. An operator approving a merchant or
              releasing a payout from a phone is exactly the case where a
              mis-tap is expensive, and the menu is the first thing their thumb
              looks for. It relaxes to 40px at `sm`, the same relaxation `.btn`
              and ThemeToggle make, and is hidden entirely from `lg`. */}
          <button
            type="button"
            className="-ml-1 grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-500 transition-colors duration-[var(--dur-press)] hover:bg-[var(--hover)] hover:text-slate-900 sm:h-10 sm:w-10 lg:hidden dark:text-slate-400 dark:hover:text-slate-100"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
          >
            <Menu size={20} aria-hidden />
          </button>

          {/* Where you are, as a running head. Quiet on purpose: it labels, and
              a label is not something you can act on. */}
          <span className="runhead hidden sm:block">Gateway administration</span>

          <div className="ml-auto flex items-center gap-1.5">
            <ThemeToggle />
            <span className="hidden h-6 w-px shrink-0 bg-[var(--line)] sm:block" aria-hidden />
            <UserMenu
              email={user?.email ?? 'Admin'}
              role={user?.role?.replace('_', ' ') ?? '—'}
              onLogout={logout}
            />
          </div>
        </header>

        {/*
          The only scroller in the shell, which is what keeps the rail and the
          topbar still while a route moves under them.

          The bottom padding carries the safe-area inset because there is no dock
          to carry it — on a notched phone in portrait the last ledger row would
          otherwise sit in the home-indicator strip, which is touchable but reads
          as clipped.
        */}
        <main
          id="main"
          className="flex-1 overflow-y-auto px-4 pb-[calc(2.5rem+env(safe-area-inset-bottom))] pt-5 lg:px-6 lg:pt-6"
        >
          <div className="mx-auto max-w-[88rem]">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

/**
 * THE ACCOUNT MENU.
 *
 * This replaces a bare "Log out" glyph that sat permanently in the topbar next
 * to the theme toggle — a one-click irreversible action beside a decorative one,
 * at 36px square, which is a mis-tap waiting to happen and which also wasted the
 * only place an account context belongs. Ported from the merchant panel's
 * UserMenu so the two consoles put identity in the same corner and behind the
 * same gesture.
 *
 * WHAT IS IN IT IS DIFFERENT, AND SHOULD BE. The merchant panel offers Settings;
 * this console has no settings route, and the fact an operator actually needs at
 * a glance is their ROLE — it decides half of what this panel will let them do,
 * so it is printed in the menu head rather than hidden behind it.
 *
 * The PANEL is the one place besides the topbar that gets `shadow-float`: a
 * popover genuinely is a sheet raised above the page, which is the single case
 * where a cast shadow is the true statement rather than decoration.
 */
function UserMenu({
  email,
  role,
  onLogout,
}: {
  email: string;
  role: string;
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
        className="flex h-11 items-center gap-2 rounded-full px-2 text-sm text-slate-600 transition-colors duration-[var(--dur-press)] hover:bg-[var(--hover)] hover:text-slate-900 sm:h-10 dark:text-slate-300 dark:hover:text-slate-100"
      >
        <UserCircle2 size={19} className="shrink-0 text-slate-400" aria-hidden />
        <span className="hidden max-w-[12rem] truncate sm:inline">{email}</span>
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
          className="surface absolute right-0 z-30 mt-2 w-64 overflow-hidden p-1 shadow-float"
        >
          <div className="px-3 py-2.5">
            <span className="runhead">Signed in as</span>
            {/* `break-all`, not `truncate`: an address-shaped string that is
                silently cut is a string an operator reads wrong rather than
                notices is missing. An operator email on a corporate domain is
                routinely longer than this menu. */}
            <p className="mt-1 break-all text-sm font-medium text-slate-900 dark:text-slate-100">
              {email}
            </p>
            <p className="mt-0.5 text-xs capitalize text-slate-500 dark:text-slate-400">{role}</p>
          </div>
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
