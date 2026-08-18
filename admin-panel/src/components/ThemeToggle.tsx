import { Moon, Sun } from 'lucide-react';
import { useTheme } from '@/context/ThemeContext';

/**
 * Light/dark switch, worn by the console topbar and the sign-in screen.
 *
 * 44px BELOW `sm`, 40px ABOVE IT, which is the same relaxation `.btn` and
 * `.input` make and for the same reason: the floor is a thumb, not a pointer.
 * It was `.btn-secondary` forced to 36px square with the button class's own
 * min-height overridden away — under the floor on every phone an operator
 * actually carries, and a real audit finding rather than a theoretical one.
 *
 * IT IS NO LONGER A `.btn-secondary`. That class draws a filled, bordered,
 * shadowed control, which says "this is a thing you press to make something
 * happen"; a theme switch is chrome, and giving it the same weight as "Trigger
 * payout" two elements away is a false equivalence. Ghost ink with the shared
 * hover band is what the merchant panel's copy of this control wears.
 *
 * The hover band is `--hover`, the single hover language shared by the ledger
 * row, the nav item and the menu row, rather than a hand-picked slate step — so
 * this control cannot drift away from the chrome it sits in.
 *
 * `aria-label` carries the action and `title` carries the destination state,
 * both of which flip with the theme. A `title` is a mouse affordance with no
 * touch equivalent, which is why the label is not left to it.
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
