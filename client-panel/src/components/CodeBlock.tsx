import { useState, type ReactNode } from 'react';
import CopyButton from './CopyButton';

export interface CodeTab {
  label: string;
  language?: string;
  code: string;
}

interface CodeBlockProps {
  tabs: CodeTab[];
  title?: ReactNode;
}

export default function CodeBlock({ tabs, title }: CodeBlockProps) {
  const [active, setActive] = useState(0);
  const current = tabs[active] ?? tabs[0];

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900 text-slate-100">
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950/60 px-2">
        <div className="flex flex-wrap">
          {tabs.map((tab, i) => (
            <button
              key={tab.label}
              type="button"
              onClick={() => setActive(i)}
              className={`px-3 py-2 text-xs font-medium transition ${
                i === active
                  ? 'border-b-2 border-brand-500 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 pr-1">
          {title && <span className="text-xs text-slate-500">{title}</span>}
          <CopyButton
            value={current.code}
            label="Copy"
            className="text-slate-400 hover:!bg-slate-800 hover:!text-white"
          />
        </div>
      </div>
      <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed">
        <code className="font-mono">{current.code}</code>
      </pre>
    </div>
  );
}
