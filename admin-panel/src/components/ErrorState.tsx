import { AlertTriangle } from 'lucide-react';

export default function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="card flex flex-col items-center gap-3 p-10 text-center">
      <AlertTriangle className="h-8 w-8 text-red-500" />
      <p className="text-sm text-gray-600 dark:text-gray-300">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="btn-secondary">
          Retry
        </button>
      )}
    </div>
  );
}
