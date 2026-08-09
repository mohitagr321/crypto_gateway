import { Loader2 } from 'lucide-react';
import { classNames } from '@/lib/format';

export default function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-8 text-gray-500 dark:text-gray-400">
      <Loader2 className={classNames('h-5 w-5 animate-spin', className)} />
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}
