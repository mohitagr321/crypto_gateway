import type { ReactNode } from 'react';
import type { PaymentStatus, PayoutStatus, WebhookDeliveryStatus } from '@/types';

type Tone =
  | 'gray'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'red'
  | 'purple'
  | 'indigo';

const toneClasses: Record<Tone, string> = {
  gray: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  yellow: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  blue: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  red: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  purple: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  indigo: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300',
};

export default function Badge({
  tone = 'gray',
  children,
  dot = false,
}: {
  tone?: Tone;
  children: ReactNode;
  dot?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${toneClasses[tone]}`}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

const paymentTone: Record<PaymentStatus, Tone> = {
  waiting: 'yellow',
  confirming: 'blue',
  confirmed: 'green',
  partial: 'purple',
  failed: 'red',
  expired: 'gray',
  swept: 'indigo',
};

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  const animate = status === 'waiting' || status === 'confirming';
  return (
    <Badge tone={paymentTone[status]} dot>
      <span className={animate ? 'animate-pulse' : ''}>{status}</span>
    </Badge>
  );
}

const payoutTone: Record<PayoutStatus, Tone> = {
  queued: 'yellow',
  processing: 'blue',
  sent: 'indigo',
  confirmed: 'green',
  failed: 'red',
};

export function PayoutStatusBadge({ status }: { status: PayoutStatus }) {
  return (
    <Badge tone={payoutTone[status] ?? 'gray'} dot>
      {status}
    </Badge>
  );
}

const webhookTone: Record<WebhookDeliveryStatus, Tone> = {
  success: 'green',
  failed: 'red',
  pending: 'yellow',
};

export function WebhookStatusBadge({ status }: { status: WebhookDeliveryStatus }) {
  return (
    <Badge tone={webhookTone[status] ?? 'gray'} dot>
      {status}
    </Badge>
  );
}
