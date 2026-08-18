import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { MoreHorizontal, X } from 'lucide-react';
import { DOCK_ITEMS, NAV_GROUPS } from '@/lib/nav';

/**
 * THE MOBILE DOCK.
 *
 * A hamburger is the correct pattern for a fifteen-item nav and the WRONG one
 * for the three destinations a merchant actually opens on a phone: it puts two
 * taps and a full-screen context switch in front of "did that payment land".
 * So the three that matter get a permanent floating dock, and the other twelve
 * stay one tap away behind More, which opens the complete index. Nothing is
 * unreachable; the common case stops costing a drawer.
 *
 * WHY IT FLOATS RATHER THAN SPANNING THE WIDTH. A full-width bar welded to the
 * bottom edge is a browser-chrome shape — it collides visually with Safari's
 * toolbar and with the home indicator, and it reads as part of the device
 * rather than as part of the app. A pill inset from the edges reads as ours,
 * and it lets the page show through underneath, which keeps the depth field
 * continuous.
 *
 * SAFE AREA IS NOT OPTIONAL. `bottom: calc(0.75rem + env(safe-area-inset-bottom))`
 * in the `.dock` rule is what keeps it clear of the iPhone home indicator; a
 * fixed bottom element without it is the single most common iOS layout bug.
 * The matching half of the fix is `pb-28` on `<main>` in Layout — the dock
 * floats OVER the page, so without bottom padding the last row of every table
 * sits permanently underneath it.
 *
 * TOUCH TARGETS are 56px wide and 44px tall, above the 44px floor, and the
 * whole dock sits inside the thumb arc of a one-handed grip rather than at the
 * top of the screen where the old menu button lived.
 */
export default function MobileDock() {
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();

  // Any navigation closes the sheet, including one made from inside it.
  useEffect(() => setMoreOpen(false), [location.pathname]);

  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMoreOpen(false);
    document.addEventListener('keydown', onKey);
    // The sheet is modal: the page behind it must not scroll under the finger.
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [moreOpen]);

  return (
    <>
      <nav className="dock" aria-label="Primary">
        {DOCK_ITEMS.map(({ to, label, icon: Icon, end, short }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => `dock-item ${isActive ? 'dock-item-on' : ''}`}
          >
            <Icon size={18} aria-hidden />
            <span>{short ?? label}</span>
          </NavLink>
        ))}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          className={`dock-item ${moreOpen ? 'dock-item-on' : ''}`}
          aria-expanded={moreOpen}
          aria-haspopup="dialog"
        >
          <MoreHorizontal size={18} aria-hidden />
          <span>More</span>
        </button>
      </nav>

      {moreOpen && <MoreSheet onClose={() => setMoreOpen(false)} />}
    </>
  );
}

/**
 * The full index, as a bottom sheet.
 *
 * A SHEET RATHER THAN A FULL-SCREEN PAGE, because it is a menu and not a
 * destination: the page stays visible above it, so the merchant does not lose
 * their place to look something up. It is capped at 78dvh and scrolls
 * internally — a menu taller than the viewport that pushes its own last item
 * off-screen is worse than the drawer it replaced.
 *
 * It enters from the bottom edge in 220ms. This is one of the few places in the
 * product that animates travel, and it earns it: a sheet that appears without
 * moving reads as a page change rather than as a layer, which is precisely the
 * confusion the sheet exists to avoid.
 */
function MoreSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="All pages">
      <div
        className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div
        className="glass absolute inset-x-0 bottom-0 max-h-[78dvh] overflow-y-auto rounded-t-3xl border-x-0 border-b-0 shadow-float"
        style={{ paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom))' }}
      >
        {/* The grabber. Purely a signifier — it says "this is a sheet, it came
            from down there" — so it is aria-hidden and not a control. */}
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-transparent px-5 pb-3 pt-3">
          <span
            className="absolute left-1/2 top-2 h-1 w-10 -translate-x-1/2 rounded-full bg-slate-300 dark:bg-slate-700"
            aria-hidden
          />
          <h2 className="runhead pt-3">All pages</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 mt-2 grid h-10 w-10 place-items-center rounded-full text-slate-500 hover:bg-[var(--hover)] dark:text-slate-400"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-3 pb-2">
          {NAV_GROUPS.map((group) => (
            <div key={group.heading} className="mb-3">
              <p className="runhead px-3 pb-1.5">{group.heading}</p>
              <div className="grid grid-cols-2 gap-1.5">
                {group.items.map(({ to, label, icon: Icon, end }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={end}
                    onClick={onClose}
                    className={({ isActive }) =>
                      `flex min-h-[3rem] items-center gap-2.5 rounded-xl border border-[var(--line)] px-3 py-2.5 text-[13px] transition-colors ${
                        isActive
                          ? 'bg-brand-500/15 font-medium text-slate-900 dark:text-slate-50'
                          : 'bg-[var(--surface-2)] text-slate-600 dark:text-slate-300'
                      }`
                    }
                  >
                    <Icon size={16} className="shrink-0 text-slate-400" aria-hidden />
                    <span className="truncate">{label}</span>
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
