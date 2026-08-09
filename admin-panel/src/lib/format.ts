// Small formatting + explorer-link helpers shared across pages.

export const BSCSCAN = 'https://bscscan.com';
export const TRONSCAN = 'https://tronscan.org/#';

/**
 * Explorer links, resolved by the row's own network.
 *
 * A TRC20 hash on BscScan is a dead link (and vice versa), so every call site
 * that renders a hash or address must pass the network. It is optional and
 * defaults to BEP20 — rows created before the network column existed are BEP20
 * by definition, so they keep linking exactly where they always did.
 */
export const txLink = (hash: string, network?: string) =>
  network === 'TRC20' ? `${TRONSCAN}/transaction/${hash}` : `${BSCSCAN}/tx/${hash}`;

export const addrLink = (addr: string, network?: string) =>
  network === 'TRC20' ? `${TRONSCAN}/address/${addr}` : `${BSCSCAN}/address/${addr}`;

/**
 * Badge tone per network, so the two chains are visually distinct everywhere.
 * Deliberately avoids red/green — those read as failure/success in the adjacent
 * status column, and a network is neither.
 */
export const networkTone = (network?: string): 'yellow' | 'purple' =>
  network === 'TRC20' ? 'purple' : 'yellow';

/** Human label for a network, e.g. 'TRC20 · Tron'. */
export const networkLabel = (network?: string): string =>
  network === 'TRC20' ? 'TRC20 · Tron' : 'BEP20 · BSC';

export function shortHash(value?: string | null, head = 6, tail = 4): string {
  if (!value) return '—';
  if (value.length <= head + tail + 2) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function formatUsdt(value?: string | number | null, dp = 2): string {
  if (value === null || value === undefined || value === '') return '0.00';
  const n = typeof value === 'string' ? Number(value) : value;
  if (Number.isNaN(n)) return String(value);
  return n.toLocaleString('en-US', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/**
 * Format a rate/percentage stored as NUMERIC(38,18) — trims trailing zeros so
 * "2.000000000000000000" -> "2" and "1.500000000000000000" -> "1.5".
 */
export function formatRate(value?: string | number | null): string {
  if (value === null || value === undefined || value === '') return '0';
  const n = typeof value === 'string' ? Number(value) : value;
  if (Number.isNaN(n)) return String(value);
  return String(parseFloat(n.toFixed(6)));
}

export function formatDate(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function relativeTime(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value).getTime();
  if (Number.isNaN(d)) return String(value);
  const diff = d - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const hrs = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (mins < 60) return rtf.format(Math.sign(diff) * mins, 'minute');
  if (hrs < 24) return rtf.format(Math.sign(diff) * hrs, 'hour');
  return rtf.format(Math.sign(diff) * days, 'day');
}

export function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
