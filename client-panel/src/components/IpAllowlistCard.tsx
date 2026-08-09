import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Network, Plus, Save, ShieldAlert, X } from 'lucide-react';
import { errorMessage, updateSettings } from '@/lib/api';
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

  return (
    <div className="card space-y-4 p-6">
      <div className="flex items-center gap-2">
        <Network size={16} className="text-brand-600" />
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          IP allowlist
        </h3>
      </div>

      <p className="text-sm text-slate-600 dark:text-slate-400">
        When this list has any entry, API requests from any other address are
        rejected. Leave it empty for no restriction. This does not affect signing
        in to the dashboard.
      </p>

      {hasBearerKey && ips.length === 0 && (
        <div className="flex gap-2.5 rounded-lg bg-amber-50 p-3.5 text-xs leading-relaxed text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          <ShieldAlert size={15} className="mt-0.5 shrink-0" />
          <span>
            You have a bearer-token API key. Without an allowlist, that token works
            from anywhere it leaks — a log, a shared laptop, a screenshot. Adding
            your server's public IP here is the single best fix.
          </span>
        </div>
      )}

      {ips.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {ips.map((ip) => (
            <li
              key={ip}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-3 pr-1.5 dark:border-slate-700 dark:bg-slate-800/60"
            >
              <code className="font-mono text-xs text-slate-700 dark:text-slate-200">
                {ip}
              </code>
              <button
                type="button"
                onClick={() => setIps(ips.filter((x) => x !== ip))}
                className="rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-red-600 dark:hover:bg-slate-700"
                aria-label={`Remove ${ip}`}
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
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
          <Plus size={16} /> Add
        </button>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}
      {save.isError && (
        <p className="text-sm text-red-600">{errorMessage(save.error)}</p>
      )}
      {save.isSuccess && !dirty && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
          Allowlist updated
        </p>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          className="btn-primary"
          onClick={() => save.mutate()}
          disabled={save.isPending || !dirty}
        >
          {save.isPending ? <Spinner size={16} /> : <><Save size={16} /> Save allowlist</>}
        </button>
      </div>
    </div>
  );
}
