import { useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Ban,
  ExternalLink,
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
import { formatDateShort } from '@/lib/format';
import type { PaymentLink } from '@/types';
import PageHeader from '@/components/PageHeader';
import DataTable, { type Column } from '@/components/DataTable';
import Badge from '@/components/Badge';
import CopyButton from '@/components/CopyButton';
import Modal from '@/components/Modal';
import Spinner from '@/components/Spinner';
import AssetPicker from '@/components/AssetPicker';

/**
 * Payment links — share a URL, get paid. No integration required.
 *
 * SET AS A LEDGER, NOT A CARD GRID. The previous version gave every link its
 * own rounded, bordered, shadowed panel in a two-up grid, on the argument that
 * a merchant is here to copy one URL. That argument survives — the URL and its
 * copy control still lead the row — but the grid did not: a merchant with
 * thirty links got thirty boxes and no way to scan down a single column, and
 * the enclosure cost 20px of padding on four sides of each one to say something
 * a hairline says for nothing. Ruled rows keep the copy affordance and give
 * back the comparison the grid never allowed.
 *
 * Links are DISABLED, never deleted: the URL may already be sitting in a
 * customer's inbox, and a disabled link can explain itself where a 404 cannot.
 *
 * TWO THINGS THE OLD PAGE GOT WRONG ABOUT ITS OWN DATA, both fixed here:
 *
 *  - A FIAT-PRICED LINK read as an open-amount link. Invoice links (and any
 *    link created with `fiatAmount`) carry `fiatAmount`/`fiatCurrency` and a
 *    null `amount`, and the page rendered "Customer enters the amount" for
 *    them — telling a merchant their fixed ₹4,999 invoice let the customer type
 *    any number they liked.
 *  - AN EXPIRED LINK read as live. `expiresAt` was never rendered and never
 *    consulted, so a link whose expiry had passed still showed as active while
 *    the checkout it points at is a dead end.
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

  const rows = links.data ?? [];
  const liveCount = rows.filter((l) => linkState(l) === 'live').length;

  /** QR + enable/disable, shared by the table row and the stacked mobile row. */
  const rowActions = (l: PaymentLink) => (
    <div className="inline-flex items-center gap-0.5">
      <IconAction label="Show QR code" onClick={() => setQrFor(l)}>
        <QrCode size={16} />
      </IconAction>
      <IconAction
        label={l.status === 'active' ? `Disable ${l.title}` : `Enable ${l.title}`}
        onClick={() => toggle.mutate(l)}
      >
        {l.status === 'active' ? <Ban size={16} /> : <RotateCcw size={16} />}
      </IconAction>
    </div>
  );

  /** The URL and the one action a merchant came here to take. */
  const urlCell = (l: PaymentLink, className = 'max-w-[20ch] lg:max-w-[30ch]') => {
    const url = checkoutUrl(l.token);
    return (
      <div className="flex items-center gap-0.5">
        <code
          className={`min-w-0 truncate font-mono text-xs text-slate-600 dark:text-slate-400 ${className}`}
        >
          {url}
        </code>
        <CopyButton value={url} />
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded p-1 text-slate-400 outline-none transition-colors duration-100 hover:text-brand-600 focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:text-brand-400"
          aria-label={`Open checkout for ${l.title}`}
          title="Open checkout"
        >
          <ExternalLink size={14} />
        </a>
      </div>
    );
  };

  const columns: Column<PaymentLink>[] = [
    {
      key: 'link',
      header: 'Link',
      sortValue: (l) => l.title.toLowerCase(),
      render: (l) => (
        <div className="min-w-0 max-w-[28ch]">
          <div className="truncate font-medium text-slate-900 dark:text-slate-100">
            {l.title}
          </div>
          <div className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
            {priceLabel(l)}
          </div>
        </div>
      ),
    },
    {
      key: 'url',
      header: 'Checkout URL',
      hideOnMobile: true,
      render: (l) => urlCell(l),
    },
    {
      key: 'uses',
      header: 'Payments started',
      numeric: true,
      hideOnMobile: true,
      sortValue: (l) => l.useCount,
      render: (l) => (
        <>
          {l.useCount}
          {l.maxUses !== null && (
            <span className="text-slate-500 dark:text-slate-400"> / {l.maxUses}</span>
          )}
        </>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      hideOnMobile: true,
      sortValue: (l) => l.createdAt,
      render: (l) => (
        <span className="num whitespace-nowrap text-slate-500 dark:text-slate-400">
          {formatDateShort(l.createdAt)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (l) => linkState(l),
      render: (l) => <LinkStateBadge link={l} />,
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: rowActions,
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Payments"
        title="Payment links"
        description="Share a link, get paid. Your customer picks a coin and pays — no integration needed."
        actions={
          <button className="btn-primary" onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> New link
          </button>
        }
        meta={
          rows.length > 0 ? (
            <>
              {rows.length} link{rows.length === 1 ? '' : 's'} · {liveCount} live
            </>
          ) : undefined
        }
      />

      {/* A failed enable/disable used to vanish silently, leaving the row
          showing the state the merchant had just tried to change. */}
      {toggle.isError && (
        <p
          role="alert"
          className="mb-4 inline-flex items-start gap-1.5 text-sm text-red-600 dark:text-red-400"
        >
          <AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden />
          <span>Could not change that link: {errorMessage(toggle.error)}</span>
        </p>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(l) => l.id}
        loading={links.isLoading}
        error={links.isError ? errorMessage(links.error) : null}
        onRetry={() => links.refetch()}
        defaultSortKey="created"
        defaultSortDir="desc"
        label="Payment links"
        emptyLabel="No payment links yet."
        emptyHint="Create one and send the URL to a customer. They open it, choose a coin and pay — you don't need to write any code."
        emptyAction={
          <button className="btn-primary" onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> Create your first link
          </button>
        }
        renderMobile={(l) => (
          <div className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-medium text-slate-900 dark:text-slate-100">
                  {l.title}
                </div>
                <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {priceLabel(l)}
                </div>
              </div>
              <LinkStateBadge link={l} />
            </div>
            <div className="flex items-center justify-between gap-2">
              {urlCell(l, 'max-w-[24ch]')}
              {rowActions(l)}
            </div>
            <div className="num text-xs text-slate-500 dark:text-slate-400">
              {l.useCount} started
              {l.maxUses !== null ? ` of ${l.maxUses}` : ''} · created{' '}
              {formatDateShort(l.createdAt)}
            </div>
          </div>
        )}
      />

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
        {/* Ruled rows, same as every field group in the product. */}
        <div className="divide-y divide-slate-200 dark:divide-slate-800">
          <ModalField id="link-title" label="What is this for?" hint="Shown to the customer on the checkout page.">
            <input
              id="link-title"
              className="input"
              placeholder="Ethiopia Yirgacheffe 250g"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              aria-describedby="link-title-hint"
            />
          </ModalField>

          <ModalField
            id="link-desc"
            label={
              <>
                Description <span className="font-normal text-slate-400">(optional)</span>
              </>
            }
          >
            <input
              id="link-desc"
              className="input"
              placeholder="Single origin, light roast"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
            />
          </ModalField>

          <ModalField
            id="link-amount"
            label={
              <>
                Amount <span className="font-normal text-slate-400">(optional)</span>
              </>
            }
            hint="A fixed amount cannot be changed by the customer. Leave it empty for tips or donations."
          >
            <input
              id="link-amount"
              className="input num"
              inputMode="decimal"
              placeholder="Leave empty to let the customer choose"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-describedby="link-amount-hint"
            />
          </ModalField>

          <div className="py-4 first:pt-0 last:pb-0">
            <CheckboxRow
              checked={pinAsset}
              onChange={setPinAsset}
              label="Accept one specific coin only"
              hint="Otherwise the customer picks from everything you accept."
            />
            {pinAsset && (
              <div className="mt-4">
                <AssetPicker network={network} value={asset} onChange={setAsset} />
              </div>
            )}
          </div>

          <div className="py-4 first:pt-0 last:pb-0">
            <CheckboxRow
              checked={singleUse}
              onChange={setSingleUse}
              label="Single use"
              hint="For an invoice to one customer. The link stops working after one payment is started."
            />
          </div>
        </div>

        {create.isError && (
          <p
            role="alert"
            className="mt-4 inline-flex items-start gap-1.5 text-sm text-red-600 dark:text-red-400"
          >
            <AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden />
            <span>{errorMessage(create.error)}</span>
          </p>
        )}
      </Modal>

      {/* ---------------- QR ---------------- */}
      <Modal open={Boolean(qrFor)} onClose={() => setQrFor(null)} title={qrFor?.title ?? ''}>
        {qrFor && (
          <div className="flex flex-col items-center gap-5">
            {/* White ground is not a style choice — a QR needs the contrast to
                be read by a camera, in either theme. */}
            <div className="rounded-lg bg-white p-4 ring-1 ring-slate-200">
              <QRCodeSVG value={checkoutUrl(qrFor.token)} size={200} level="M" />
            </div>
            <p className="measure text-center text-sm leading-relaxed text-slate-500 dark:text-slate-400">
              Point a phone camera at this to open the checkout. Useful for a
              counter, an invoice or a poster.
            </p>
            <div className="rule flex w-full items-center gap-1 pt-3">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600 dark:text-slate-400">
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

/* =====================================================================
   Link state — a WORD first, a colour second.

   Four outcomes, and only one of them means the URL still works. `live` takes
   emerald because a working link is healthy, the same reading the public site
   gives a live settlement network; everything else is archival and takes slate,
   because none of the three is "waiting on someone" and amber would say it was.
   The word is what distinguishes them, which is what makes the row survive
   greyscale and a red/green-blind reader.
   ===================================================================== */

type LinkState = 'live' | 'disabled' | 'expired' | 'used up';

function linkState(l: PaymentLink): LinkState {
  if (l.status !== 'active') return 'disabled';
  // Never rendered before, so a link past its expiry showed as active while the
  // checkout it points at refuses to start a payment.
  if (l.expiresAt && new Date(l.expiresAt).getTime() <= Date.now()) return 'expired';
  if (l.maxUses !== null && l.useCount >= l.maxUses) return 'used up';
  return 'live';
}

function LinkStateBadge({ link }: { link: PaymentLink }) {
  const state = linkState(link);
  return (
    <Badge tone={state === 'live' ? 'settled' : 'neutral'} dot>
      {state}
    </Badge>
  );
}

/* =====================================================================
   Price label.

   A link has exactly ONE price: a crypto amount, a fiat amount, or none at all
   (the customer types one). ASSET AND NETWORK ARE NEVER NAMED APART — an
   address is only valid on the chain it was issued on — so the pair is either
   stated together or not at all.
   ===================================================================== */

function pairLabel(l: PaymentLink): string {
  return l.asset && l.network ? `${l.asset} · ${l.network}` : 'customer picks the coin';
}

function priceLabel(l: PaymentLink): string {
  // Fiat-priced links (every invoice link) carry fiatAmount and a null amount.
  if (l.fiatAmount && l.fiatCurrency) {
    return `${trim(l.fiatAmount)} ${l.fiatCurrency} · converted to crypto at checkout`;
  }
  if (l.amount) {
    // Only name the asset when the link pins one — "250 any coin" reads as a
    // unit, not as a choice.
    return l.asset && l.network
      ? `${trim(l.amount)} ${l.asset} · ${l.network}`
      : `${trim(l.amount)} · ${pairLabel(l)}`;
  }
  return `Customer enters the amount · ${pairLabel(l)}`;
}

/** A quiet icon control. Ink change only — nothing travels, nothing loops. */
function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded p-1.5 text-slate-400 outline-none transition-colors duration-100 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:text-slate-100"
    >
      {children}
    </button>
  );
}

/** One ruled field row inside the create sheet. */
function ModalField({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <label className="label mb-0" htmlFor={id}>
        {label}
      </label>
      {hint && (
        <p
          id={`${id}-hint`}
          className="measure mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400"
        >
          {hint}
        </p>
      )}
      <div className="mt-2">{children}</div>
    </div>
  );
}

/** A checkbox row: the control, the claim, and the consequence underneath it. */
function CheckboxRow({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex items-start gap-2.5 text-sm text-slate-700 dark:text-slate-300">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-800"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        <span className="measure mt-0.5 block text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          {hint}
        </span>
      </span>
    </label>
  );
}

/** Drop trailing zeros from a NUMERIC(38,18) string. */
function trim(v: string): string {
  if (!v.includes('.')) return v;
  return v.replace(/0+$/, '').replace(/\.$/, '') || '0';
}
