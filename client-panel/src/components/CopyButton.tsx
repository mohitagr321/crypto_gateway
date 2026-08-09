import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface CopyButtonProps {
  value: string;
  className?: string;
  label?: string;
  size?: number;
}

export default function CopyButton({
  value,
  className = '',
  label,
  size = 16,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Fallback for insecure contexts.
      const ta = document.createElement('textarea');
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      title="Copy to clipboard"
      aria-label="Copy to clipboard"
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200 ${className}`}
    >
      {copied ? (
        <Check size={size} className="text-emerald-500" />
      ) : (
        <Copy size={size} />
      )}
      {label && <span>{copied ? 'Copied' : label}</span>}
    </button>
  );
}
