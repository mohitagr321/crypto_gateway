import { AlertTriangle } from 'lucide-react';

interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
}

export default function ErrorState({
  message = 'Failed to load data.',
  onRetry,
}: ErrorStateProps) {
  return (
    <div className="flex min-h-[200px] flex-col items-center justify-center gap-3 text-center">
      <AlertTriangle className="text-amber-500" size={32} />
      <p className="text-sm text-slate-600 dark:text-slate-300">{message}</p>
      {onRetry && (
        <button type="button" className="btn-secondary" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
