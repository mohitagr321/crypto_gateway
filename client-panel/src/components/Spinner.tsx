import { Loader2 } from 'lucide-react';

interface SpinnerProps {
  size?: number;
  className?: string;
  label?: string;
}

export default function Spinner({ size = 20, className = '', label }: SpinnerProps) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`} role="status">
      <Loader2 className="animate-spin text-brand-600" size={size} aria-hidden />
      {label && <span className="text-sm text-slate-500">{label}</span>}
    </span>
  );
}

/** Centered full-panel loading state. */
export function LoadingPanel({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex min-h-[200px] items-center justify-center">
      <Spinner size={28} label={label} />
    </div>
  );
}
