import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  ExternalLink,
  Link2,
  Plus,
  QrCode,
  RotateCcw,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import {
  checkoutUrl,
  createPaymentLink,
  errorMessage,
  listPaymentLinks,
  setPaymentLinkStatus,
} from '@/lib/api';
import { formatDate } from '@/lib/format';
import type { PaymentLink } from '@/types';
import PageHeader from '@/components/PageHeader';
import CopyButton from '@/components/CopyButton';
import Modal from '@/components/Modal';
import Spinner, { LoadingPanel } from '@/components/Spinner';
import ErrorState from '@/components/ErrorState';
import AssetPicker from '@/components/AssetPicker';

/**
 * Payment links — share a URL, get paid. No integration required.
 *
 * The page is built around the one action that matters: copy the link. Every
 * row leads with it, because a merchant who has created a link is here to send
 * it to someone, not to admire the table.
 *
 * Links are DISABLED, never deleted: the URL may already be sitting in a
 * customer's inbox, and a disabled link can explain itself where a 404 cannot.
 */
export default function PaymentLinks() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [qrFor, setQrFor] = useState<PaymentLink | null>(null);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [pinAsset, setPinAsset] = useState(false);
  const [asset, setAsset] = useState('USDT');
  const [network] = useState('BEP20');
  const [singleUse, setSingleUse] = useState(false);

  const links = useQuery({ queryKey: ['payment-links'], queryFn: listPaymentLinks });

  const reset = () => {
    setTitle('');
    setDescription('');
    setAmount('');
    setPinAsset(false);
    setAsset('USDT');
    setSingleUse(false);
  };

  const create = useMutation({
    mutationFn: () =>
      createPaymentLink({
        title: title.trim(),
        description: description.trim() || undefined,
        // Empty amount means an open amount — the customer types one.
        amount: amount.trim() || undefined,
        ...(pinAsset ? { asset, network } : {}),
        reusable: !singleUse,
        ...(singleUse ? { maxUses: 1 } : {}),
      }),
    onSuccess: () => {
      setCreateOpen(false);
      reset();
      qc.invalidateQueries({ queryKey: ['payment-links'] });
    },
  });

  const toggle = useMutation({
    mutationFn: (l: PaymentLink) =>
      setPaymentLinkStatus(l.id, l.status === 'active' ? 'disabled' : 'active'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payment-links'] }),
  });

  return (
    <>
      <PageHeader
        title="Payment links"
        description="Share a link, get paid. Your customer picks a coin and pays — no integration needed."
        actions={
          <button className="btn-primary" onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> New link
          </button>
        }
      />

      {links.isLoading ? (
        <LoadingPanel />
      ) : links.isError ? (
        <ErrorState message={errorMessage(links.error)} onRetry={() => links.refetch()} />
      ) : links.data && links.data.length === 0 ? (
        <div className="card flex flex-col items-center px-6 py-16 text-center">
          <Link2 size={34} className="text-slate-300 dark:text-slate-700" />
          <h3 className="mt-4 text-base font-semibold text-slate-900 dark:text-slate-100">
            No payment links yet
          </h3>
          <p className="mt-1.5 max-w-sm text-sm text-slate-500">
            Create one and send the URL to a customer. They open it, choose a coin
            and pay — you don't need to write any code.
          </p>
          <button className="btn-primary mt-6" onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> Create your first link
          </button>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {links.data?.map((l) => {
            const url = checkoutUrl(l.token);
            const disabled = l.status !== 'active';
            const usedUp = l.maxUses !== null && l.useCount >= l.maxUses;
            return (
              <div
                key={l.id}
                className={`card p-5 transition ${disabled ? 'opacity-60' : ''}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">
                      {l.title}
                    </h3>
                    <p className="mt-0.5 text-sm text-slate-500">
                      {l.amount ? (
                        <span className="num font-medium text-slate-700 dark:text-slate-300">
                          {trim(l.amount)}
                          {/* Only name the asset when the link pins one —
                              "250 any coin" reads as a unit, not a choice. */}
                          {l.asset ? ` ${l.asset}` : ''}
                        </span>
                      ) : (
                        'Customer enters the amount'
                      )}
                      {l.asset ? (
                        l.network && <> · {l.network}</>
                      ) : (
                        <> · customer picks the coin</>
                      )}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
                      onClick={() => setQrFor(l)}
                      aria-label="Show QR code"
                      title="Show QR code"
                    >
                      <QrCode size={16} />
                    </button>
                    <button
                      className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
                      onClick={() => toggle.mutate(l)}
                      aria-label={disabled ? 'Enable link' : 'Disable link'}
                      title={disabled ? 'Enable link' : 'Disable link'}
                    >
                      {disabled ? <RotateCcw size={16} /> : <Ban size={16} />}
                    </button>
                  </div>
                </div>

                {/* The primary action. A merchant is here to send this URL. */}
                <div className="mt-4 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-slate-700 dark:bg-slate-800/60">
                  <code className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600 dark:text-slate-300">
                    {url}
                  </code>
                  <CopyButton value={url} />
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded p-1 text-slate-400 transition hover:text-brand-600"
                    aria-label="Open checkout"
                    title="Open checkout"
                  >
                    <ExternalLink size={14} />
                  </a>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                  <span>
                    {l.useCount} payment{l.useCount === 1 ? '' : 's'} started
                    {l.maxUses !== null && <> of {l.maxUses}</>}
                  </span>
                  <span>Created {formatDate(l.createdAt)}</span>
                  {disabled && (
                    <span className="rounded bg-slate-200 px-1.5 py-0.5 font-medium text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                      disabled
                    </span>
                  )}
                  {!disabled && usedUp && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                      used up
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ---------------- Create ---------------- */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New payment link"
        footer={
          <>
            <button
              className="btn-secondary"
              onClick={() => setCreateOpen(false)}
              disabled={create.isPending}
            >
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={() => create.mutate()}
              disabled={create.isPending || !title.trim()}
            >
              {create.isPending ? <Spinner size={16} /> : 'Create link'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="label" htmlFor="link-title">
              What is this for?
            </label>
            <input
              id="link-title"
              className="input"
              placeholder="Ethiopia Yirgacheffe 250g"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
            />
            <p className="mt-1 text-xs text-slate-500">
              Shown to the customer on the checkout page.
            </p>
          </div>

          <div>
            <label className="label" htmlFor="link-desc">
              Description <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input
              id="link-desc"
              className="input"
              placeholder="Single origin, light roast"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
            />
          </div>

          <div>
            <label className="label" htmlFor="link-amount">
              Amount <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input
              id="link-amount"
              className="input num"
              inputMode="decimal"
              placeholder="Leave empty to let the customer choose"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <p className="mt-1 text-xs text-slate-500">
              A fixed amount cannot be changed by the customer. Leave it empty for
              tips or donations.
            </p>
          </div>

          <label className="flex items-start gap-2.5 text-sm text-slate-600 dark:text-slate-400">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-800"
              checked={pinAsset}
              onChange={(e) => setPinAsset(e.target.checked)}
            />
            <span>
              Accept one specific coin only
              <span className="mt-0.5 block text-xs text-slate-500">
                Otherwise the customer picks from everything you accept.
              </span>
            </span>
          </label>

          {pinAsset && (
            <AssetPicker network={network} value={asset} onChange={setAsset} />
          )}

          <label className="flex items-start gap-2.5 text-sm text-slate-600 dark:text-slate-400">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-800"
              checked={singleUse}
              onChange={(e) => setSingleUse(e.target.checked)}
            />
            <span>
              Single use
              <span className="mt-0.5 block text-xs text-slate-500">
                For an invoice to one customer. The link stops working after one
                payment is started.
              </span>
            </span>
          </label>

          {create.isError && (
            <p className="text-sm text-red-600">{errorMessage(create.error)}</p>
          )}
        </div>
      </Modal>

      {/* ---------------- QR ---------------- */}
      <Modal open={Boolean(qrFor)} onClose={() => setQrFor(null)} title={qrFor?.title ?? ''}>
        {qrFor && (
          <div className="flex flex-col items-center gap-4">
            <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
              <QRCodeSVG value={checkoutUrl(qrFor.token)} size={200} level="M" />
            </div>
            <p className="text-center text-sm text-slate-500">
              Point a phone camera at this to open the checkout. Useful for a
              counter, an invoice or a poster.
            </p>
            <div className="flex w-full items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/60">
              <code className="min-w-0 flex-1 truncate font-mono text-xs">
                {checkoutUrl(qrFor.token)}
              </code>
              <CopyButton value={checkoutUrl(qrFor.token)} />
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

/** Drop trailing zeros from a NUMERIC(38,18) string. */
function trim(v: string): string {
  if (!v.includes('.')) return v;
  return v.replace(/0+$/, '').replace(/\.$/, '') || '0';
}
