import { Check, Circle, X } from 'lucide-react';
import type { Payment, PaymentStatus } from '@/types';
import { formatDate } from '@/lib/format';

interface Step {
  key: PaymentStatus;
  label: string;
  description: string;
}

const HAPPY_PATH: Step[] = [
  { key: 'waiting', label: 'Waiting', description: 'Awaiting USDT deposit' },
  { key: 'confirming', label: 'Confirming', description: 'Transaction seen, gathering confirmations' },
  { key: 'confirmed', label: 'Confirmed', description: 'Enough confirmations reached' },
  { key: 'swept', label: 'Swept', description: 'Funds moved to collection wallet' },
];

const ORDER: PaymentStatus[] = ['waiting', 'confirming', 'confirmed', 'swept'];

export default function PaymentTimeline({ payment }: { payment: Payment }) {
  const isFailure =
    payment.status === 'failed' ||
    payment.status === 'expired' ||
    payment.status === 'partial';

  const currentIndex = ORDER.indexOf(payment.status);

  return (
    <div>
      <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
        Timeline
      </h4>
      <ol className="relative space-y-4 border-l border-slate-200 pl-5 dark:border-slate-700">
        {HAPPY_PATH.map((step, i) => {
          const done = !isFailure && currentIndex >= i && currentIndex !== -1;
          const active = !isFailure && currentIndex === i;
          return (
            <li key={step.key} className="relative">
              <span
                className={`absolute -left-[27px] flex h-4 w-4 items-center justify-center rounded-full ring-4 ring-white dark:ring-slate-900 ${
                  done
                    ? 'bg-brand-500 text-white'
                    : 'bg-slate-200 text-slate-400 dark:bg-slate-700'
                }`}
              >
                {done ? <Check size={10} /> : <Circle size={6} />}
              </span>
              <p
                className={`text-sm font-medium ${
                  active
                    ? 'text-brand-600 dark:text-brand-400'
                    : done
                      ? 'text-slate-700 dark:text-slate-200'
                      : 'text-slate-400'
                }`}
              >
                {step.label}
                {i === 0 && payment.createdAt && (
                  <span className="ml-2 font-normal text-xs text-slate-400">
                    {formatDate(payment.createdAt)}
                  </span>
                )}
              </p>
              <p className="text-xs text-slate-400">{step.description}</p>
            </li>
          );
        })}

        {isFailure && (
          <li className="relative">
            <span className="absolute -left-[27px] flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-white ring-4 ring-white dark:ring-slate-900">
              <X size={10} />
            </span>
            <p className="text-sm font-medium capitalize text-red-600 dark:text-red-400">
              {payment.status}
            </p>
            <p className="text-xs text-slate-400">
              {payment.status === 'expired'
                ? 'Payment window elapsed without full payment.'
                : payment.status === 'partial'
                  ? 'Received less than the requested amount.'
                  : 'Payment failed or was reversed by a reorg.'}
            </p>
          </li>
        )}
      </ol>
    </div>
  );
}
