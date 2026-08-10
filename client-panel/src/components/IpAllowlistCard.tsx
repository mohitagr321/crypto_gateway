import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, Save, ShieldAlert, X } from 'lucide-react';
import { errorMessage, updateSettings } from '@/lib/api';
import Badge from '@/components/Badge';
import Spinner from '@/components/Spinner';

interface Props {
  value: string[];
  /** True when a bearer-token key exists — an empty allowlist is riskier then. */
  hasBearerKey: boolean;
}

/**
 * IP allowlist editor.
 *
 * `clients.ip_whitelist` has existed in the schema since the beginning but was
 * never enforced and had no UI. It is enforced now (middleware/auth.ts) for both
 * key modes, which makes it the main containment for a leaked bearer token — so
 * it needs to be editable and its empty state needs to be visibly a choice.
 *
 * Empty means unrestricted. That is the default and what every existing merchant
 * has, so nothing breaks by leaving it alone.
 *
 * ---------------------------------------------------------------------------
 * SET AS A RULED BLOCK, NOT A CARD. It sits in a stack of settings blocks, and
 * a hairline plus a running head separates it from its neighbours for one pixel
 * where a card charged a border, a radius, a shadow and 24px on four sides. The
 * two former tinted panels — the amber warning and the green "saved" toast —
 * are now ink and a word, which is the house rule: colour confirms, the word
 * carries.
 *
 * THE EMPTY STATE IS NAMED. "Unrestricted" is printed next to the running head
 * rather than being left as an absence, because an empty list here is a
 * security posture and an unlabelled blank reads as "not set up yet".
 */
export default function IpAllowlistCard({ value, hasBearerKey }: Props) {
  const queryClient = useQueryClient();
  const [ips, setIps] = useState<string[]>(value);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setIps(value), [value]);

  const dirty =
    ips.length !== value.length || ips.some((ip, i) => ip !== value[i]);

  const save = useMutation({
    mutationFn: () => updateSettings({ ipWhitelist: ips }),
    onSuccess: (data) => {
      queryClient.setQueryData(['settings'], data);
      queryClient.invalidateQueries({ queryKey: ['onboarding'] });
    },
  });

  // Loose on purpose: accepts IPv4, IPv6 and the IPv6-mapped form a dual-stack
  // proxy produces. The server compares literally, so anything unparseable here
  // simply would never match rather than being dangerous.
  const looksLikeIp = (s: string) =>
    /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(s) || /^[0-9a-fA-F:]+$/.test(s);

  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (!looksLikeIp(v)) {
      setError('That does not look like an IP address.');
      return;
    }
    if (ips.includes(v)) {
      setError('That address is already listed.');
      return;
    }
    setError(null);
    setIps([...ips, v]);
    setDraft('');
  };

  const unrestricted = ips.length === 0;

  return (
    <section className="rule pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <span className="runhead">IP allowlist</span>
        {/* The posture, in a word, with the dot's shape as the second carrier.
            `waiting` is the amber/hollow mark: nothing is broken, but something
            is still owed here. */}
        <Badge tone={unrestricted ? 'waiting' : 'settled'} dot>
          {unrestricted ? 'Unrestricted' : `${ips.length} allowed`}
        </Badge>
      </div>

      <p className="measure mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
        With any entry in this list, API requests from every other address are
        rejected. Empty means no restriction — that is the default, and either way
        it does not affect signing in to the dashboard.
      </p>

      {hasBearerKey && unrestricted && (
        <div className="rule mt-5 flex gap-3 pt-4">
          <ShieldAlert
            size={16}
            className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden
          />
          <div className="min-w-0">
            <span className="runhead text-amber-600 dark:text-amber-400">
              Bearer token unconfined
            </span>
            <p className="measure mt-1.5 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
              You have a bearer-token API key. Without an allowlist that token works
              from anywhere it leaks — a log, a shared laptop, a screenshot. Your
              server's public IP in this list is the single best fix.
            </p>
          </div>
        </div>
      )}

      {/* The addresses, as ruled rows rather than chips. Each is a line of a
          short ledger: the address ranged left in mono, the control that removes
          it ranged right against the same rule. */}
      {ips.length > 0 && (
        <ul className="mt-5">
          {ips.map((ip) => (
            <li key={ip} className="rule flex items-center justify-between gap-4 py-2">
              <code className="num min-w-0 break-all font-mono text-sm text-slate-900 dark:text-slate-100">
                {ip}
              </code>
              <button
                type="button"
                onClick={() => setIps(ips.filter((x) => x !== ip))}
                className="shrink-0 rounded-sm p-1 text-slate-400 outline-none transition-colors duration-[var(--dur-press)] hover:text-red-600 focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:text-red-400"
                aria-label={`Remove ${ip}`}
              >
                <X size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-5 flex gap-2">
        <input
          className="input"
          placeholder="203.0.113.7"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          aria-label="IP address to allow"
        />
        <button type="button" className="btn-secondary shrink-0" onClick={add}>
          <Plus size={16} aria-hidden /> Add
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {save.isError && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">
          {errorMessage(save.error)}
        </p>
      )}
      {save.isSuccess && !dirty && (
        <p className="mt-3 flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
          <Check size={14} className="shrink-0" aria-hidden /> Allowlist updated
        </p>
      )}

      <div className="mt-5 flex justify-end">
        <button
          type="button"
          className="btn-primary"
          onClick={() => save.mutate()}
          disabled={save.isPending || !dirty}
        >
          {save.isPending ? (
            <Spinner size={16} />
          ) : (
            <>
              <Save size={16} aria-hidden /> Save allowlist
            </>
          )}
        </button>
      </div>
    </section>
  );
}
