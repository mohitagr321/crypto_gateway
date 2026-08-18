import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, Save, ShieldAlert, X } from 'lucide-react';
import { errorMessage, updateSettings } from '@/lib/api';
import Badge from '@/components/Badge';
import Section from '@/components/Section';
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
 * IT OWNS ITS SURFACE, AS A `Section`. It used to be a ruled block on the bare
 * page — right for a design made of hairlines, wrong for one made of lit
 * surfaces, where a form floating on the canvas reads as unfinished. Settings
 * renders it with no wrapper of its own (there is a comment there saying so),
 * so the surface has to come from here; do NOT wrap this in a second `Section`
 * at the call site or the page grows two nested cards for one block.
 *
 * The two former tinted panels — the amber warning and the green "saved" toast
 * — are still ink and a word rather than boxes, which is the house rule:
 * colour confirms, the word carries. That has not changed, and a surface is not
 * an invitation to reintroduce them.
 *
 * THE EMPTY STATE IS NAMED. "Unrestricted" is printed against the running head
 * rather than being left as an absence, because an empty list here is a
 * security posture and an unlabelled blank reads as "not set up yet". It rides
 * in the section's `aside` slot, which is the same place a "View all" or a
 * count sits everywhere else in the product.
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
    <Section
      title="IP allowlist"
      /* The posture, in a word, with the dot's shape as the second carrier.
         `waiting` is the amber/hollow mark: nothing is broken, but something is
         still owed here. */
      aside={
        <Badge tone={unrestricted ? 'waiting' : 'settled'} dot>
          {unrestricted ? 'Unrestricted' : `${ips.length} allowed`}
        </Badge>
      }
    >
      <p className="measure text-sm leading-relaxed text-slate-500 dark:text-slate-400">
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
          it ranged right against the same rule.

          THE REMOVE CONTROL IS 44px BELOW `sm`. It was a `p-1` box around a
          14px glyph — about 26px, and one of the smallest targets in the
          product, on a control that DELETES the thing containing a bearer
          token. A miss here is either a silent loss of protection or a support
          ticket. It gives the space back at `sm`, where there is a pointer. The
          negative margin keeps the row's own height unchanged on desktop so
          the list does not suddenly breathe differently from the ruled lists
          beside it. */}
      {ips.length > 0 && (
        <ul className="mt-5">
          {ips.map((ip) => (
            <li key={ip} className="rule flex items-center justify-between gap-3 py-2">
              <code className="num min-w-0 break-all font-mono text-sm text-slate-900 dark:text-slate-100">
                {ip}
              </code>
              <button
                type="button"
                onClick={() => setIps(ips.filter((x) => x !== ip))}
                className="-my-1.5 grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-500 transition-colors duration-[var(--dur-press)] ease-[var(--ease-out)] hover:bg-[var(--hover)] hover:text-red-600 sm:-my-1 sm:h-9 sm:w-9 dark:text-slate-400 dark:hover:text-red-400"
                aria-label={`Remove ${ip}`}
              >
                <X size={15} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-5 flex gap-2">
        <input
          className="input min-w-0"
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
    </Section>
  );
}
