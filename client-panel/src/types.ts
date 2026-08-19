// ============================================================================
// Domain types — mirror docs/openapi.yaml exactly, plus the JWT dashboard
// endpoints described in the build brief.
// ============================================================================

export type PaymentStatus =
  | 'waiting'
  | 'confirming'
  | 'confirmed'
  | 'partial'
  | 'failed'
  | 'expired'
  | 'swept';

/**
 * The frozen fiat quote on a payment that was priced in fiat.
 *
 * Present only for those; a crypto-priced payment has no `fiat` at all, which
 * is how the UI tells the two apart. `rate` and `lockedAt` are shown to the
 * merchant deliberately — "why is this 52.58 USDT" must be answerable from the
 * page rather than from a support ticket.
 */
export interface FiatQuote {
  currency: string;
  amount: string;
  rate: string;
  /** 'coingecko' | 'coingecko:stale' — a stale quote is legitimate but visible. */
  source: string | null;
  lockedAt: string | null;
}

export interface Payment {
  paymentId: string;
  orderId: string;
  amount: string;
  amountReceived: string;
  currency: string; // e.g. USDT
  /** Ledger asset; always equal to `currency`. */
  asset?: string;
  network: string; // BEP20
  address: string;
  qrCode?: string; // base64 data URI (optional; we can render client-side too)
  status: PaymentStatus;
  confirmations: number;
  txHash: string | null;
  expiresAt: string; // ISO date-time
  createdAt: string; // ISO date-time
  description?: string;
  /** Set only when the payment was priced in fiat. */
  fiat?: FiatQuote;
}

export interface CreatePaymentInput {
  /** Crypto amount. Mutually exclusive with fiatAmount — the API rejects both. */
  amount?: string;
  /** Price in fiat instead; the crypto amount is quoted and locked server-side. */
  fiatAmount?: string;
  fiatCurrency?: string;
  orderId: string;
  description?: string;
  network?: string; // 'BEP20' (default) | 'TRC20'
  asset?: string;   // 'USDT' (default); must be enabled on `network`
}

// ---- Exchange rates ----
/** GET /rates. `rates[FIAT][SYMBOL]` = price of one SYMBOL in FIAT. */
export interface RatesResponse {
  rates: Record<string, Record<string, string>>;
  currencies: string[];
  /** 'coingecko' | 'coingecko:stale'. */
  source: string;
  ageSeconds: number;
  fetchedAt: string;
}

// ---- Assets ----
/** One settleable (network, symbol) pair, from GET /assets. */
export interface AssetInfo {
  symbol: string;
  network: string;
  name: string;
  decimals: number;
  minAmount: string;
  /**
   * True for the chain's own coin (BNB, TRX) rather than a token on it.
   * Matters to the customer: there is no contract address to check, and sending
   * from an exchange means picking the right withdrawal network.
   */
  isNative?: boolean;
}

/** One row of GET /balance?all=true. */
export interface AssetBalance {
  network: string;
  asset: string;
  available: string;
  pending: string;
}

export interface Paginated<T> {
  data: T[];
  page: number;
  total: number;
}

export interface PaymentListParams {
  status?: PaymentStatus | '';
  page?: number;
  limit?: number;
}

export interface Balance {
  available: string;
  pending: string;
  currency: string; // USDT
}

// ---- Auth ----
export interface LoginInput {
  email: string;
  password: string;
  mfaToken?: string;
}

/**
 * A login now has THREE possible outcomes, and the fields are optional because
 * exactly one shape arrives:
 *
 *   mfaRequired      collect a TOTP and resubmit
 *   approvalRequired the password was right; an email has gone to the account
 *                    and the session is waiting on it. `challenge` is this
 *                    browser's claim on that pending request — it is the only
 *                    thing that can collect the session, and it must never
 *                    leave this tab.
 *   tokens           only when login approval is disabled server-side
 */
export interface LoginResponse {
  accessToken?: string;
  refreshToken?: string;
  mfaRequired?: boolean;
  /** false for a self-registered merchant who has not clicked the email link. */
  emailVerified?: boolean;
  /** 'pending' until the email is verified; 'approved' once it is. */
  clientStatus?: string | null;

  approvalRequired?: boolean;
  challenge?: string;
  expiresAt?: string;
  /** "d****w@example.com" — which inbox to open, without printing the address. */
  sentTo?: string;
}

/**
 * A session that is GUARANTEED to exist. `/auth/verify-email` signs the merchant
 * in as part of confirming their address and always returns a pair, so it keeps
 * required fields rather than inheriting LoginResponse's optional ones — the
 * call site should not have to assert what the route promises.
 *
 * Login approval does not apply there: clicking a link in a verification email
 * already proves control of the mailbox, which is the same thing an approval
 * asks for. Requiring a second email would be asking the same question twice.
 */
export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  emailVerified?: boolean;
  clientStatus?: string | null;
}

/** One signed-in device. A session is a refresh-token family, server-side. */
export interface SessionInfo {
  id: string;
  device: string | null;
  deviceKind: string | null;
  ip: string | null;
  signedInAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  /** True for the device making the request — never offered a bare "sign out". */
  current: boolean;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'consumed' | 'expired';

/** The poll response. Carries the session on the one poll that finds it. */
export interface CollectResponse extends LoginResponse {
  status?: ApprovalStatus;
}

/** What the approval page renders — deliberately says nothing about the account. */
export interface ApprovalRequest {
  status: ApprovalStatus;
  device: string | null;
  deviceKind: string | null;
  ip: string | null;
  panel: string | null;
  requestedAt: string;
  expiresAt: string;
}

// ---- Self-registration ----
export interface RegisterInput {
  email: string;
  password: string;
  businessName: string;
  websiteUrl?: string;
  country?: string;
}

/**
 * Deliberately uninformative: the API answers identically whether or not the
 * address was already registered, so the UI must not try to infer anything.
 */
export interface AcceptedResponse {
  success: boolean;
  message: string;
}

// ---- Payment links / hosted checkout ----
export interface PaymentLink {
  id: string;
  token: string;
  title: string;
  description: string | null;
  amount: string | null;   // null = customer enters the amount
  /** Set instead of `amount` on a fiat-priced link (every invoice link). */
  fiatAmount: string | null;
  fiatCurrency: string | null;
  asset: string | null;    // null = customer chooses
  network: string | null;
  reusable: boolean;
  maxUses: number | null;
  useCount: number;
  expiresAt: string | null;
  status: 'active' | 'disabled';
  createdAt: string;
}

export interface CreatePaymentLinkInput {
  title: string;
  description?: string;
  amount?: string;
  fiatAmount?: string;
  fiatCurrency?: string;
  asset?: string;
  network?: string;
  reusable?: boolean;
  maxUses?: number;
  expiresAt?: string;
}

/**
 * The PUBLIC view of a link — everything the checkout page is allowed to know.
 * Notably absent: any merchant identifier, wallet, or balance.
 */
export interface PublicLink {
  token: string;
  title: string;
  description: string | null;
  merchantName: string;
  amount: string | null;
  /** Fiat price, when the link is priced that way. */
  fiatAmount: string | null;
  fiatCurrency: string | null;
  /** True when this link is an invoice's pay page — fetch the document too. */
  hasInvoice: boolean;
  asset: string | null;
  network: string | null;
  options: Array<{
    symbol: string;
    network: string;
    name: string;
    /** The chain's own coin rather than a token on it — the checkout warns. */
    isNative?: boolean;
  }>;
  expiresAt: string | null;
  usable: boolean;
  unusableReason: string | null;
}

/**
 * The PUBLIC view of an invoice, from GET /pay/:token/invoice.
 * Same rule as PublicLink: this is the entire list of what the customer sees.
 */
export interface PublicInvoice {
  number: string;
  merchantName: string;
  customerName: string | null;
  currency: string;
  subtotal: string;
  taxAmount: string;
  total: string;
  notes: string | null;
  dueDate: string | null;
  status: string;
  overdue: boolean;
  issuedAt: string | null;
  items: Array<{
    description: string;
    quantity: string;
    unitPrice: string;
    amount: string;
  }>;
}

/** What POST /pay/:token/payments returns. */
export interface CheckoutPayment {
  paymentId: string;
  amount: string;
  asset: string;
  network: string;
  address: string;
  qrCode?: string;
  status: PaymentStatus;
  expiresAt: string;
  /** The locked quote, when the link was priced in fiat. */
  fiat?: FiatQuote;
}

/** What the public status poll returns. */
export interface CheckoutStatus {
  paymentId: string;
  status: PaymentStatus;
  amount: string;
  amountReceived: string;
  asset: string;
  network: string;
  address: string;
  confirmations: number;
  requiredConfirmations: number;
  txHash: string | null;
  expiresAt: string;
}

// ---- Invoices ----
export interface InvoiceItem {
  id: string;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
}

export interface Invoice {
  id: string;
  number: string;
  customerName: string | null;
  customerEmail: string | null;
  /** Fiat code — an invoice is always a fiat document. */
  currency: string;
  subtotal: string;
  taxAmount: string;
  total: string;
  notes: string | null;
  dueDate: string | null;
  status: 'draft' | 'open' | 'paid' | 'void';
  /** Derived server-side from due_date; never a stored status. */
  overdue: boolean;
  asset: string | null;
  network: string | null;
  /** The pay link's token. Null while the invoice is a draft. */
  token: string | null;
  paymentId: string | null;
  subscriptionId: string | null;
  cycleNumber: number | null;
  issuedAt: string | null;
  sentAt: string | null;
  paidAt: string | null;
  createdAt: string;
  /** Empty in list responses — fetched with the single-invoice endpoint. */
  items: InvoiceItem[];
}

export interface CreateInvoiceInput {
  currency: string;
  items: Array<{ description: string; quantity?: string; unitPrice: string }>;
  customerName?: string;
  customerEmail?: string;
  notes?: string;
  dueDate?: string;
  taxAmount?: string;
  asset?: string;
  network?: string;
  issue?: boolean;
}

// ---- Subscriptions (recurring billing) ----
export type IntervalUnit = 'day' | 'week' | 'month' | 'year';

export interface Subscription {
  id: string;
  title: string;
  description: string | null;
  customerName: string | null;
  customerEmail: string | null;
  currency: string;
  amount: string;
  asset: string | null;
  network: string | null;
  intervalUnit: IntervalUnit;
  intervalCount: number;
  /** 'needs_attention' means it fell too far behind to catch up safely. */
  status: 'active' | 'paused' | 'canceled' | 'needs_attention';
  nextRunAt: string;
  totalCycles: number | null;
  cyclesBilled: number;
  dueDays: number;
  autoSend: boolean;
  lastInvoiceId: string | null;
  lastRunAt: string | null;
  createdAt: string;
}

export interface CreateSubscriptionInput {
  title: string;
  description?: string;
  amount: string;
  currency: string;
  intervalUnit: IntervalUnit;
  intervalCount?: number;
  customerName?: string;
  customerEmail?: string;
  asset?: string;
  network?: string;
  startAt?: string;
  totalCycles?: number;
  dueDays?: number;
  autoSend?: boolean;
}

/** One row of GET /subscriptions/:id/invoices — the billing history. */
export interface SubscriptionInvoice {
  id: string;
  number: string;
  total: string;
  currency: string;
  status: string;
  cycle_number: number;
  due_date: string | null;
  issued_at: string | null;
  paid_at: string | null;
  token: string | null;
}

// ---- Unexpected deposits (wrong asset / late payment) ----
export interface UnexpectedDeposit {
  id: string;
  network: string;
  /** What actually arrived. */
  asset: string;
  amount: string;
  /** What the payment was waiting for. Equal to `asset` = a LATE payment. */
  expectedAsset: string | null;
  status: 'detected' | 'sweeping' | 'swept' | 'converting' | 'converted' | 'failed';
  txHash: string;
  depositAddress: string;
  convertedTo: string | null;
  convertedAmount: string | null;
  error: string | null;
  createdAt: string;
}

// ---- Payouts ----
export type PayoutStatus =
  | 'queued'
  | 'processing'
  | 'sent'
  | 'confirmed'
  // The broadcast threw and it is unknown whether the transaction reached the
  // chain. mapPayoutStatusClient passes it through, so a merchant can see it.
  // It holds the reservation like `sent` and only an operator clears it.
  | 'unresolved'
  | 'failed';

export interface Payout {
  payoutId: string;
  amount: string;
  currency: string;
  /** Asset settled. Balances never cross assets. */
  asset?: string;
  /** Chain this payout settled on. Decides the explorer link. */
  network?: string; // 'BEP20' (default) | 'TRC20'
  status: PayoutStatus;
  wallet: string;
  txHash: string | null;
  createdAt: string;
}

export interface CreatePayoutInput {
  amount: string;
  /** Omitted -> BEP20. TRC20 requires a configured TRC20 payout wallet. */
  network?: string;
  /** Omitted -> USDT. Can only draw on the balance of this same asset. */
  asset?: string;
}

// ---- Account: API keys ----
export interface ApiKeyInfo {
  apiKey: string; // public key id (safe to display)
  createdAt: string;
  lastUsedAt?: string | null;
  // secret is only ever returned by the regenerate endpoint, once.
}

/**
 * How a key authenticates.
 *   'hmac'   — public id + a secret used to sign every request. Stronger: the
 *              secret never crosses the wire.
 *   'simple' — one opaque bearer token in X-Api-Key. Easier to adopt, but the
 *              credential is on the wire every call, so the server refuses to
 *              grant it 'payouts:write'.
 */
export type ApiKeyAuthMode = 'hmac' | 'simple';

export type ApiScope = 'payments:read' | 'payments:write' | 'payouts:write';

export interface ApiKeySummary {
  id: string;
  apiKey: string; // public id, or a masked prefix for bearer keys
  label: string | null;
  authMode: ApiKeyAuthMode;
  scopes: ApiScope[];
  status: 'active' | 'revoked';
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreateApiKeyInput {
  label: string;
  authMode: ApiKeyAuthMode;
  scopes?: ApiScope[];
}

/** The ONLY time apiSecret is ever returned. */
export interface CreatedApiKey {
  id: string;
  apiKey: string;
  apiSecret: string;
  authMode: ApiKeyAuthMode;
  scopes: ApiScope[];
  createdAt: string;
}

export interface RegenerateApiKeyResponse {
  apiKey: string;
  apiSecret: string; // shown ONCE
  createdAt: string;
}

// ---- Account: settings ----
export interface AccountSettings {
  webhookUrl: string | null;
  payoutWallet: string | null; // BEP20 (0x…) address
  payoutWalletTrc20?: string | null; // TRC20 (T…) address; null = TRC20 payouts off
  /** Empty = no IP restriction. Non-empty is enforced on every API request. */
  ipWhitelist?: string[];
  webhookSecretSet?: boolean; // true when a webhook signing secret exists
}

export type UpdateAccountSettings = Partial<
  Pick<
    AccountSettings,
    'webhookUrl' | 'payoutWallet' | 'payoutWalletTrc20' | 'ipWhitelist'
  >
>;

// ---- Account: onboarding checklist ----
export interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  done: boolean;
  href: string | null;
  required: boolean;
}

export interface OnboardingState {
  steps: OnboardingStep[];
  complete: boolean;
  completedRequired: number;
  totalRequired: number;
  warnings: {
    simpleKeyWithoutIpAllowlist: boolean;
  };
}

// ---- Account: commission ----
export interface CommissionTier {
  minAmount: string;
  maxAmount: string | null;
  type: 'fixed' | 'percentage';
  value: string;
}

export interface Commission {
  type?: 'percentage' | 'fixed' | 'tiered';
  percent: string; // e.g. "1.5" meaning 1.5%
  fixedFee?: string; // optional flat fee per tx, in USDT
  tiers?: CommissionTier[];
  networkFeePaidBy: 'client' | 'admin';
  currency: string;
  effectiveFrom: string;
}

// ---- Account: change password ----
export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

// ---- Account: webhook logs ----
export type WebhookDeliveryStatus = 'success' | 'failed' | 'pending';

export interface WebhookLog {
  id: string;
  event: string; // e.g. payment.confirmed
  paymentId?: string;
  url: string;
  status: WebhookDeliveryStatus;
  httpStatus: number | null;
  attempt: number;
  maxAttempts: number;
  requestBody: string; // raw JSON string sent
  responseBody?: string | null;
  createdAt: string;
  nextRetryAt?: string | null;
}

// ---- Account: analytics ----

/**
 * GET /account/analytics.
 *
 * Amounts are STRINGS because they are numeric(38,18) server-side; parsing them
 * into a JS number is fine for a chart axis and wrong for anything the merchant
 * reconciles against.
 */
export interface AnalyticsBucket {
  date: string; // YYYY-MM-DD
  volume: string;
  count: number;
}

/** One (network, asset) pair. Never sum across these — see AnalyticsTotals. */
export interface AnalyticsAssetRow {
  network: string;
  asset: string;
  count: number;
  volume: string;
}

export interface AnalyticsTotals {
  /**
   * Convenience sum ACROSS assets. Named `Approx` deliberately: it is not a
   * balance and is not withdrawable, because (network, asset) balances are not
   * fungible. `byAsset` is the authoritative breakdown and
   * `getAllBalances()` is the withdrawable figure.
   */
  settledVolumeApprox: string;
  settledCount: number;
  inFlightCount: number;
  inFlightAmountApprox: string;
  failedCount: number;
  expiredCount: number;
  partialCount: number;
  successRate: number;
  previousSettledVolumeApprox: string;
  /** null when there is no prior period to compare against — not 0. */
  volumeChangePct: number | null;
}

export interface Analytics {
  range: { days: number; from: string; to: string };
  totals: AnalyticsTotals;
  byStatus: { status: PaymentStatus; count: number }[];
  byAsset: AnalyticsAssetRow[];
  timeseries: AnalyticsBucket[];
}
