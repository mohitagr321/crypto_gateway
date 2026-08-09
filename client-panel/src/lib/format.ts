import type { PaymentStatus } from '@/types';

/** Truncate a hash/address for display: 0x1234…abcd */
export function shortHash(value: string, head = 6, tail = 4): string {
  if (!value) return '';
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Format a USDT amount string to a fixed 2dp display, tolerant of noise. */
export function formatAmount(value: string | number | undefined): string {
  if (value === undefined || value === null || value === '') return '0.00';
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(n)) return String(value);
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

/**
 * Format a rate/percentage stored as NUMERIC(38,18) — trims trailing zeros so
 * "2.000000000000000000" -> "2" and "1.500000000000000000" -> "1.5".
 */
export function formatRate(value: string | number | undefined): string {
  if (value === undefined || value === null || value === '') return '0';
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(n)) return String(value);
  return String(parseFloat(n.toFixed(6)));
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDateShort(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}

/** Countdown between now and an ISO expiry. Returns ms + a mm:ss label. */
export function timeRemaining(expiresAt: string | undefined): {
  ms: number;
  label: string;
  expired: boolean;
} {
  if (!expiresAt) return { ms: 0, label: '—', expired: true };
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return { ms: 0, label: '00:00', expired: true };
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  const label = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return { ms, label, expired: false };
}

/** Terminal statuses that stop polling. */
export const TERMINAL_STATUSES: PaymentStatus[] = [
  'confirmed',
  'failed',
  'expired',
  'swept',
];

export function isTerminal(status: PaymentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export const ALL_STATUSES: PaymentStatus[] = [
  'waiting',
  'confirming',
  'confirmed',
  'partial',
  'failed',
  'expired',
  'swept',
];

/** BEP20 / EVM address validation (checksum-agnostic). */
export function isValidBep20Address(addr: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(addr.trim());
}

/** TRC20 (Tron) base58 address: 'T' + 33 base58 chars. */
export function isValidTrc20Address(addr: string): boolean {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr.trim());
}

export function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Build a CSV string from rows + headers and trigger a client-side download. */
export function downloadCsv(
  filename: string,
  headers: string[],
  rows: (string | number | null | undefined)[][],
): void {
  const escape = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const csv = [headers, ...rows]
    .map((row) => row.map(escape).join(','))
    .join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
