import { Moon, Sun } from 'lucide-react';
import { useTheme } from '@/context/ThemeContext';

export default function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle theme"
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      className="btn-secondary h-9 w-9 !p-0"
    >
      {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
