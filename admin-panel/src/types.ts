// ---------------------------------------------------------------------------
// Domain types — mirror the gateway API/DB (see docs/openapi.yaml + architecture.md)
// ---------------------------------------------------------------------------

export type Role = 'super_admin' | 'ops';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  name?: string;
}

/**
 * A login has three possible outcomes; exactly one shape arrives.
 *
 *   mfaRequired      collect a TOTP and resubmit
 *   approvalRequired the password was right; an email has gone to the account
 *                    and the session is waiting on it. `challenge` is this
 *                    browser's claim on that pending request and must never
 *                    leave the tab.
 *   tokens           only when login approval is disabled server-side
 */
export interface LoginResponse {
  accessToken?: string;
  refreshToken?: string;
  mfaRequired?: boolean;
  user?: AuthUser;

  approvalRequired?: boolean;
  challenge?: string;
  expiresAt?: string;
  /** "a****n@example.com" — which inbox to open, without printing the address. */
  sentTo?: string;
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

// ---- Clients ----
export type ClientStatus = 'pending' | 'active' | 'suspended' | 'rejected';

/** How the merchant got onto the gateway. */
export type SignupSource = 'admin' | 'self';

export interface Client {
  id: string;
  name: string;
  email: string;
  status: ClientStatus;
  /**
   * 'self' — the merchant registered through the public panel and was approved
   * by verifying their email. No operator action was needed, so these appear
   * already active; the badge exists so you can still tell them apart.
   */
  signupSource?: SignupSource;
  emailVerified?: boolean;
  websiteUrl?: string | null;
  country?: string | null;
  apiKey: string;
  // Only ever returned once, immediately after creation/regeneration.
  apiSecret?: string;
  // Only ever returned once, immediately after creation (auto-generated password).
  temporaryPassword?: string;
  webhookUrl?: string | null;
  payoutWallet?: string | null;
  /** TRC20 (T…) settlement address; null = merchant does not take TRC20 payouts. */
  payoutWalletTrc20?: string | null;
  commission?: Commission | null;
  volume?: string;
  pendingBalance?: string;
  availableBalance?: string;
  createdAt: string;
  updatedAt?: string;
}

export type ClientAction =
  | 'approve'
  | 'suspend'
  | 'regenerate_keys'
  | 'update'
  | 'set_password';

export interface CreateClientInput {
  name: string;
  email: string;
  webhookUrl?: string;
  payoutWallet?: string;
  payoutWalletTrc20?: string;
  // Optional — when omitted the backend auto-generates a temporary password.
  password?: string;
}

export interface UpdateClientInput {
  action: ClientAction;
  name?: string;
  email?: string;
  webhookUrl?: string;
  payoutWallet?: string;
  payoutWalletTrc20?: string;
  // Used with action: 'set_password'.
  password?: string;
}

// ---- Commission (versioned per client) ----
export type CommissionType = 'percentage' | 'fixed' | 'tiered';
export type FeePayer = 'client' | 'admin';

// A single slab in a tiered commission. maxAmount === null means unbounded (∞);
// only the last tier may be unbounded.
export interface CommissionTier {
  minAmount: string;
  maxAmount: string | null;
  type: 'fixed' | 'percentage';
  value: string;
}

export interface Commission {
  id?: string;
  clientId: string;
  type: CommissionType;
  // For percentage: e.g. "1.5" means 1.5%. For fixed: flat USDT amount.
  // Unused (may be empty) when type === 'tiered'.
  value: string;
  // Present only when type === 'tiered'.
  tiers?: CommissionTier[] | null;
  feePayer: FeePayer;
  /**
   * Denomination of the AMOUNTS in this commission — the fixed value and every
   * tier bound. Null on a percentage rate, which has none. Settlement now
   * REFUSES an amount-denominated commission whose asset is not the one being
   * settled, so this is the field that explains a skipped payout.
   */
  asset?: string | null;
  /** Chain this commission is scoped to. Null = every chain. */
  network?: string | null;
  note?: string;
  version?: number;
  createdAt?: string;
  createdBy?: string;
}

export interface SetCommissionInput {
  clientId: string;
  type: CommissionType;
  // Omit for tiered; required for percentage/fixed.
  value?: string;
  // Provide for tiered.
  tiers?: CommissionTier[];
  feePayer: FeePayer;
  /**
   * Denomination for a fixed/tiered commission. Omitted -> USDT, which is what
   * a bare number always meant. On a deployment that does not settle USDT this
   * must be set, or every amount-denominated fee is rejected at settlement.
   */
  asset?: string;
  /** Restrict this commission to one chain. Omitted -> every chain. */
  network?: string;
  note?: string;
}

// ---- Payments ----
export type PaymentStatus =
  | 'waiting'
  | 'confirming'
  | 'confirmed'
  | 'partial'
  | 'failed'
  | 'expired'
  | 'swept';

export interface Payment {
  paymentId: string;
  orderId: string;
  clientId?: string;
  clientName?: string;
  amount: string;
  amountReceived: string;
  currency: string; // USDT
  network: string; // BEP20
  address: string;
  qrCode?: string;
  status: PaymentStatus;
  confirmations: number;
  txHash?: string | null;
  expiresAt: string;
  createdAt: string;
}

// ---- Transactions (admin global monitoring) ----
export type TransactionType = 'deposit' | 'sweep' | 'payout' | 'commission';

export interface Transaction {
  id: string;
  paymentId?: string;
  clientId?: string;
  clientName?: string;
  type: TransactionType;
  status: PaymentStatus | PayoutStatus;
  amount: string;
  currency: string;
  network: string;
  fromAddress?: string;
  toAddress?: string;
  txHash?: string | null;
  confirmations?: number;
  createdAt: string;
}

// ---- Payouts ----
/**
 * `unresolved` is passed through from the backend untouched (mapPayoutStatusAdmin
 * only rewrites pending/confirmed). It means the broadcast threw and nobody
 * knows whether the transaction landed: the merchant's balance stays reserved,
 * no automation will touch the row again, and an operator must check the
 * explorer and settle it by hand. Omitting it from this union did not hide the
 * row — the API still returned it — it just left the one payout state that needs
 * a person outside the type that describes payout states.
 */
export type PayoutStatus = 'queued' | 'processing' | 'sent' | 'failed' | 'unresolved';

export interface Payout {
  id: string;
  clientId: string;
  clientName?: string;
  amount: string;
  currency: string;
  /** Chain this payout settles on. Decides the explorer link + hot wallet. */
  network?: string; // 'BEP20' (default) | 'TRC20'
  status: PayoutStatus;
  toAddress?: string;
  txHash?: string | null;
  createdAt: string;
  completedAt?: string | null;
}

export interface TriggerPayoutInput {
  clientId: string;
  amount: string;
  /** Omitted -> BEP20. TRC20 needs the merchant's payoutWalletTrc20 set. */
  network?: string;
  note?: string;
}

// ---- Webhook logs ----
export interface WebhookLog {
  id: string;
  clientId: string;
  clientName?: string;
  event: string; // e.g. payment.confirmed
  url: string;
  statusCode?: number | null;
  success: boolean;
  attempt: number;
  maxAttempts?: number;
  nextRetryAt?: string | null;
  payload?: Record<string, unknown> | string;
  response?: string | null;
  createdAt: string;
}

// ---- Commission balance / admin withdrawals ----
export interface CommissionBalance {
  /** Chain these figures pertain to. Commission is held per chain. */
  network?: string;
  /**
   * Asset these figures pertain to. A chain holds a SEPARATE pool per asset —
   * BNB commission is not spendable as USDT — so (network, asset) is the unit,
   * not network alone. Keyed on, labelled and withdrawn against as a pair.
   */
  asset?: string;
  accrued: string;
  withdrawn: string;
  available: string;
  currency: string;
  /**
   * Per-chain positions. The top-level fields above are the BEP20 ones, kept
   * for back-compat; prefer this when present.
   */
  networks?: CommissionBalance[];
}

export interface AdminWithdrawal {
  id: string;
  amount: string;
  toAddress: string;
  /** Chain this withdrawal settles on. */
  network?: string;
  /** Asset withdrawn. A chain has one pool per asset; the chain alone is ambiguous. */
  asset?: string;
  txHash: string | null;
  status: 'pending' | 'processing' | 'sent' | 'confirmed' | 'failed';
  error: string | null;
  createdAt: string;
}

// ---- Wallet balances ----

/** Legacy BEP20-only shape, still returned for back-compat. Prefer NetworkWallet. */
export interface WalletBalance {
  address: string;
  label: string; // Central / Gas station
  usdt: string;
  bnb: string;
}

/** One wallet's position on one chain. */
export interface NetworkWallet {
  address: string;
  label: string; // Central / Gas station
  usdt: string;
  /** Native balance — BNB on BEP20, TRX on TRC20. */
  native: string;
  nativeCurrency: string; // 'BNB' | 'TRX'
  /** False when this chain has no key configured for this role. */
  configured: boolean;
}

export interface NetworkBalances {
  network: string; // 'BEP20' | 'TRC20'
  feeCurrency: string;
  central: NetworkWallet;
  gas: NetworkWallet;
  /** Gas wallet is low enough that settlement on this chain is at risk. */
  lowGas: boolean;
}

export interface ClientPendingBalance {
  clientId: string;
  clientName: string;
  /** Which chain these pending funds are arriving on. */
  network?: string;
  pending: string;
  available: string;
}

export interface WalletBalancesResponse {
  /** Per-chain balances for every ENABLED network. Absent on an old API. */
  networks?: NetworkBalances[];
  /** @deprecated BEP20-only aliases kept so an older panel build still renders. */
  central: WalletBalance;
  /** @deprecated see `networks` */
  gas: WalletBalance;
  clientPending: ClientPendingBalance[];
}

// ---- Analytics ----
export interface TimeseriesPoint {
  date: string;
  volume: number;
  revenue: number;
  commission: number;
  count: number;
}

export interface ClientBreakdown {
  clientId: string;
  clientName: string;
  volume: number;
  commission: number;
}

/** Volume + revenue split by settlement chain. */
export interface NetworkBreakdown {
  network: string;
  volume: number;
  count: number;
  commission: number;
  enabled: boolean;
}

export interface Analytics {
  totalVolume: string;
  todayRevenue: string;
  totalRevenue: string;
  totalCommission: string;
  activeClients: number;
  pendingPayouts: number;
  pendingPayoutAmount?: string;
  timeseries: TimeseriesPoint[];
  clientBreakdown: ClientBreakdown[];
  /** Per-chain split. Absent when talking to an older API. */
  networkBreakdown?: NetworkBreakdown[];
}

// ---- Generic paginated envelope ----
export interface Paginated<T> {
  data: T[];
  page: number;
  total: number;
  limit?: number;
}

// ---- Filters ----
export interface TransactionFilters {
  status?: string;
  clientId?: string;
  type?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}
