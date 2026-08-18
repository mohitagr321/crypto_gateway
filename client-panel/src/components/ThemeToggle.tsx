import { Moon, Sun } from 'lucide-react';
import { useTheme } from '@/context/ThemeContext';

/**
 * Light/dark switch, worn by the app topbar, the marketing header, the auth
 * shell and the checkout.
 *
 * 44px BELOW `sm`, 40px ABOVE IT, which is the same relaxation `.btn` makes and
 * for the same reason: the floor is a thumb, not a pointer. It was a `p-2` box
 * around an 18px glyph — 34px square, under the floor on every phone this
 * product's merchants actually carry, and a real audit finding rather than a
 * theoretical one. At `sm` it drops to 40px to sit level with the shell's other
 * topbar controls.
 *
 * The hover band is `--hover`, the single hover language shared by the ledger
 * row, the nav item and the menu row, rather than a hand-picked slate step —
 * so this control cannot drift away from the chrome it sits in.
 */
export default function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Light mode' : 'Dark mode'}
      className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-500 transition-colors duration-[var(--dur-press)] ease-[var(--ease-out)] hover:bg-[var(--hover)] hover:text-slate-900 sm:h-10 sm:w-10 dark:text-slate-400 dark:hover:text-slate-100"
    >
      {isDark ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
    </button>
  );
}
