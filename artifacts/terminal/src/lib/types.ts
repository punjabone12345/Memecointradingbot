export interface Settings {
  botEnabled: boolean;
  startingBalanceSol: number;
  currentBalanceSol: number;
  rpcEndpoint: string;
  slippagePct: number;
  priorityFeeSol: number;
  walletPublicKey: string;
  sniperSlippagePct: number;
  sniperStagnationPct: number;  // exit if |priceChange1h| < this %, after 1h open
  // Trading window (IST)
  tradingWindowEnabled: boolean;
  tradingWindowStart: string;  // HH:MM in IST, e.g. "17:00"
  tradingWindowEnd: string;    // HH:MM in IST, e.g. "00:00" means midnight (end of day)
  // Sniper TP tier configs (10s vol $750-$1499 / $1500-$2249 / $2250+)
  wt1Tp1Pct: number;  wt1Tp1Exit: number;
  wt1Tp2Pct: number;  wt1Tp2Exit: number;  wt1Tp2Trail: number;
  wt1Tp3Pct: number;  wt1Tp3Exit: number;  wt1Tp3Trail: number;
  wt2Tp1Pct: number;  wt2Tp1Exit: number;
  wt2Tp2Pct: number;  wt2Tp2Exit: number;  wt2Tp2Trail: number;
  wt2Tp3Pct: number;  wt2Tp3Exit: number;  wt2Tp3Trail: number;
  wt3Tp1Pct: number;  wt3Tp1Exit: number;
  wt3Tp2Pct: number;  wt3Tp2Exit: number;  wt3Tp2Trail: number;
  wt3Tp3Pct: number;  wt3Tp3Exit: number;  wt3Tp3Trail: number;
}

export interface BuyerActivity {
  wallet: string;
  amountUsd: number;
  timestamp: number;   // on-chain blockTime ms
  detectedAt: number;  // Date.now() when bot processed — use this for display
  txSig: string;
  priceAtDetection: number;
}

export interface TrackedToken {
  mint: string;
  name: string;
  symbol: string;
  poolAddress?: string;
  migrationTime: number;
  expiresAt: number;
  entryTriggered: boolean;
  buyerActivity: BuyerActivity[];
  // Live market data (refreshed every 10s by the server from DexScreener)
  dexId?: string;
  price?: number;
  mcap?: number;
  liquidity?: number;
  priceChange5m?: number;
  priceChange1h?: number;
  priceChange24h?: number;
  volume5m?: number;
  volume1h?: number;
  volume24h?: number;
  txnsH1Buys?: number;
  txnsH1Sells?: number;
  txnsH24Buys?: number;
  txnsH24Sells?: number;
  lastMarketUpdate?: number;
}

export interface SniperPosition {
  id: string;
  mint: string;
  name: string;
  symbol: string;
  entryPrice: number;
  entryMcap: number;
  entryTime: number;
  sizeSol: number;
  sizePct: number;
  peakPrice: number;
  lastPrice: number;
  lastLiquidity: number;
  baselineLiquidity: number;
  migrationTime: number;
  pnlPct: number;
  // Multi-stage TP
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
  initialSizeSol: number;
  remainingSizeSol: number;
  bankedSol: number;
  tpTier: 1 | 2 | 3;
  triggerAmountUsd: number;
  currentSLPrice: number;
  // Timing: when the triggering buy happened vs when we entered
  buyDetectedTimestamp?: number;
  entryDelayMs?: number;
  // Entry checklist — which filters/conditions fired at entry
  entryMode?: 'solo' | 'consensus';
  entryScore?: number;
  qualifyingWalletsCount?: number;
  buyerWallet?: string;
  priceSource?: 'vault' | 'pool-account' | 'jupiter';
  priceAtDetection?: number;
  actualSlippagePct?: number;
  maxSlippagePct?: number;
}

export interface ClosedSniperPosition extends SniperPosition {
  closeTime: number;
  closeReason: string;
  closePnlPct: number;
}

export interface BuyerActivityLog {
  mint: string;
  name: string;
  symbol: string;
  wallet: string;
  amountUsd: number;
  timestamp: number;   // on-chain blockTime ms — used for consensus window logic
  detectedAt: number;  // Date.now() when the bot processed the tx — use for display
  txSig: string;
  entered: boolean;
  skipReason?: string;
  priceAtDetection?: number;
  entryPrice?: number;
  slippagePct?: number;
  walletScore?: number;
  consensusMode?: 'solo' | 'consensus' | 'tracking' | 'none';
  qualifyingWalletsCount?: number;
}

export interface PendingSignal {
  mint: string;
  name: string;
  symbol: string;
  sizePct: number;
  triggerAmountUsd: number;
  queuedAt: number;
  priceAtDetection: number;
}

// ── Diagnostic types ──────────────────────────────────────────────────────────

export interface DiagToken {
  mint: string;
  name: string;
  symbol: string;
  first_seen_at: number;
  first_seen_utc: string;
  first_seen_ist: string;
  discovery_source: string;
  initial_mc: number;
  initial_liquidity: number;
  initial_volume: number;
  initial_buy_sell_ratio: number;
  current_mc: number;
  current_liquidity: number;
  current_volume: number;
  current_buy_sell_ratio: number;
  current_wallet_score: number;
  current_qualifying_wallets: number;
  current_age_minutes: number;
  highest_mc: number;
  highest_liquidity: number;
  highest_volume: number;
  highest_buy_sell_ratio: number;
  highest_wallet_score: number;
  highest_qualifying_wallets: number;
  scan_count: number;
  passed_mc_at: number | null;
  passed_liquidity_at: number | null;
  passed_volume_at: number | null;
  passed_rugcheck_at: number | null;
  passed_holder_at: number | null;
  passed_creator_at: number | null;
  passed_wallet_at: number | null;
  passed_entry_at: number | null;
  status: 'DISCOVERED' | 'TRACKED' | 'TRADED' | 'REJECTED' | 'EXPIRED';
  reject_reason: string | null;
  entry_time: number | null;
  entry_price: number | null;
  entry_mc: number | null;
  entry_wallet_score: number | null;
  entry_qualifying_wallets: number | null;
  entry_mode: string | null;
  entry_risk_tier: string | null;
  entry_reason: string | null;
  last_updated: number;
  created_at: number;
  // computed
  proximity_score?: number;
}

export interface DiagError {
  id: number;
  error_type: string;
  message: string;
  mint: string | null;
  details: unknown;
  occurred_at: number;
  occurred_utc: string;
}

export interface DiagFunnelStats {
  total: string;
  ever_passed_wallet: string;
  ever_passed_liquidity: string;
  ever_reached_entry: string;
  traded: string;
  rejected_wallet: string;
  rejected_liquidity: string;
  rejected_age: string;
  rejected_freeze: string;
  rejected_slippage: string;
  rejected_pool: string;
  rejected_other: string;
}

export interface DiagDailySummary {
  date: string;
  total_discovered: string;
  total_scans: string;
  avg_scans: string;
  passed_mc: string;
  passed_liquidity: string;
  passed_volume: string;
  passed_rugcheck: string;
  passed_wallet: string;
  passed_entry: string;
  total_traded: string;
  total_rejected: string;
  total_expired: string;
  total_tracked: string;
  rejectionBreakdown: { reject_reason: string; count: string }[];
  errorSummary: { error_type: string; count: string }[];
}

export interface SniperStatus {
  serverStartMs: number;   // unix ms when the server process started — use to filter funnel to current session
  trackedTokens: TrackedToken[];
  openPositions: SniperPosition[];
  closedPositions: ClosedSniperPosition[];
  recentBuyLog: BuyerActivityLog[];
  queuedSignals: PendingSignal[];
  solPriceUsd: number;
  pendingCount: number;
  gmgnConfigured: boolean;
  gmgnBannedUntil: number; // unix ms; 0 if not currently rate-limit banned
  stats: { tracking: number; positions: number; queued: number; pending: number };
}
