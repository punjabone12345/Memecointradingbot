import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../lib/logger.js';
import { broadcast, broadcastBalance } from '../websocket/server.js';
import { getBalance, adjustBalance, getSettings } from './settings.service.js';
import { notifySniperTrade, notifySniperSkip, notifySniperClose, notifySniperTP } from '../lib/telegram.js';
import { query } from '../lib/db.js';
import { withHeliusLimit, isHeliusCoolingDown } from '../lib/helius-limiter.js';
import { subscribeLogs, isHeliusWsConfigured } from '../lib/helius-ws-shared.js';
import { evaluateBuy, clearMintConsensus, resetConsensusState, ConsensusResult } from './wallet-consensus.service.js';
import { getWalletScore, isWalletScoreCached, WalletScoreBreakdown } from './wallet-score.service.js';
import { isGmgnConfigured, getGmgnBannedUntil } from '../lib/gmgn-client.js';
import {
  diagTokenDiscovered, diagTokenScanned, diagTokenRejected,
  diagTokenTraded, diagTokenExpired, diagTechError,
  diagTransactionAudited,
  diagTokenValidationMilestone, diagTokenReleased,
} from '../lib/diagnostics.js';
import { releaseForRediscovery } from './trenches.service.js';

const MAX_TRACKING_MS       = 60 * 60 * 1_000; // 1 hour — matches GMGN discovery tracking window
const MAX_POSITIONS         = 10;
const POLL_INTERVAL_MS      = 500;     // time between the end of one sweep and start of the next
// Reduced from 2000ms: vault addresses are captured directly from the buyer's
// tx at detection time, so the ground-truth price read (fetchPriceFromVaults)
// doesn't need to wait for Jupiter/DexScreener to index the pool — it was pure
// added latency. Small buffer kept only in case the vault RPC read races the
// tx's own confirmation.
const ENTRY_DELAY_MS        = 400;     // wait before entering (was 2s)
const PRICE_CHECK_MS        = 1_500;   // reduced from 3s for snappier live prices
const SOL_PRICE_TTL_MS      = 60_000;
const MAX_BUY_LOG           = 100;
const DEX_BASE              = 'https://api.dexscreener.com';
const WSOL_MINT             = 'So11111111111111111111111111111111111111112';

// Post-graduation pool wait settings
const POOL_WAIT_POLL_MS     = 3_000;   // check DexScreener every 3s (was 15s — too slow, misses early buyer window)
const POOL_WAIT_TIMEOUT_MS  = 10 * 60_000; // give up after 10 min
const MIN_POOL_LIQUIDITY    = 1_000;   // require at least $1k liquidity (fresh pump.fun grads seed $1-3k; was $5k which kept most tokens pending)
const MIN_POOL_AGE_MS       = 10_000;  // pool must be confirmed live for 10s (was 30s — too slow for early entry)
// Server start time — used to filter genuinely pre-startup graduation events
// without rejecting real events that were slow to process due to rate limiting.
const SERVER_START_MS       = Date.now();
// Grace period: accept events that happened slightly before startup (clock skew / boot lag)
const STALE_GRAD_GRACE_MS   = 2 * 60_000; // 2 minutes before server start

const PRICE_SL_PCT          = 0.3;    // -30% price stop loss from entry

// Entry is now decided by the Smart Wallet Consensus strategy
// (wallet-consensus.service.ts) — see handleVolumeUpdate below.

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BuyerActivity {
  wallet: string;
  amountUsd: number;
  timestamp: number;    // on-chain blockTime ms — used for consensus window logic
  detectedAt: number;   // Date.now() when the bot processed the tx — used for display
  txSig: string;
  priceAtDetection: number;
}


export interface TrackedToken {
  mint: string;
  name: string;
  symbol: string;
  poolAddress?: string;
  // Vault addresses extracted directly from the buyer's buy transaction.
  // These are the pool's actual token vault (base) and WSOL vault (quote).
  // Populated the moment a buyer buy is detected — no DexScreener pool resolution needed.
  poolBaseVault?: string;
  poolQuoteVault?: string;
  migrationTime: number;
  expiresAt: number;
  entryTriggered: boolean;
  buyerActivity: BuyerActivity[];
  // Live market data (refreshed every 30s from DexScreener)
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
  pairCreatedAt?: number;  // unix ms — when the pool was listed on DexScreener
}

export interface SniperPosition {
  id: string;
  mint: string;
  name: string;
  symbol: string;
  entryPrice: number;
  entryMcap: number;
  entryTime: number;
  sizeSol: number;       // kept in sync with remainingSizeSol for display
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
  initialSizeSol: number;    // original allocation (immutable)
  remainingSizeSol: number;  // still-open portion (decreases at each TP)
  bankedSol: number;         // SOL returned to balance from partial closes
  tpTier: 1 | 2 | 3;
  triggerAmountUsd: number;
  currentSLPrice: number;    // hard SL → breakeven → trailing
  // Timing: when the buyer bought vs when we entered
  buyDetectedTimestamp?: number;  // ms since epoch — when buyer tx was detected
  entryDelayMs?: number;       // how many ms after buyer detection we entered
  // ── Entry checklist — captures WHICH filters/conditions fired at entry,
  // so closed trades can later be sliced by "which gate let this trade in"
  // to see which filter setting is actually producing winners vs losers.
  entryMode?: 'solo' | 'consensus';       // Smart Wallet Consensus path that triggered entry
  entryScore?: number;                    // GMGN score of the triggering wallet
  qualifyingWalletsCount?: number;        // how many distinct >=80 wallets had qualified (consensus mode)
  buyerWallet?: string;                   // wallet whose buy triggered this entry
  priceSource?: 'vault' | 'pool-account' | 'jupiter'; // which price-fetch path succeeded
  priceAtDetection?: number;              // buyer's on-chain avg price when their buy was detected
  actualSlippagePct?: number;             // (entryPrice - priceAtDetection) / priceAtDetection * 100
  maxSlippagePct?: number;                // slippage cap in effect at entry time
}

// ── Tier config ───────────────────────────────────────────────────────────────

interface EntryTierConfig {
  tp1Pct: number;   tp1Exit: number;
  tp2Pct: number;   tp2Exit: number;   tp2Trail: number;
  tp3Pct: number;   tp3Exit: number;   tp3Trail: number;
}

function determineTier(amountUsd: number): 1 | 2 | 3 {
  if (amountUsd >= 2_250) return 3;
  if (amountUsd >= 1_500) return 2;
  return 1;
}

function getTierConfig(tier: 1 | 2 | 3, s: { [k: string]: number }): EntryTierConfig {
  if (tier === 3) return {
    tp1Pct: s['wt3Tp1Pct'] ?? 150, tp1Exit: s['wt3Tp1Exit'] ?? 30,
    tp2Pct: s['wt3Tp2Pct'] ?? 350, tp2Exit: s['wt3Tp2Exit'] ?? 30, tp2Trail: s['wt3Tp2Trail'] ?? 20,
    tp3Pct: s['wt3Tp3Pct'] ?? 550, tp3Exit: s['wt3Tp3Exit'] ?? 30, tp3Trail: s['wt3Tp3Trail'] ?? 10,
  };
  if (tier === 2) return {
    tp1Pct: s['wt2Tp1Pct'] ?? 100, tp1Exit: s['wt2Tp1Exit'] ?? 30,
    tp2Pct: s['wt2Tp2Pct'] ?? 250, tp2Exit: s['wt2Tp2Exit'] ?? 30, tp2Trail: s['wt2Tp2Trail'] ?? 25,
    tp3Pct: s['wt2Tp3Pct'] ?? 400, tp3Exit: s['wt2Tp3Exit'] ?? 30, tp3Trail: s['wt2Tp3Trail'] ?? 15,
  };
  return {
    tp1Pct: s['wt1Tp1Pct'] ?? 50,  tp1Exit: s['wt1Tp1Exit'] ?? 30,
    tp2Pct: s['wt1Tp2Pct'] ?? 125, tp2Exit: s['wt1Tp2Exit'] ?? 30, tp2Trail: s['wt1Tp2Trail'] ?? 30,
    tp3Pct: s['wt1Tp3Pct'] ?? 200, tp3Exit: s['wt1Tp3Exit'] ?? 30, tp3Trail: s['wt1Tp3Trail'] ?? 20,
  };
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
  timestamp: number;   // on-chain blockTime ms — used for consensus window
  detectedAt: number;  // Date.now() when the bot processed the tx — use for display
  txSig: string;
  txType?: 'buy' | 'sell';
  entered: boolean;
  skipReason?: string;
  priceAtDetection?: number;
  entryPrice?: number;
  slippagePct?: number;
  // GMGN wallet-quality score (0-100) and the consensus mode it evaluated
  // under — surfaced in the UI so the Smart Wallet Consensus entry model is
  // visible everywhere trades happen, not just buried in skipReason text.
  walletScore?: number;
  consensusMode?: 'solo' | 'consensus' | 'tracking' | 'none' | 'ban_queued';
  qualifyingWalletsCount?: number;
  gmgnScore?: WalletScoreBreakdown;
}

interface PendingSignal {
  mint: string;
  name: string;
  symbol: string;
  sizePct: number;
  triggerAmountUsd: number;
  queuedAt: number;
  priceAtDetection: number;
  buyerWallet: string;
  buyDetectedTimestamp: number;
  tpTier: 1 | 2 | 3;
  entryMode: 'solo' | 'consensus';
  entryScore: number;
  qualifyingWalletsCount: number;
  qualifyingWallets: string[];
  maxSlippagePctAtQueue: number;
}

// ── Pending graduation type ───────────────────────────────────────────────────

interface PendingGraduation {
  mint: string;
  poolAddress?: string;
  detectedAt: number;
  migrationTime: number; // actual token creation time (openTimestamp * 1000), or detectedAt as fallback
}

// ── Helius WebSocket — instant buyer-buy detection per tracked mint ───────────
// Uses the shared Helius WS connection (helius-ws-shared.ts) instead of a
// dedicated socket — Helius keys allow only one concurrent WS connection, so a
// separate socket per service caused a 429 reconnect storm across services.

const _mintUnsubscribe = new Map<string, () => void>(); // mint → unsubscribe fn

function wsSubscribeMint(mint: string): void {
  if (_mintUnsubscribe.has(mint)) return;
  const unsub = subscribeLogs([mint], (value) => {
    if (value.err !== null) return;
    if (!trackedTokens.has(mint)) return;

    logger.debug(
      { mint: mint.slice(0, 12), sig: (value.signature ?? '').slice(0, 12) },
      'Sniper engine: WS event — triggering instant poll',
    );
    void pollTokenBuys(mint, true);
  }, 'processed');
  _mintUnsubscribe.set(mint, unsub);
}

function wsUnsubscribeMint(mint: string): void {
  const unsub = _mintUnsubscribe.get(mint);
  if (unsub) {
    _mintUnsubscribe.delete(mint);
    unsub();
  }
}

function connectSniperWs(): void {
  if (!isHeliusWsConfigured()) return;
  // Ensure the shared connection is started and (re)subscribe to all currently
  // tracked mints — subscribeLogs auto-resubscribes on reconnect internally,
  // but on first start we still need to register each tracked mint here.
  for (const mint of trackedTokens.keys()) wsSubscribeMint(mint);
  logger.info({ mints: trackedTokens.size }, 'Sniper engine: subscribed tracked mints via shared Helius WS');
}

// ── In-memory state ───────────────────────────────────────────────────────────

interface PendingConsensusSignal {
  mint: string;
  name: string;
  symbol: string;
  qualifyingWallets: string[];
  consensusTimestamp: number;
  sizePct: number;
  triggerAmountUsd: number;
  priceAtDetection: number;
  buyerWallet: string;
  buyDetectedTimestamp: number;
  tpTier: 1 | 2 | 3;
  entryMode: 'solo' | 'consensus';
  entryScore: number;
  qualifyingWalletsCount: number;
  scoreBreakdown: WalletScoreBreakdown;
  txSig: string;
}

const PENDING_CONSENSUS_TTL_MS = 20 * 60_000; // 20 minutes
const pendingConsensusSignals = new Map<string, PendingConsensusSignal>();

const pendingGraduations = new Map<string, PendingGraduation>();
const trackedTokens  = new Map<string, TrackedToken>();
const openPositions = new Map<string, SniperPosition>();
const buyLog: BuyerActivityLog[] = [];
const signalQueue: PendingSignal[] = [];
const closedPositions: ClosedSniperPosition[] = [];

// Synchronous re-entrancy locks — prevent duplicate entries/closes when
// overlapping poll cycles (or concurrent buy detections for the same mint)
// race each other. Held for the entire duration of the async operation.
const entryLocks = new Set<string>();
const closeLocks = new Set<string>();
// Per-mint poll lock: prevents WS-triggered instant polls and the scheduled
// sweep from running pollTokenBuys concurrently for the same mint, which would
// process overlapping signature windows and could produce duplicate buy events.
const pollLocks  = new Set<string>();
// Tracks mints that are actively running their initial baseline scan.
// Used to defer age-cap pruning so the baseline can finish and populate
// the buyLog before the token is removed from trackedTokens.
const mintHasActiveBaseline = new Set<string>();
// Hard cap: even with an active baseline, prune once the token exceeds this age.
const BASELINE_PRUNE_HARD_CAP_MS = 25 * 60_000; // 25 min
const seenTxns = new Map<string, Set<string>>();
const mintCheckpointed = new Set<string>();

// Permanent, DB-backed lifetime registry of every mint ever traded by the
// sniper engine. `openPositions` only reflects currently-OPEN positions, so
// once a position closes the mint would otherwise become tradeable again if
// the same graduation got re-detected (backfill re-scan, restart, duplicate
// WS event, etc). This set is checked before EVERY entry and is never
// cleared for a mint once it's added — a token can be entered at most once
// for the lifetime of the bot.
const everTradedMints = new Set<string>();

// ── GMGN ban-replay queue ─────────────────────────────────────────────────────
// When GMGN is rate-banned, wallet scores return 0 via the `ban_queued` consensus
// mode. Instead of discarding those buys, we park them here and replay them
// through handleVolumeUpdate once the ban clears — guaranteeing no valid signal
// is permanently lost due to a temporary rate-limit window.
interface BanReplayEntry {
  mint: string;
  wallet: string;
  txUsd: number;
  txSig: string;
  priceAtDetection: number;
  txTimestamp: number;
  queuedAt: number;
}
const banReplayQueue: BanReplayEntry[] = [];
// Only replay within the 5-min consensus window — older queued buys can't qualify anyway.
const BAN_REPLAY_MAX_AGE_MS = 5 * 60_000;

async function loadTradedMintsFromDB(): Promise<void> {
  try {
    const rows = await query<any>(`SELECT mint FROM traded_mints`);
    for (const r of rows) everTradedMints.add(r.mint);
    logger.info({ count: everTradedMints.size }, 'Sniper engine: loaded lifetime traded-mint registry');
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'Sniper engine: failed to load traded-mint registry');
  }
}

async function markMintTraded(mint: string): Promise<void> {
  everTradedMints.add(mint);
  try {
    await query(
      `INSERT INTO traded_mints (mint, traded_at) VALUES ($1, $2) ON CONFLICT (mint) DO NOTHING`,
      [mint, Date.now()],
    );
  } catch (err: any) {
    logger.warn({ err: err?.message, mint }, 'Sniper engine: failed to persist traded-mint record');
  }
}

// ── Slippage-skipped mints registry ──────────────────────────────────────────
// Once a mint is skipped due to post-delay slippage it is permanently blocked
// at every entry gate. The token already pumped past our threshold before we
// could get a fill — subsequent buyer buys on the same mint will face the same
// or worse slippage, so we never attempt it again.
const slippageSkippedMints = new Set<string>();

async function loadSlippageSkippedMintsFromDB(): Promise<void> {
  try {
    const rows = await query<any>(`SELECT mint FROM slippage_skipped_mints`);
    for (const r of rows) slippageSkippedMints.add(r.mint);
    logger.info({ count: slippageSkippedMints.size }, 'Sniper engine: loaded slippage-skipped mint registry');
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'Sniper engine: failed to load slippage-skipped mint registry');
  }
}

async function markMintSlippageSkipped(mint: string, slipPct: number): Promise<void> {
  slippageSkippedMints.add(mint);
  void diagTokenRejected(mint, `Slippage: token pumped ${slipPct.toFixed(1)}% too fast before entry`).catch(() => {});
  try {
    await query(
      `INSERT INTO slippage_skipped_mints (mint, skipped_at, slip_pct) VALUES ($1, $2, $3) ON CONFLICT (mint) DO NOTHING`,
      [mint, Date.now(), slipPct],
    );
  } catch (err: any) {
    logger.warn({ err: err?.message, mint }, 'Sniper engine: failed to persist slippage-skipped mint record');
  }
}

// SOL price cache
let cachedSolPrice    = 200;
let lastSolPriceFetch = 0;

// ── RPC ───────────────────────────────────────────────────────────────────────

let _conn: Connection | null = null;
function getConn(): Connection {
  if (!_conn) {
    const apiKey = process.env.HELIUS_API_KEY;
    const rpc    = process.env.RPC_ENDPOINT
      ?? (apiKey ? `https://mainnet.helius-rpc.com/?api-key=${apiKey}` : 'https://api.mainnet-beta.solana.com');
    _conn = new Connection(rpc, { commitment: 'confirmed', disableRetryOnRateLimit: true });
  }
  return _conn;
}

// Public RPC fallback — used for buy detection when Helius is rate-limit-cooling
// so wallet transactions keep flowing even during Helius 429 backoff windows.
// Separate connection object so switching back to Helius never reuses a stale socket.
let _publicConn: Connection | null = null;
function getPublicConn(): Connection {
  if (!_publicConn) {
    const rpc = process.env.PUBLIC_RPC_ENDPOINT ?? 'https://api.mainnet-beta.solana.com';
    _publicConn = new Connection(rpc, { commitment: 'confirmed', disableRetryOnRateLimit: true });
  }
  return _publicConn;
}

// ── SOL price ─────────────────────────────────────────────────────────────────
// Primary source: Jupiter Price API v2 (always accurate, reflects real-time AMM)
// Fallback: DexScreener (may lag 30-120s but better than nothing)

async function fetchSolPrice(): Promise<void> {
  if (Date.now() - lastSolPriceFetch < SOL_PRICE_TTL_MS) return;
  // Jupiter Price API v2 — most accurate for SOL
  try {
    const r     = await axios.get<any>(`https://lite-api.jup.ag/price/v2?ids=${WSOL_MINT}`, { timeout: 4_000 });
    const price = parseFloat(r.data?.data?.[WSOL_MINT]?.price ?? '0');
    if (price > 10) { cachedSolPrice = price; lastSolPriceFetch = Date.now(); return; }
  } catch { /* fall through */ }
  // DexScreener fallback
  try {
    const r     = await axios.get<any>(`${DEX_BASE}/latest/dex/tokens/${WSOL_MINT}`, { timeout: 5_000 });
    const pairs: any[] = r.data?.pairs ?? [];
    const pair  = pairs.find((p: any) => ['USDC', 'USDT'].includes(p.quoteToken?.symbol)) ?? pairs[0];
    const price = parseFloat(pair?.priceUsd ?? '0');
    if (price > 10) { cachedSolPrice = price; lastSolPriceFetch = Date.now(); }
  } catch { /* keep cached value */ }
}

// ── Fetch token market data from DexScreener (liquidity, mcap, metadata) ──────

interface DexMarketData {
  price: number;
  liquidity: number;
  mcap: number;
  priceChange5m: number;
  priceChange1h: number;
  priceChange24h: number;
  volume5m: number;
  volume1h: number;
  volume24h: number;
  txnsH1Buys: number;
  txnsH1Sells: number;
  txnsH24Buys: number;
  txnsH24Sells: number;
  name: string;
  symbol: string;
  pairAddress: string;
  dexId: string;
  pairCreatedAt: number;  // unix ms
}

function parseDexPair(best: any): DexMarketData {
  return {
    price:          parseFloat(best?.priceUsd ?? '0'),
    liquidity:      best?.liquidity?.usd      ?? 0,
    mcap:           best?.marketCap ?? best?.fdv ?? 0,
    priceChange5m:  best?.priceChange?.m5     ?? 0,
    priceChange1h:  best?.priceChange?.h1     ?? 0,
    priceChange24h: best?.priceChange?.h24    ?? 0,
    volume5m:       best?.volume?.m5          ?? 0,
    volume1h:       best?.volume?.h1          ?? 0,
    volume24h:      best?.volume?.h24         ?? 0,
    txnsH1Buys:     best?.txns?.h1?.buys      ?? 0,
    txnsH1Sells:    best?.txns?.h1?.sells     ?? 0,
    txnsH24Buys:    best?.txns?.h24?.buys     ?? 0,
    txnsH24Sells:   best?.txns?.h24?.sells    ?? 0,
    name:           best?.baseToken?.name     ?? '',
    symbol:         best?.baseToken?.symbol   ?? '',
    pairAddress:    best?.pairAddress         ?? '',
    dexId:          best?.dexId              ?? '',
    pairCreatedAt:  best?.pairCreatedAt       ?? 0,
  };
}

function pickBestPair(pairs: any[]): any | null {
  if (!pairs.length) return null;
  // Prefer pumpswap (canonical graduation DEX), then highest-liquidity pair
  const pumpswap = pairs
    .filter((p: any) => (p.dexId ?? '').toLowerCase() === 'pumpswap')
    .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const byLiq = [...pairs].sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  return pumpswap[0] ?? byLiq[0];
}

// Fetch market data for up to 30 mints in a single DexScreener request.
// Returns a map of mint → DexMarketData for mints that had results.
async function fetchTokenPriceBatch(mints: string[]): Promise<Map<string, DexMarketData>> {
  const result = new Map<string, DexMarketData>();
  if (!mints.length) return result;
  try {
    const url = DEX_BASE + '/latest/dex/tokens/' + mints.join(',');
    const r   = await axios.get<any>(url, { timeout: 8_000 });
    const pairs: any[] = r.data?.pairs ?? [];
    // Group pairs by base token address, pick the best pair per mint
    const byMint = new Map<string, any[]>();
    for (const pair of pairs) {
      const addr: string = (pair?.baseToken?.address ?? '').toLowerCase();
      if (!addr) continue;
      if (!byMint.has(addr)) byMint.set(addr, []);
      byMint.get(addr)!.push(pair);
    }
    for (const mint of mints) {
      const candidates = byMint.get(mint.toLowerCase()) ?? [];
      const best = pickBestPair(candidates);
      if (best) result.set(mint, parseDexPair(best));
    }
  } catch { /* return whatever we have so far */ }
  return result;
}

// Single-mint fallback — still used by non-refresh paths (entry price checks, etc.)
async function fetchTokenPrice(mint: string): Promise<DexMarketData> {
  const empty: DexMarketData = {
    price: 0, liquidity: 0, mcap: 0,
    priceChange5m: 0, priceChange1h: 0, priceChange24h: 0,
    volume5m: 0, volume1h: 0, volume24h: 0,
    txnsH1Buys: 0, txnsH1Sells: 0, txnsH24Buys: 0, txnsH24Sells: 0,
    name: '', symbol: '', pairAddress: '', dexId: '', pairCreatedAt: 0,
  };
  try {
    const r    = await axios.get<any>(DEX_BASE + '/latest/dex/tokens/' + mint, { timeout: 6_000 });
    const all: any[] = r.data?.pairs ?? [];
    const best = pickBestPair(all);
    if (!best) return empty;
    return parseDexPair(best);
  } catch {
    return empty;
  }
}

// ── Real-time spot price: Jupiter Quote (primary) → DexScreener (fallback) ────
//
// DexScreener caches data 30-120s for freshly-graduated tokens. Meme coins can
// pump 50-100%+ in that window, making DexScreener prices completely wrong at entry.
//
// Jupiter's Quote API reads on-chain pool reserve ratios directly — always real-time.
// Strategy: quote 0.01 SOL → token, derive price from swapUsdValue ÷ tokensReceived.
// All pump.fun tokens have 6 decimals, so tokensReceived = outAmount / 1e6.
//
const PUMP_TOKEN_DECIMALS = 6;
const WSOL_QUOTE_AMOUNT   = 10_000_000; // 0.01 SOL in lamports — small to avoid price impact

// ── On-chain PumpSwap pool reserve-ratio price (ground truth) ────────────────
//
// PumpSwap pool accounts are keypair-based (NOT PDAs) — the pool address must
// come from the migration tx or DexScreener's `pairAddress`, never derived.
// Layout (confirmed against live pools):
//   [139-170] pool_base_token_account  (32 bytes) — token vault
//   [171-202] pool_quote_token_account (32 bytes) — WSOL vault
// price = (wsolVaultBalance * solPriceUsd) / baseVaultBalance
//
// This reads the ACTUAL on-chain reserves at the moment of the call — it is
// not a heuristic/estimate like Jupiter quotes (which can lag pool-cache
// refreshes) or DexScreener (which lags 30-120s for fresh pools).
const POOL_BASE_VAULT_OFFSET  = 139;
const POOL_QUOTE_VAULT_OFFSET = 171;
const POOL_VAULT_LEN          = 32;
const POOL_MIN_ACCOUNT_BYTES  = 203;

const pumpswapVaultCache = new Map<string, { baseVault: PublicKey; quoteVault: PublicKey }>();

async function fetchOnChainReservePrice(poolAddress: string, solPriceUsd: number, priority = false): Promise<number> {
  if (!poolAddress || solPriceUsd <= 0) return 0;
  try {
    const conn = getConn();
    let vaults = pumpswapVaultCache.get(poolAddress);

    if (!vaults) {
      const poolPk = new PublicKey(poolAddress);
      const info = await withHeliusLimit(() => conn.getAccountInfo(poolPk), { priority });
      if (!info || info.data.length < POOL_MIN_ACCOUNT_BYTES) return 0;
      const baseVault  = new PublicKey(info.data.subarray(POOL_BASE_VAULT_OFFSET, POOL_BASE_VAULT_OFFSET + POOL_VAULT_LEN));
      const quoteVault = new PublicKey(info.data.subarray(POOL_QUOTE_VAULT_OFFSET, POOL_QUOTE_VAULT_OFFSET + POOL_VAULT_LEN));
      vaults = { baseVault, quoteVault };
      pumpswapVaultCache.set(poolAddress, vaults);
    }

    const [baseBal, quoteBal] = await Promise.all([
      withHeliusLimit(() => conn.getTokenAccountBalance(vaults!.baseVault), { priority }).catch(() => null),
      withHeliusLimit(() => conn.getTokenAccountBalance(vaults!.quoteVault), { priority }).catch(() => null),
    ]);

    const baseAmount  = baseBal?.value?.uiAmount ?? 0;
    const quoteAmount = quoteBal?.value?.uiAmount ?? 0; // WSOL reserve
    if (baseAmount <= 0 || quoteAmount <= 0) return 0;

    const price = (quoteAmount * solPriceUsd) / baseAmount;
    return price > 0 ? price : 0;
  } catch {
    // Wrong/stale pool address (e.g. heuristic-extracted from migration tx) — invalidate cache
    // entry so a later call with a corrected pairAddress can retry cleanly.
    pumpswapVaultCache.delete(poolAddress);
    return 0;
  }
}

/**
 * Compute total pool liquidity in USD directly from on-chain WSOL vault balance.
 * Reuses the same PumpSwap account-offset reading as fetchOnChainReservePrice and
 * the shared pumpswapVaultCache, so a vault lookup cached by a previous price read
 * is free.
 *
 * liq ≈ 2 × quoteVault_WSOL × solPriceUsd
 * (PumpSwap is a constant-product AMM — both sides are equal by value.)
 *
 * Returns 0 on any error so callers fall back to DexScreener gracefully.
 */
async function fetchOnChainLiqUsd(poolAddress: string, solPriceUsd: number, priority = false): Promise<number> {
  if (!poolAddress || solPriceUsd <= 0) return 0;
  try {
    const conn = getConn();
    let vaults = pumpswapVaultCache.get(poolAddress);

    if (!vaults) {
      const poolPk = new PublicKey(poolAddress);
      const info   = await withHeliusLimit(() => conn.getAccountInfo(poolPk), { priority });
      if (!info || info.data.length < POOL_MIN_ACCOUNT_BYTES) return 0;
      const baseVault  = new PublicKey(info.data.subarray(POOL_BASE_VAULT_OFFSET,  POOL_BASE_VAULT_OFFSET  + POOL_VAULT_LEN));
      const quoteVault = new PublicKey(info.data.subarray(POOL_QUOTE_VAULT_OFFSET, POOL_QUOTE_VAULT_OFFSET + POOL_VAULT_LEN));
      vaults = { baseVault, quoteVault };
      pumpswapVaultCache.set(poolAddress, vaults);
    }

    const quoteBal = await withHeliusLimit(
      () => conn.getTokenAccountBalance(vaults!.quoteVault), { priority }
    ).catch(() => null);

    const quoteAmount = quoteBal?.value?.uiAmount ?? 0; // WSOL reserve
    if (quoteAmount <= 0) return 0;

    return quoteAmount * solPriceUsd * 2; // × 2 because SOL side = half of total liq
  } catch {
    pumpswapVaultCache.delete(poolAddress);
    return 0;
  }
}

// fetchPriceFresh: genuine on-chain reserve-ratio price is the SOURCE OF TRUTH.
//
// WHY on-chain, not Jupiter/DexScreener max():
//   The previous approach quoted Jupiter and DexScreener in parallel and took
//   whichever was higher. That is a heuristic guess, not a calculation — it
//   produced entry prices 10-60% off the real market because Jupiter can return
//   a stale cached route and DexScreener can lag 30-120s on freshly-graduated
//   pools. Reading the pool's actual token vault balances and computing
//   quoteReserve/baseReserve directly is unambiguous ground truth — it cannot
//   be stale because it *is* the current reserve state.
//
// Fallback order (only used when the on-chain read is unavailable, e.g. pool
// address not yet known / RPC hiccup):
//   1. On-chain reserve ratio via the confirmed PumpSwap pool account (best).
//   2. Jupiter Quote API (reads live routes, still on-chain-derived).
//   3. DexScreener priceUsd (last resort — may lag).
async function fetchPriceFresh(mint: string, pairAddress?: string): Promise<number> {
  // Always ensure a fresh SOL price before calculating token price.
  await fetchSolPrice();

  if (pairAddress) {
    const onChainPrice = await fetchOnChainReservePrice(pairAddress, cachedSolPrice);
    if (onChainPrice > 0) {
      logger.info(
        { mint: mint.slice(0, 12), price: onChainPrice, pairAddress: pairAddress.slice(0, 12), source: 'onchain-reserve-ratio' },
        'Sniper engine: spot price (on-chain reserve ratio)',
      );
      return onChainPrice;
    }
  }

  // ── Fallback: Jupiter Quote API ─────────────────────────────────────────
  const jupiterPrice = await (async (): Promise<number> => {
    try {
      const r = await axios.get<any>(
        `https://lite-api.jup.ag/swap/v1/quote` +
        `?inputMint=${WSOL_MINT}` +
        `&outputMint=${mint}` +
        `&amount=${WSOL_QUOTE_AMOUNT}` +
        `&slippageBps=1000`,
        { timeout: 5_000 },
      );
      const outAmount = parseInt(r.data?.outAmount ?? '0', 10);

      if (outAmount > 0 && cachedSolPrice > 0) {
        const decimals       = parseInt(r.data?.outputDecimals ?? String(PUMP_TOKEN_DECIMALS), 10);
        const tokensReceived = outAmount / Math.pow(10, decimals);
        const inputSolUsd    = (WSOL_QUOTE_AMOUNT / 1e9) * cachedSolPrice;
        const price          = inputSolUsd / tokensReceived;
        if (price > 0) return price;
      }

      const swapUsdValue = parseFloat(r.data?.swapUsdValue ?? '0');
      if (swapUsdValue > 0 && parseInt(r.data?.outAmount ?? '0', 10) > 0) {
        const decimals       = parseInt(r.data?.outputDecimals ?? String(PUMP_TOKEN_DECIMALS), 10);
        const tokensReceived = parseInt(r.data.outAmount, 10) / Math.pow(10, decimals);
        const price          = swapUsdValue / tokensReceived;
        if (price > 0) return price;
      }
    } catch { /* non-fatal */ }
    return 0;
  })();

  if (jupiterPrice > 0) {
    logger.info({ mint: mint.slice(0, 12), price: jupiterPrice, source: 'jupiter-fallback' }, 'Sniper engine: spot price (jupiter fallback)');
    return jupiterPrice;
  }

  // DexScreener is intentionally NOT used here. For freshly-graduated tokens,
  // DexScreener caches its price 30-120s — reading it during entry returns the
  // pre-buyer-pump price, which can be 10-30% below the real pool price.
  // Use fetchPriceFromVaults() directly when on-chain data is needed.
  return 0;
}

// ── Direct vault-balance price (most accurate for fresh tokens) ───────────────
//
// Reads the pool's ACTUAL token vault and WSOL vault balances at this moment.
// Vault addresses are extracted from the buyer's buy tx (detectBuy), so this
// requires no pool-account lookup, no DexScreener pair resolution, and no
// Jupiter routing — just two getTokenAccountBalance calls.
//
// price = (wsolVaultBalance × solPriceUsd) / baseVaultBalance
//
async function fetchPriceFromVaults(baseVault: string, quoteVault: string, solPriceUsd: number, priority = false): Promise<number> {
  if (!baseVault || !quoteVault || solPriceUsd <= 0) return 0;
  try {
    const conn = getConn();
    const [baseBal, quoteBal] = await Promise.all([
      withHeliusLimit(() => conn.getTokenAccountBalance(new PublicKey(baseVault)), { priority }).catch(() => null),
      withHeliusLimit(() => conn.getTokenAccountBalance(new PublicKey(quoteVault)), { priority }).catch(() => null),
    ]);
    const baseAmount  = baseBal?.value?.uiAmount  ?? 0;
    const quoteAmount = quoteBal?.value?.uiAmount ?? 0;
    if (baseAmount <= 0 || quoteAmount <= 0) return 0;
    const price = (quoteAmount * solPriceUsd) / baseAmount;
    logger.info(
      { baseVault: baseVault.slice(0, 12), quoteVault: quoteVault.slice(0, 12),
        base: baseAmount.toFixed(0), quote: quoteAmount.toFixed(4), price, source: 'tx-vault-balances' },
      'Sniper engine: spot price (tx vault balances — ground truth)',
    );
    return price > 0 ? price : 0;
  } catch {
    return 0;
  }
}

// ── Buy detection from a parsed Solana transaction ───────────────────────────

interface BuyInfo {
  wallet: string;
  solSpent: number;
  tokensReceived: number;
  poolBaseVault: string | null;  // pool's token vault — decreasing side of the swap
  poolQuoteVault: string | null; // pool's WSOL vault — increasing side of the swap
}

function detectBuy(tx: any, targetMint: string): BuyInfo | null {
  const preTok: any[]     = tx.meta?.preTokenBalances  ?? [];
  const postTok: any[]    = tx.meta?.postTokenBalances ?? [];
  const preSol: number[]  = tx.meta?.preBalances  ?? [];
  const postSol: number[] = tx.meta?.postBalances ?? [];
  const keys: any[]       = (tx.transaction?.message as any)?.accountKeys ?? [];

  // Sum all token balance increases for this mint — the total tokens the buyer received.
  // Use raw integer amounts (uiTokenAmount.amount) divided by 10^decimals rather than
  // uiAmount to avoid floating-point rounding errors on large token quantities.
  let tokensReceived = 0;
  for (const post of postTok) {
    if (post.mint !== targetMint) continue;
    const pre      = preTok.find((p: any) => p.accountIndex === post.accountIndex && p.mint === targetMint);
    const decimals = parseInt(post.uiTokenAmount?.decimals ?? '6', 10);
    const divisor  = Math.pow(10, decimals);
    const preRaw   = parseInt(pre?.uiTokenAmount?.amount  ?? '0', 10);
    const postRaw  = parseInt(post.uiTokenAmount?.amount  ?? '0', 10);
    if (postRaw > preRaw) tokensReceived += (postRaw - preRaw) / divisor;
  }
  if (tokensReceived <= 0) return null;

  // Method 1: native SOL decrease at fee payer (index 0) — works for native SOL buyers
  const nativeLamports = (preSol[0] ?? 0) - (postSol[0] ?? 0);

  // Method 2: WSOL decrease on fee-payer-owned accounts only — catches buyer wallets
  // that fund swaps via pre-existing WSOL accounts. Restricting to fee-payer owner
  // prevents inflating spend from third-party WSOL movements in routed/multi-leg swaps.
  const feePayerAddr = keys[0]?.pubkey?.toString() ?? keys[0]?.toString() ?? '';
  let wsolLamports = 0;
  for (const pre of preTok) {
    if (pre.mint !== WSOL_MINT) continue;
    // Strict: only count WSOL from accounts provably owned by the fee payer.
    // Missing owner = unknown ownership → skip to avoid inflation.
    if (!pre.owner || pre.owner !== feePayerAddr) continue;
    const post   = postTok.find((p: any) => p.accountIndex === pre.accountIndex && p.mint === WSOL_MINT);
    const preRaw = parseInt(pre.uiTokenAmount?.amount  ?? '0', 10);
    const postRaw= parseInt(post?.uiTokenAmount?.amount ?? '0', 10);
    if (preRaw > postRaw) wsolLamports += (preRaw - postRaw);
  }

  const spent = Math.max(nativeLamports, wsolLamports);
  if (spent < 10_000) return null;

  // ── Extract pool vault addresses from this tx ────────────────────────────
  // Pool's BASE vault: the target-mint account that DECREASED (pool gave tokens to buyer)
  let poolBaseVault: string | null = null;
  for (const pre of preTok) {
    if (pre.mint !== targetMint) continue;
    const post   = postTok.find((p: any) => p.accountIndex === pre.accountIndex && p.mint === targetMint);
    const preRaw = parseInt(pre.uiTokenAmount?.amount ?? '0', 10);
    const postRaw= parseInt(post?.uiTokenAmount?.amount ?? '0', 10);
    if (preRaw > postRaw) {
      const addr = keys[pre.accountIndex]?.pubkey?.toString() ?? keys[pre.accountIndex]?.toString() ?? null;
      if (addr) { poolBaseVault = addr; break; }
    }
  }

  // Pool's QUOTE vault (WSOL): pick the WSOL account with the LARGEST lamport increase.
  //
  // Why largest-increase instead of first-match with owner filter:
  //   • In a direct PumpSwap buy, the pool's WSOL vault receives all the SOL the buyer paid.
  //   • In multi-leg or routed transactions, intermediate accounts may also gain WSOL, but
  //     the pool vault always shows the dominant increase.
  //   • The owner field is sometimes absent from getParsedTransaction results, making
  //     owner-based exclusion unreliable. The buyer's WSOL account DECREASES (they spend SOL),
  //     so any WSOL account that increases is either the pool or an intermediate account.
  //     Taking the largest increase almost always gives us the pool vault.
  //   • Explicitly skip fee-payer-owned accounts when owner IS available.
  let poolQuoteVault: string | null = null;
  let maxWsolIncrease = 0;
  for (const post of postTok) {
    if (post.mint !== WSOL_MINT) continue;
    if (post.owner && post.owner === feePayerAddr) continue; // buyer's WSOL — skip when owner known
    const pre     = preTok.find((p: any) => p.accountIndex === post.accountIndex && p.mint === WSOL_MINT);
    const preRaw  = parseInt(pre?.uiTokenAmount?.amount ?? '0', 10);
    const postRaw = parseInt(post.uiTokenAmount?.amount ?? '0', 10);
    const delta   = postRaw - preRaw;
    if (delta > maxWsolIncrease) {
      const addr = keys[post.accountIndex]?.pubkey?.toString() ?? keys[post.accountIndex]?.toString() ?? null;
      if (addr) { poolQuoteVault = addr; maxWsolIncrease = delta; }
    }
  }

  // Identify the buyer's wallet address:
  // Prefer recipient token account owner (the real buyer) before falling back to fee payer (keys[0])
  let tokenRecipientOwner: string | null = null;
  for (const post of postTok) {
    if (post.mint !== targetMint) continue;
    const pre     = preTok.find((p: any) => p.accountIndex === post.accountIndex && p.mint === targetMint);
    const preRaw  = parseInt(pre?.uiTokenAmount?.amount ?? '0', 10);
    const postRaw = parseInt(post.uiTokenAmount?.amount ?? '0', 10);
    if (postRaw > preRaw && post.owner && post.owner !== feePayerAddr) {
      tokenRecipientOwner = post.owner;
      break;
    }
  }

  const wallet = tokenRecipientOwner || feePayerAddr || 'unknown';
  return { wallet, solSpent: spent / 1e9, tokensReceived, poolBaseVault, poolQuoteVault };
}

// ── Sell detection from a parsed Solana transaction ───────────────────────────
// Detects when a user sends tokens to the pool and receives SOL back.
// Used together with detectBuy to compute aggregate 10-second pool volume.

interface SellInfo {
  wallet: string;
  solReceived: number; // SOL paid out by the pool to the seller
  poolBaseVault: string | null;
  poolQuoteVault: string | null;
}

function detectSell(tx: any, targetMint: string): SellInfo | null {
  const preTok: any[]     = tx.meta?.preTokenBalances  ?? [];
  const postTok: any[]    = tx.meta?.postTokenBalances ?? [];
  const preSol: number[]  = tx.meta?.preBalances  ?? [];
  const postSol: number[] = tx.meta?.postBalances ?? [];
  const keys: any[]       = (tx.transaction?.message as any)?.accountKeys ?? [];
  const feePayerAddr = keys[0]?.pubkey?.toString() ?? keys[0]?.toString() ?? '';

  // Pool's base vault (token account) INCREASES — pool receives tokens from seller
  let poolBaseVault: string | null = null;
  let tokensSentToPool = 0;
  for (const post of postTok) {
    if (post.mint !== targetMint) continue;
    const pre      = preTok.find((p: any) => p.accountIndex === post.accountIndex && p.mint === targetMint);
    const decimals = parseInt(post.uiTokenAmount?.decimals ?? '6', 10);
    const preRaw   = parseInt(pre?.uiTokenAmount?.amount ?? '0', 10);
    const postRaw  = parseInt(post.uiTokenAmount?.amount ?? '0', 10);
    if (postRaw > preRaw) {
      const addr  = keys[post.accountIndex]?.pubkey?.toString() ?? keys[post.accountIndex]?.toString() ?? '';
      const owner = post.owner ?? '';
      // Pool vault is owned by the pool program, not by the fee payer (seller)
      if (owner !== feePayerAddr && addr !== feePayerAddr) {
        tokensSentToPool += (postRaw - preRaw) / Math.pow(10, decimals);
        if (!poolBaseVault) poolBaseVault = addr;
      }
    }
  }
  if (tokensSentToPool <= 0) return null;

  // Pool's WSOL vault DECREASES — pool pays out SOL to the seller
  let poolQuoteVault: string | null = null;
  let maxWsolDecrease = 0;
  for (const pre of preTok) {
    if (pre.mint !== WSOL_MINT) continue;
    if (pre.owner && pre.owner === feePayerAddr) continue; // seller's own WSOL — skip
    const post    = postTok.find((p: any) => p.accountIndex === pre.accountIndex && p.mint === WSOL_MINT);
    const preRaw  = parseInt(pre.uiTokenAmount?.amount ?? '0', 10);
    const postRaw = parseInt(post?.uiTokenAmount?.amount ?? '0', 10);
    const delta   = preRaw - postRaw;
    if (delta > maxWsolDecrease) {
      const addr = keys[pre.accountIndex]?.pubkey?.toString() ?? keys[pre.accountIndex]?.toString() ?? null;
      if (addr) { poolQuoteVault = addr; maxWsolDecrease = delta; }
    }
  }

  // Fallback: native SOL gain at fee payer (seller receives native SOL)
  const nativeSolGained = (postSol[0] ?? 0) - (preSol[0] ?? 0);
  const solReceived = maxWsolDecrease > 0
    ? maxWsolDecrease / 1e9
    : (nativeSolGained > 0 ? nativeSolGained / 1e9 : 0);

  if (solReceived < 0.0001) return null; // filter dust/fee-only txns

  // Extract seller wallet address: prefer preTokenBalances seller account owner if available
  let tokenSenderOwner: string | null = null;
  for (const pre of preTok) {
    if (pre.mint !== targetMint) continue;
    const post    = postTok.find((p: any) => p.accountIndex === pre.accountIndex && p.mint === targetMint);
    const preRaw  = parseInt(pre.uiTokenAmount?.amount ?? '0', 10);
    const postRaw = parseInt(post?.uiTokenAmount?.amount ?? '0', 10);
    if (preRaw > postRaw && pre.owner && pre.owner !== poolBaseVault) {
      tokenSenderOwner = pre.owner;
      break;
    }
  }

  const wallet = tokenSenderOwner || feePayerAddr || 'unknown';
  return { wallet, solReceived, poolBaseVault, poolQuoteVault };
}

// ── DB persistence (survives Render free-tier spin-down / restarts) ───────────

async function saveSniperPosition(pos: SniperPosition): Promise<void> {
  try {
    await query(
      `INSERT INTO sniper_positions
        (id, mint, name, symbol, entry_price, entry_mcap, entry_time, size_sol, size_pct,
         peak_price, last_price, last_liquidity, baseline_liquidity, migration_time, pnl_pct,
         tp1_hit, tp2_hit, tp3_hit, initial_size_sol, remaining_size_sol, banked_sol,
         tp_tier, trigger_amount_usd, current_sl_price, buy_detected_timestamp, entry_delay_ms,
         entry_mode, entry_score, qualifying_wallets_count, buyer_wallet, price_source,
         price_at_detection, actual_slippage_pct, max_slippage_pct, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,'OPEN')
       ON CONFLICT (id) DO UPDATE SET
         peak_price        = EXCLUDED.peak_price,
         last_price        = EXCLUDED.last_price,
         last_liquidity    = EXCLUDED.last_liquidity,
         pnl_pct           = EXCLUDED.pnl_pct,
         size_sol          = EXCLUDED.size_sol,
         tp1_hit           = EXCLUDED.tp1_hit,
         tp2_hit           = EXCLUDED.tp2_hit,
         tp3_hit           = EXCLUDED.tp3_hit,
         remaining_size_sol = EXCLUDED.remaining_size_sol,
         banked_sol        = EXCLUDED.banked_sol,
         current_sl_price  = EXCLUDED.current_sl_price`,
      [pos.id, pos.mint, pos.name, pos.symbol, pos.entryPrice, pos.entryMcap ?? 0, pos.entryTime,
       pos.sizeSol, pos.sizePct, pos.peakPrice, pos.lastPrice, pos.lastLiquidity,
       pos.baselineLiquidity, pos.migrationTime, pos.pnlPct,
       pos.tp1Hit, pos.tp2Hit, pos.tp3Hit,
       pos.initialSizeSol, pos.remainingSizeSol, pos.bankedSol,
       pos.tpTier, pos.triggerAmountUsd, pos.currentSLPrice,
       pos.buyDetectedTimestamp ?? null, pos.entryDelayMs ?? null,
       pos.entryMode ?? null, pos.entryScore ?? null, pos.qualifyingWalletsCount ?? null,
       pos.buyerWallet ?? null, pos.priceSource ?? null,
       pos.priceAtDetection ?? null, pos.actualSlippagePct ?? null, pos.maxSlippagePct ?? null],
    );
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'Sniper engine: failed to persist position');
  }
}

async function closeSniperPositionInDB(id: string, closeReason: string, closePnlPct: number): Promise<void> {
  try {
    await query(
      `UPDATE sniper_positions SET status = 'CLOSED', close_time = $2, close_reason = $3, close_pnl_pct = $4 WHERE id = $1`,
      [id, Date.now(), closeReason, closePnlPct],
    );
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'Sniper engine: failed to persist position close');
  }
}

export async function restoreSniperPositionsFromDB(): Promise<void> {
  try {
    const rows = await query<any>(`SELECT * FROM sniper_positions WHERE status = 'OPEN' ORDER BY entry_time ASC`);
    for (const r of rows) {
      const rawSize   = Number(r.size_sol);
      const initSize  = Number(r.initial_size_sol ?? 0) || rawSize;
      const remSize   = Number(r.remaining_size_sol ?? 0) || rawSize;
      const entryP    = Number(r.entry_price);
      const storedSL  = Number(r.current_sl_price ?? 0);
      const pos: SniperPosition = {
        id: r.id, mint: r.mint, name: r.name, symbol: r.symbol,
        entryPrice: entryP, entryMcap: Number(r.entry_mcap ?? 0),
        entryTime: Number(r.entry_time),
        sizeSol: remSize, sizePct: Number(r.size_pct),
        peakPrice: Number(r.peak_price), lastPrice: Number(r.last_price),
        lastLiquidity: Number(r.last_liquidity), baselineLiquidity: Number(r.baseline_liquidity),
        migrationTime: Number(r.migration_time), pnlPct: Number(r.pnl_pct),
        tp1Hit:           Boolean(r.tp1_hit),
        tp2Hit:           Boolean(r.tp2_hit),
        tp3Hit:           Boolean(r.tp3_hit),
        initialSizeSol:   initSize,
        remainingSizeSol: remSize,
        bankedSol:        Number(r.banked_sol ?? 0),
        tpTier:           (Number(r.tp_tier ?? 1) as 1 | 2 | 3),
        triggerAmountUsd: Number(r.trigger_amount_usd ?? 0),
        currentSLPrice:   storedSL > 0 ? storedSL : entryP * (1 - PRICE_SL_PCT),
        buyDetectedTimestamp: r.buy_detected_timestamp ? Number(r.buy_detected_timestamp) : undefined,
        entryDelayMs:      r.entry_delay_ms ? Number(r.entry_delay_ms) : undefined,
        entryMode:         r.entry_mode ?? undefined,
        entryScore:        r.entry_score !== null && r.entry_score !== undefined ? Number(r.entry_score) : undefined,
        qualifyingWalletsCount: r.qualifying_wallets_count !== null && r.qualifying_wallets_count !== undefined ? Number(r.qualifying_wallets_count) : undefined,
        buyerWallet:       r.buyer_wallet ?? undefined,
        priceSource:       r.price_source ?? undefined,
        priceAtDetection:  r.price_at_detection !== null && r.price_at_detection !== undefined ? Number(r.price_at_detection) : undefined,
        actualSlippagePct: r.actual_slippage_pct !== null && r.actual_slippage_pct !== undefined ? Number(r.actual_slippage_pct) : undefined,
        maxSlippagePct:    r.max_slippage_pct !== null && r.max_slippage_pct !== undefined ? Number(r.max_slippage_pct) : undefined,
      };
      openPositions.set(pos.mint, pos);
    }
    const closedRows = await query<any>(
      `SELECT * FROM sniper_positions WHERE status = 'CLOSED' ORDER BY close_time DESC LIMIT 200`,
    );
    for (const r of closedRows) {
      const rawSize = Number(r.size_sol);
      closedPositions.push({
        id: r.id, mint: r.mint, name: r.name, symbol: r.symbol,
        entryPrice: Number(r.entry_price), entryMcap: Number(r.entry_mcap ?? 0),
        entryTime: Number(r.entry_time),
        sizeSol: rawSize, sizePct: Number(r.size_pct),
        peakPrice: Number(r.peak_price), lastPrice: Number(r.last_price),
        lastLiquidity: Number(r.last_liquidity), baselineLiquidity: Number(r.baseline_liquidity),
        migrationTime: Number(r.migration_time), pnlPct: Number(r.pnl_pct),
        closeTime: Number(r.close_time), closeReason: r.close_reason ?? '', closePnlPct: Number(r.close_pnl_pct ?? 0),
        tp1Hit: Boolean(r.tp1_hit), tp2Hit: Boolean(r.tp2_hit), tp3Hit: Boolean(r.tp3_hit),
        initialSizeSol: Number(r.initial_size_sol ?? 0) || rawSize,
        remainingSizeSol: Number(r.remaining_size_sol ?? 0) || rawSize,
        bankedSol: Number(r.banked_sol ?? 0),
        tpTier: (Number(r.tp_tier ?? 1) as 1 | 2 | 3),
        triggerAmountUsd: Number(r.trigger_amount_usd ?? 0),
        currentSLPrice: Number(r.current_sl_price ?? 0),
        buyDetectedTimestamp: r.buy_detected_timestamp ? Number(r.buy_detected_timestamp) : undefined,
        entryDelayMs:      r.entry_delay_ms ? Number(r.entry_delay_ms) : undefined,
        entryMode:         r.entry_mode ?? undefined,
        entryScore:        r.entry_score !== null && r.entry_score !== undefined ? Number(r.entry_score) : undefined,
        qualifyingWalletsCount: r.qualifying_wallets_count !== null && r.qualifying_wallets_count !== undefined ? Number(r.qualifying_wallets_count) : undefined,
        buyerWallet:       r.buyer_wallet ?? undefined,
        priceSource:       r.price_source ?? undefined,
        priceAtDetection:  r.price_at_detection !== null && r.price_at_detection !== undefined ? Number(r.price_at_detection) : undefined,
        actualSlippagePct: r.actual_slippage_pct !== null && r.actual_slippage_pct !== undefined ? Number(r.actual_slippage_pct) : undefined,
        maxSlippagePct:    r.max_slippage_pct !== null && r.max_slippage_pct !== undefined ? Number(r.max_slippage_pct) : undefined,
      });
    }
    logger.info({ open: rows.length, closed: closedRows.length }, 'Sniper engine: restored positions from DB after restart');
    // Belt-and-suspenders: populate everTradedMints from ALL position rows
    // (open + closed) as a supplementary source. If the traded_mints
    // table ever has a gap (e.g. DB write failed silently after a successful
    // entry), this ensures a previously-traded mint can never be re-entered
    // after a restart, regardless of the state of traded_mints.
    for (const r of rows)       everTradedMints.add(r.mint);
    for (const r of closedRows) everTradedMints.add(r.mint);
    logger.info({ size: everTradedMints.size }, 'Sniper engine: everTradedMints back-filled from position history');
    // Push restored state to any frontend clients that connected before the DB
    // restore completed. Without this broadcast, the frontend sees empty
    // closedPositions on initial load and has no way to know it should refresh.
    broadcastSniperStatus();
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'Sniper engine: failed to restore positions from DB');
  }
}

// ── Freeze-authority check ────────────────────────────────────────────────────
// SPL Token mint layout (82 bytes):
//   0–3  mint_authority COption header (0=None, 1=Some)
//   4–35 mint_authority pubkey
//   36–43 supply (u64)
//   44   decimals
//   45   is_initialized
//   46–49 freeze_authority COption header (0=None, 1=Some) ← we check this
//   50–81 freeze_authority pubkey
// Returns true only when freeze_authority is confirmed present.
// On RPC failure returns false (fail-open) so a network hiccup never blocks entry.
async function isMintFreezable(mint: string): Promise<boolean> {
  try {
    const conn = getConn();
    const info = await withHeliusLimit(
      () => conn.getAccountInfo(new PublicKey(mint), 'confirmed'),
      { priority: false },
    ).catch(() => null);
    if (!info?.data || info.data.length < 50) return false;
    const freezeOption = info.data.readUInt32LE(46);
    return freezeOption === 1;
  } catch {
    return false; // fail-open: don't block on RPC errors
  }
}

// ── Position entry ────────────────────────────────────────────────────────────

async function enterSniperPosition(
  mint: string, name: string, symbol: string,
  sizePct: number, triggerAmountUsd: number,
  priceAtDetection: number, buyerWallet: string,
  buyDetectedTimestamp: number,
  tpTier: 1 | 2 | 3,
  entryMode: 'solo' | 'consensus' = 'solo',
  entryScore: number = 0,
  qualifyingWalletsCount: number = 1,
  maxSlippagePctOverride?: number,
  qualifyingWallets: string[] = [],
): Promise<void> {
  // Synchronous reservation — no `await` happens between the check and the
  // lock being taken, so two overlapping calls for the same mint (e.g. from
  // an overlapping poll cycle) cannot both pass this guard.
  // `everTradedMints` is the lifetime gate: a mint that has EVER been entered
  // (open or closed, this session or a previous one) can never be entered again.
  if (openPositions.has(mint) || entryLocks.has(mint) || everTradedMints.has(mint) || slippageSkippedMints.has(mint)) return;
  entryLocks.add(mint);

  try {
    // Market metadata (liquidity, mcap, name, symbol) is DexScreener-backed and
    // was previously fetched here with a blocking await — adding up to 6s to
    // EVERY entry for display-only data we already have a placeholder for.
    // It is not needed to compute the entry price (that comes from on-chain
    // vault reads below), so it's deferred to a fire-and-forget refresh that
    // patches the position/tracked-token record once it lands.
    const tok = trackedTokens.get(mint);
    let liquidityAtEntry = tok?.liquidity ?? 0;
    let mcapAtEntry = tok?.mcap ?? 0;

    // ── Slippage guard ─────────────────────────────────────────────────────────
    let maxSlippage = 20;
    try {
      const s = await getSettings();
      maxSlippage = s.sniperSlippagePct ?? 20;
    } catch { /* use default */ }
    if (maxSlippagePctOverride !== undefined) maxSlippage = maxSlippagePctOverride;

    // Re-check after the async gaps above — belt-and-suspenders.
    if (openPositions.has(mint)) return;

    // Mark entryTriggered BEFORE the delay so validateOrPrune cannot prune
    // this token during the wait window.
    if (tok) tok.entryTriggered = true;

    // ── 2-second entry delay ─────────────────────────────────────────────────
    // We do NOT fetch price before this delay:
    //   • the pool address may not yet be resolved (enrichTokenMetadataAsync is
    //     async and takes 5-15s);
    //   • on-chain reserve reads would return the stale pre-buyer pool state
    //     if RPC is lagging or rate-limited;
    //   • DexScreener lags 30-120s and would return an even older price.
    // Instead we wait, then fetch ONCE — by that time Jupiter has the token,
    // DexScreener has often updated, and the pool address is more likely set.
    // If the fetch still fails, we fall back to priceAtDetection (the buyer's
    // verified on-chain avg price from the tx), which is far more accurate than
    // any stale cached value.
    await new Promise(r => setTimeout(r, ENTRY_DELAY_MS));
    if (openPositions.has(mint)) return;

    // Read the latest state of trackedTokens — enrichment may have run during the delay.
    const tok2 = trackedTokens.get(mint);

    // ── Price fetch priority after the 2s wait ───────────────────────────────
    // 1. Direct vault read from buyer's tx (ground truth — no pool addr resolution needed)
    // 2. On-chain reserve ratio via DexScreener pool address (if enrichment has resolved it)
    // 3. Jupiter quote (no pool address needed)
    // If all fail: skip entry — never fall back to DexScreener priceUsd (it's 30-120s stale)
    await fetchSolPrice().catch(() => {}); // ensure SOL price is fresh for all paths

    let delayedPrice = 0;
    let priceSource: 'vault' | 'pool-account' | 'jupiter' = 'vault';

    // Path 1: direct vault balance read — extracted from buyer's buy tx
    if (tok2?.poolBaseVault && tok2?.poolQuoteVault) {
      delayedPrice = await fetchPriceFromVaults(tok2.poolBaseVault, tok2.poolQuoteVault, cachedSolPrice, true).catch(() => 0);
    }

    // Path 2: on-chain reserve ratio via pool account (requires DexScreener pool addr)
    if (delayedPrice === 0 && tok2?.poolAddress) {
      delayedPrice = await fetchOnChainReservePrice(tok2.poolAddress, cachedSolPrice, true).catch(() => 0);
      if (delayedPrice > 0) { priceSource = 'pool-account'; logger.info({ mint: mint.slice(0, 12), price: delayedPrice, source: 'pool-account' }, 'Sniper engine: spot price (pool account fallback)'); }
    }

    // Path 3: Jupiter quote (on-chain-derived, no pool address needed)
    if (delayedPrice === 0) {
      delayedPrice = await fetchPriceFresh(mint, undefined).catch(() => 0); // pairAddress=undefined → skips on-chain read, goes straight to Jupiter
      if (delayedPrice > 0) priceSource = 'jupiter';
    }

    // Do NOT fall back to DexScreener priceUsd — it's 30-120s stale on fresh tokens
    // and will return the pre-buyer-pump price, making our entry price completely wrong.
    if (delayedPrice === 0) {
      logger.warn({ mint: mint.slice(0, 12), symbol }, 'Sniper engine: all price sources failed — skipping entry (will retry on next buyer buy)');
      void diagTechError('PRICE_FETCH_FAILED', 'All price sources failed — entry skipped', mint.slice(0, 12)).catch(() => {});
      if (tok) tok.entryTriggered = false; // allow future qualifying buys to trigger
      return;
    }

    const finalEntryPrice = delayedPrice;

    // Price filter (double-check with resolved entry price): only enter tokens below $0.001.
    // priceAtDetection was already checked in handleVolumeUpdate, but the entry price may
    // differ after the delay — re-verify here before committing capital.
    if (finalEntryPrice >= 0.001) {
      logger.info(
        { mint: mint.slice(0, 12), symbol, price: finalEntryPrice },
        'Sniper engine: entry price >= $0.001 — entry skipped (price filter)',
      );
      void diagTokenRejected(mint, `Entry price ${finalEntryPrice.toFixed(6)} >= $0.001`).catch(() => {});
      if (tok) tok.entryTriggered = false;
      return;
    }

    const entryTimestamp = Date.now();
    const entryDelayMs   = entryTimestamp - buyDetectedTimestamp;

    // ── Slippage check (single, post-delay) ──────────────────────────────────
    // Compare our actual entry price against the buyer's on-chain avg price.
    // If the token pumped more than maxSlippage% in the wait window, skip.
    if (priceAtDetection > 0) {
      const finalSlipPct = ((finalEntryPrice - priceAtDetection) / priceAtDetection) * 100;
      if (finalSlipPct > maxSlippage) {
        logger.warn(
          { mint: mint.slice(0, 12), symbol, finalSlipPct: finalSlipPct.toFixed(1), maxSlippage },
          'Sniper engine: post-delay slippage exceeded — skipped',
        );
        notifySniperSkip({
          name, symbol, mint, buyAmountUsd: triggerAmountUsd,
          reason: `Slippage ${finalSlipPct.toFixed(1)}% > ${maxSlippage}% max`,
          entryPrice: finalEntryPrice, priceAtBuyDetection: priceAtDetection, maxSlippagePct: maxSlippage,
        }).catch(() => {});
        // Permanently block this mint — it already pumped past our threshold
        // before we could enter; future buyer buys on the same token would face
        // the same or worse slippage so we never attempt it again.
        markMintSlippageSkipped(mint, finalSlipPct).catch(() => {});
        if (tok) tok.entryTriggered = false;
        return;
      }
    }

    logger.info(
      { mint: mint.slice(0, 12), symbol,
        priceAtBuyDetection: priceAtDetection, ourEntryPrice: finalEntryPrice,
        priceDeltaPct: priceAtDetection > 0
          ? (((finalEntryPrice - priceAtDetection) / priceAtDetection) * 100).toFixed(2) + '%'
          : 'n/a',
        buyDetectedAt: new Date(buyDetectedTimestamp).toISOString(),
        ourEntryAt: new Date(entryTimestamp).toISOString(),
        entryDelayMs },
      'Sniper engine: entering after delay — price fetched post-delay',
    );

    const balance = await getBalance().catch(() => 10);
    const sizeSol = balance * (sizePct / 100);
    const liquidity = liquidityAtEntry;

    const pos: SniperPosition = {
      id: `${mint}-${Date.now()}`,
      mint, name, symbol,
      entryPrice: finalEntryPrice, entryMcap: mcapAtEntry,
      entryTime: entryTimestamp,
      sizeSol, sizePct,
      peakPrice:   finalEntryPrice,
      lastPrice:   finalEntryPrice,
      lastLiquidity: liquidity,
      baselineLiquidity: liquidity > 0 ? liquidity : 1,
      migrationTime: tok?.migrationTime ?? Date.now(),
      pnlPct: 0,
      // Multi-stage TP
      tp1Hit: false, tp2Hit: false, tp3Hit: false,
      initialSizeSol:    sizeSol,
      remainingSizeSol:  sizeSol,
      bankedSol:         0,
      tpTier,
      triggerAmountUsd,
      currentSLPrice:    finalEntryPrice * (1 - PRICE_SL_PCT),
      // Timing
      buyDetectedTimestamp,
      entryDelayMs,
      // Entry checklist
      entryMode, entryScore, qualifyingWalletsCount,
      buyerWallet,
      priceSource,
      priceAtDetection,
      actualSlippagePct: priceAtDetection > 0 ? ((finalEntryPrice - priceAtDetection) / priceAtDetection) * 100 : 0,
      maxSlippagePct: maxSlippage,
    };

    openPositions.set(mint, pos);
    void saveSniperPosition(pos);
    void markMintTraded(mint);
    void diagTokenTraded(mint, {
      entryTime:              entryTimestamp,
      entryPrice:             finalEntryPrice,
      entryMc:                mcapAtEntry,
      walletScore:            entryScore,
      qualifyingWalletsCount,
      entryMode,
      riskTier:               `Tier ${tpTier}`,
      entryReason:            entryMode === 'solo'
        ? `Solo conviction (score ${entryScore} >= 95)`
        : `Consensus (${qualifyingWalletsCount} wallets >= 80)`,
    }).catch(() => {});

    if (tok) tok.entryTriggered = true;

    await adjustBalance(-sizeSol).catch(() => {});

    logger.info(
      { mint, symbol, sizePct, sizeSol: sizeSol.toFixed(3), entryPrice: finalEntryPrice, trigger: triggerAmountUsd.toFixed(0) },
      'Sniper engine: ENTERED',
    );

    notifySniperTrade({
      name, symbol, mint,
      buyAmountUsd: triggerAmountUsd,
      sizePct, sizeSol, entryPrice: finalEntryPrice,
      priceAtBuyDetection: priceAtDetection,
      slippagePct: maxSlippage,
      buyerWallet,
      qualifyingWallets,
      entryMode, entryScore, qualifyingWalletsCount,
      priceSource, tpTier,
    }).catch(() => {});

    broadcastSniperStatus();

    // Fire-and-forget: backfill name/symbol/mcap/liquidity from DexScreener
    // now that the position is already live — this used to block entry by
    // up to 6s for purely cosmetic/display data.
    void refineEntryMetadataInBackground(mint);
  } finally {
    entryLocks.delete(mint);
  }
}

/** Backfills DexScreener-sourced display metadata (name/symbol/mcap/liquidity)
 * onto an already-open position and its tracked-token record, without
 * blocking the entry that already happened on ground-truth on-chain price. */
async function refineEntryMetadataInBackground(mint: string): Promise<void> {
  try {
    const marketData = await fetchTokenPrice(mint);
    if (marketData.price <= 0 && !marketData.name) return; // nothing useful came back

    const tok = trackedTokens.get(mint);
    if (tok) {
      if ((tok.name.endsWith('…') || !tok.symbol) && marketData.name) {
        tok.name = marketData.name;
        tok.symbol = marketData.symbol || tok.symbol;
      }
      if (marketData.liquidity > 0) tok.liquidity = marketData.liquidity;
      if (marketData.mcap > 0) tok.mcap = marketData.mcap;
    }

    const pos = openPositions.get(mint);
    if (pos) {
      if ((pos.name.endsWith('…') || !pos.symbol) && marketData.name) {
        pos.name = marketData.name;
        pos.symbol = marketData.symbol || pos.symbol;
      }
      if (marketData.mcap > 0 && pos.entryMcap === 0) pos.entryMcap = marketData.mcap;
      // baselineLiquidity only had a chance to be a real value if the caller
      // knew it before entry — if entry started with no liquidity data at all
      // (baselineLiquidity fell back to 1), seed it now so the liquidity-drop
      // exit guard has real reserve data to compare against.
      if (marketData.liquidity > 0 && pos.baselineLiquidity <= 1) {
        pos.baselineLiquidity = marketData.liquidity;
        pos.lastLiquidity = marketData.liquidity;
      }
      broadcastSniperStatus();
    }
  } catch { /* non-fatal — display-only data */ }
}

// ── Trading window (IST) ─────────────────────────────────────────────────────

/**
 * Returns true if the current IST time is within the configured trading window.
 * When tradingWindowEnabled is false, always returns true (no restriction).
 *
 * "00:00" as an end time is treated as midnight = end of calendar day (1440 min).
 * Supports cross-midnight windows like 22:00→06:00 automatically.
 */
/** Returns the current time-of-day in IST as total minutes since midnight (0–1439). */
function getISTMinutes(): number {
  // Intl.DateTimeFormat with timeZone:'Asia/Kolkata' is the only correct way to
  // get IST regardless of the host server's local timezone setting.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0', 10);
  const m = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  // Intl may return hour=24 for midnight in some environments; normalise to 0.
  return (h % 24) * 60 + m;
}

function isInTradingWindow(settings: { tradingWindowEnabled: boolean; tradingWindowStart: string; tradingWindowEnd: string }): boolean {
  if (!settings.tradingWindowEnabled) return true;

  const currentMin = getISTMinutes();

  const [sh, sm] = (settings.tradingWindowStart || '17:00').split(':').map(Number);
  const [eh, em] = (settings.tradingWindowEnd   || '00:00').split(':').map(Number);

  const startMin = sh * 60 + (sm || 0);
  // "00:00" end → treat as 1440 (end of calendar day = just-before-midnight)
  const endMin   = (eh === 0 && (em || 0) === 0) ? 1440 : eh * 60 + (em || 0);

  if (startMin < endMin) {
    // Normal same-day window: e.g. 17:00→00:00 (→1440), 09:00→17:00
    return currentMin >= startMin && currentMin < endMin;
  } else {
    // Cross-midnight window: e.g. 22:00→06:00
    return currentMin >= startMin || currentMin < endMin;
  }
}

// ── Queue / slot management ───────────────────────────────────────────────────

function enqueueSignal(
  mint: string, name: string, symbol: string, sizePct: number, amountUsd: number,
  priceAtDetection: number, buyerWallet: string, buyDetectedTimestamp: number, tpTier: 1 | 2 | 3,
  entryMode: 'solo' | 'consensus', entryScore: number, qualifyingWalletsCount: number, maxSlippagePctAtQueue: number,
  qualifyingWallets: string[] = [],
): void {
  if (everTradedMints.has(mint) || slippageSkippedMints.has(mint)) return;
  if (signalQueue.find(s => s.mint === mint)) return;
  signalQueue.push({
    mint, name, symbol, sizePct, triggerAmountUsd: amountUsd, queuedAt: Date.now(), priceAtDetection, buyerWallet,
    buyDetectedTimestamp, tpTier, entryMode, entryScore, qualifyingWalletsCount, qualifyingWallets, maxSlippagePctAtQueue,
  });
  logger.info({ mint, symbol, sizePct, reason: 'max 10 positions' }, 'Sniper engine: signal queued');
}

async function processQueue(): Promise<void> {
  // Don't dequeue if we're outside the trading window
  try {
    const s = await getSettings();
    if (!isInTradingWindow(s)) return;
  } catch { return; }

  while (signalQueue.length > 0 && openPositions.size < MAX_POSITIONS) {
    const sig = signalQueue.shift()!;
    const tok  = trackedTokens.get(sig.mint);
    if (!tok || Date.now() > tok.expiresAt) continue;
    if (openPositions.has(sig.mint) || everTradedMints.has(sig.mint) || slippageSkippedMints.has(sig.mint)) continue;
    await enterSniperPosition(
      sig.mint, sig.name, sig.symbol, sig.sizePct, sig.triggerAmountUsd, sig.priceAtDetection, sig.buyerWallet, sig.buyDetectedTimestamp, sig.tpTier,
      sig.entryMode, sig.entryScore, sig.qualifyingWalletsCount, sig.maxSlippagePctAtQueue, sig.qualifyingWallets,
    );
  }
}

// ── Smart Wallet Consensus — buy-detection handler ────────────────────────────
// Called for every detected transaction (buy OR sell) on a tracked token.
// Only buys are evaluated for entry. Each buyer wallet is scored via GMGN
// (wallet-score.service.ts, cached) and checked against the consensus rules
// (wallet-consensus.service.ts):
//   • score >= 95              → enter immediately, solo conviction (1% risk)
//   • 2+ distinct wallets >=80 → enter on consensus within a 5-min window (1% risk)
// Sell transactions are recorded for display only — they never trigger entries.

async function handleVolumeUpdate(
  mint: string, wallet: string, txUsd: number, txSig: string,
  priceAtDetection: number, txTimestamp: number,
  txType: 'buy' | 'sell',
): Promise<void> {
  const tok = trackedTokens.get(mint);
  if (!tok) return;

  const detectedAt = Date.now();
  // Dedup: replays re-enter this function with the same txSig — don't double-record in buyerActivity.
  if (!tok.buyerActivity.some(b => b.txSig === txSig)) {
    tok.buyerActivity.push({ wallet, amountUsd: txUsd, timestamp: txTimestamp, detectedAt, txSig, priceAtDetection });
  }

  // Score every transaction through GMGN. Sells are observational only, but
  // they still get the same wallet-quality audit as buys.
  let scoreResult: WalletScoreBreakdown;
  try {
    scoreResult = await getWalletScore(wallet);
  } catch {
    scoreResult = {
      wallet, score: 0, winRate: null, avgRoiPct: null, completedTrades: null,
      walletAgeDays: null, avgHoldMinutes: null,
      scorePoints: { winRate: 0, walletAge: 0, completedTrades: 0, roi: 0, holdTime: 0 },
      scoreSource: 'unavailable', scoreStatus: 'unavailable', computedAt: Date.now(),
    };
  }

  const persistAudit = (decision: string, decisionReason: string, mode?: string, qualifyingWallets = 0): void => {
    void diagTransactionAudited({
      txSignature: txSig,
      mint,
      txType,
      wallet,
      amountUsd: txUsd,
      txTimestamp,
      detectedAt,
      priceAtDetection,
      decision,
      decisionReason,
      score: scoreResult,
      consensusMode: mode,
      qualifyingWallets,
    }).catch(() => {});
  };

  if (txType !== 'buy') {
    const sellEntry: BuyerActivityLog = {
      mint, name: tok.name, symbol: tok.symbol,
      wallet, amountUsd: txUsd, timestamp: txTimestamp, detectedAt, txSig,
      txType: 'sell',
      entered: false,
      priceAtDetection,
      walletScore: scoreResult.score,
      consensusMode: 'none',
      qualifyingWalletsCount: 0,
      gmgnScore: scoreResult,
      skipReason: 'Sell observed — scored by GMGN, never used as an entry trigger',
    };
    buyLog.unshift(sellEntry);
    if (buyLog.length > MAX_BUY_LOG) buyLog.pop();
    persistAudit('SELL_OBSERVED', sellEntry.skipReason ?? 'Sell observed', 'none');
    broadcastSniperStatus();
    return; // sells never trigger entries under Smart Wallet Consensus
  }

  // ── Trading window gate ───────────────────────────────────────────────────
  // Build a partial entry now so we can push to buyLog BEFORE bailing —
  // the signal feed should always show detected transactions, even those
  // that are outside the trading window or when settings are unavailable.
  let outsideTradingWindow = false;
  try {
    const s = await getSettings();
    if (!isInTradingWindow(s)) {
      outsideTradingWindow = true;
    }
  } catch {
    // If settings are unavailable, block entry to be safe but still log it.
    const entry: BuyerActivityLog = {
      mint, name: tok.name, symbol: tok.symbol,
      wallet, amountUsd: txUsd, timestamp: txTimestamp, detectedAt, txSig,
      txType: 'buy',
      entered: false, priceAtDetection,
      walletScore: scoreResult.score, consensusMode: 'none', qualifyingWalletsCount: 0,
      gmgnScore: scoreResult,
      skipReason: 'Settings unavailable — entry blocked',
    };
    persistAudit('REJECTED', 'Settings unavailable — entry blocked', 'none');
    buyLog.unshift(entry);
    if (buyLog.length > MAX_BUY_LOG) buyLog.pop();
    broadcastSniperStatus();
    return;
  }
  if (outsideTradingWindow) {
    logger.info({ mint, symbol: tok.symbol }, 'Sniper engine: outside trading window — entry skipped');
    const entry: BuyerActivityLog = {
      mint, name: tok.name, symbol: tok.symbol,
      wallet, amountUsd: txUsd, timestamp: txTimestamp, detectedAt, txSig,
      txType: 'buy',
      entered: false, priceAtDetection,
      walletScore: scoreResult.score, consensusMode: 'none', qualifyingWalletsCount: 0,
      gmgnScore: scoreResult,
      skipReason: 'Outside trading window',
    };
    persistAudit('REJECTED', 'Outside trading window', 'none');
    buyLog.unshift(entry);
    if (buyLog.length > MAX_BUY_LOG) buyLog.pop();
    broadcastSniperStatus();
    return;
  }

  // Wallet score lookup is async (GMGN, cached) — awaited here so the entry
  // decision has the score, but this never blocks OTHER tracked mints: each
  // mint's poll/WS callback fires independently (`void pollTokenBuys(mint)`).
  let result: ConsensusResult;
  try {
    result = await evaluateBuy(mint, wallet, txTimestamp, scoreResult);
  } catch (err: any) {
    // getWalletScore/evaluateBuy are designed to never throw (they fail safe
    // to a 0 score), so reaching this catch means something unexpected broke.
    // Elevated to warn — this was silently swallowed at debug level before,
    // making GMGN failures invisible in production logs.
    logger.warn({ mint: mint.slice(0, 12), err: err?.message }, 'Sniper engine: consensus evaluation failed — skipping buy');
    void diagTechError('CONSENSUS_EVAL_FAILED', err?.message ?? 'unknown error', mint.slice(0, 12)).catch(() => {});
    persistAudit('REJECTED', `Consensus evaluation failed: ${err?.message ?? 'unknown error'}`, 'none');
    return;
  }

  const entry: BuyerActivityLog = {
    mint, name: tok.name, symbol: tok.symbol,
    wallet, amountUsd: txUsd, timestamp: txTimestamp, detectedAt, txSig,
      txType: 'buy',
    entered: false, priceAtDetection,
    walletScore: result.score, consensusMode: result.mode,
    qualifyingWalletsCount: result.qualifyingWallets.length,
      gmgnScore: result.scoreBreakdown,
  };

  // ── Diagnostic: record every evaluated buy (fire-and-forget) ─────────────
  void diagTokenScanned(mint, {
    name:   tok.name,
    symbol: tok.symbol,
    currentMc:           tok.mcap,
    currentLiquidity:    tok.liquidity,
    currentVolume:       tok.volume24h,
    currentBuySellRatio: (tok.txnsH1Buys != null && tok.txnsH1Sells != null && tok.txnsH1Sells > 0)
      ? tok.txnsH1Buys / tok.txnsH1Sells : undefined,
    walletScore:            result.score,
    qualifyingWalletsCount: result.qualifyingWallets.length,
    ageMinutes:             (Date.now() - Math.min(tok.migrationTime, tok.pairCreatedAt && tok.pairCreatedAt > 0 ? tok.pairCreatedAt : Infinity)) / 60_000,
    passedWallet:           result.trigger,
  }).catch(() => {});

  if (!result.trigger) {
    if (result.mode === 'ban_queued') {
      // GMGN is rate-banned — park this buy and replay it once the ban lifts.
      banReplayQueue.push({ mint, wallet, txUsd, txSig, priceAtDetection, txTimestamp, queuedAt: Date.now() });
      entry.skipReason = 'GMGN rate-limited — queued for re-scoring when ban lifts (no buy skipped)';
      persistAudit('GMGN_RATE_LIMITED', entry.skipReason, result.mode, result.qualifyingWallets.length);
    } else {
      // Every evaluated buyer is logged for visibility, even scores below the
      // consensus threshold — the Smart Wallet Signal Feed is meant to show the
      // GMGN scoring model working, not just the buys that happened to qualify.
      entry.skipReason = result.mode === 'tracking'
        ? `Wallet score ${result.score} qualifies (>=80) — waiting for a 2nd qualifying wallet within 5 min (${result.qualifyingWallets.length}/2)`
        : `Wallet score ${result.score} below consensus threshold (80)`;
      persistAudit(result.mode === 'tracking' ? 'WAITING_CONSENSUS' : 'REJECTED', entry.skipReason, result.mode, result.qualifyingWallets.length);
    }
    buyLog.unshift(entry);
    if (buyLog.length > MAX_BUY_LOG) buyLog.pop();
    broadcastSniperStatus();
    return;
  }

  if (openPositions.has(mint) || tok.entryTriggered || entryLocks.has(mint) || everTradedMints.has(mint) || slippageSkippedMints.has(mint)) {
    entry.skipReason = slippageSkippedMints.has(mint)
      ? 'Slippage-skipped token (permanently blocked — pumped too fast before entry)'
      : entryLocks.has(mint)
      ? 'Entry already in progress for this token'
      : 'Already traded this token (lifetime — never re-entered)';
    persistAudit('REJECTED', entry.skipReason, result.mode, result.qualifyingWallets.length);
    buyLog.unshift(entry);
    if (buyLog.length > MAX_BUY_LOG) buyLog.pop();
    broadcastSniperStatus();
    return;
  }

  // ── Quality filters — evaluated before every entry ────────────────────────
  // These run after consensus triggers so the signal appears in the buy log
  // with a clear skip reason rather than silently disappearing.

  // Refresh market data immediately before quality filters.
  // tok.liquidity is updated by the batch refresh (~30s cycle for 2700+ tokens),
  // so cached data can be significantly stale when a wallet signal fires.
  // A fresh DexScreener fetch here ensures we use the latest available data.
  // DexScreener itself caches pool data for 30–120s; the on-chain fallback below
  // is the ground-truth override for tokens close to the $30k threshold.
  try {
    const freshData = await fetchTokenPrice(mint);
    if (freshData.liquidity > 0) {
      tok.liquidity     = freshData.liquidity;
      if (freshData.mcap > 0)   tok.mcap  = freshData.mcap;
      if (freshData.price > 0)  tok.price = freshData.price;
      tok.priceChange1h  = freshData.priceChange1h;
      tok.volume24h      = freshData.volume24h;
      if (!tok.pairCreatedAt && freshData.pairCreatedAt) tok.pairCreatedAt = freshData.pairCreatedAt;
    }
    logger.info(
      { mint: mint.slice(0, 12), freshLiq: (freshData.liquidity ?? 0).toFixed(0) },
      'Sniper engine: pre-entry fresh DexScreener fetch',
    );
  } catch { /* non-fatal — fall back to cached tok.liquidity */ }

  // ── On-chain liquidity ground-truth override ─────────────────────────────────
  // If DexScreener still shows liq below the $30k entry threshold and we have a
  // known pool address, read the WSOL vault balance directly from on-chain.
  // This bypasses DexScreener's 30–120s cache entirely and catches tokens that
  // have already crossed $30k in reality but appear below it in DexScreener.
  if ((tok.liquidity ?? 0) < 25_000 && tok.poolAddress) {
    try {
      await fetchSolPrice();
      const onChainLiq = await fetchOnChainLiqUsd(tok.poolAddress, cachedSolPrice);
      if (onChainLiq > 0) {
        logger.info(
          { mint: mint.slice(0, 12), dexLiq: (tok.liquidity ?? 0).toFixed(0), onChainLiq: onChainLiq.toFixed(0) },
          'Sniper engine: on-chain liq override at entry (DexScreener was stale)',
        );
        tok.liquidity = onChainLiq;
      }
    } catch { /* non-fatal */ }
  }

  // 1. Minimum pool liquidity: $25,000
  const liqAtSignal = tok.liquidity ?? 0;
  if (liqAtSignal < 25_000) {
    if (pendingConsensusSignals.has(mint)) {
      entry.skipReason = `Consensus signal already pending for this token (liq: $${liqAtSignal.toFixed(0)} < $25,000)`;
      persistAudit('PENDING_CONSENSUS_EXISTS', entry.skipReason, result.mode, result.qualifyingWallets.length);
      buyLog.unshift(entry); if (buyLog.length > MAX_BUY_LOG) buyLog.pop();
      broadcastSniperStatus(); return;
    }

    logger.info(
      { mint: mint.slice(0, 12), symbol: tok.symbol, liquidity: liqAtSignal.toFixed(0), wallets: result.qualifyingWallets.map(w => w.slice(0, 12)) },
      'PENDING CONSENSUS: liquidity below $25k threshold, monitoring for 20m',
    );

    pendingConsensusSignals.set(mint, {
      mint,
      name: tok.name,
      symbol: tok.symbol,
      qualifyingWallets: [...result.qualifyingWallets],
      consensusTimestamp: Date.now(),
      sizePct: result.sizePct,
      triggerAmountUsd: txUsd,
      priceAtDetection,
      buyerWallet: wallet,
      buyDetectedTimestamp: txTimestamp,
      tpTier: result.tpTier,
      entryMode: result.mode as 'solo' | 'consensus',
      entryScore: result.score,
      qualifyingWalletsCount: result.qualifyingWallets.length,
      scoreBreakdown: result.scoreBreakdown,
      txSig,
    });

    entry.skipReason = `PENDING CONSENSUS: low liquidity $${liqAtSignal.toFixed(0)} < $25,000 min (monitoring for 20m)`;
    persistAudit('PENDING_CONSENSUS', entry.skipReason, result.mode, result.qualifyingWallets.length);
    buyLog.unshift(entry); if (buyLog.length > MAX_BUY_LOG) buyLog.pop();
    broadcastSniperStatus(); return;
  }

  // 2. Minimum token age: 10 minutes from pool creation.
  // Use the EARLIEST of all available timestamps:
  //   - migrationTime: actual on-chain openTimestamp from GMGN (most accurate)
  //   - pairCreatedAt: when DexScreener *indexed* the pair (can lag by minutes after
  //     on-chain creation, so using it alone makes new pools look younger than they are)
  // Taking the minimum ensures we always use the oldest known reference point.
  const poolBornMs = Math.min(
    tok.migrationTime,
    tok.pairCreatedAt && tok.pairCreatedAt > 0 ? tok.pairCreatedAt : Infinity,
  );
  const ageMinutes = (Date.now() - poolBornMs) / 60_000;
  if (ageMinutes < 10) {
    entry.skipReason = `Token too new — ${ageMinutes.toFixed(1)} min old (min 10 min)`;
    void diagTokenRejected(mint, `Too new: ${ageMinutes.toFixed(1)} min old (min 10 min)`).catch(() => {});
    persistAudit('REJECTED', entry.skipReason, result.mode, result.qualifyingWallets.length);
    buyLog.unshift(entry); if (buyLog.length > MAX_BUY_LOG) buyLog.pop();
    broadcastSniperStatus(); return;
  }

  // 4. Skip tokens with freeze authority (freezable mint)
  const freezable = await isMintFreezable(mint);
  if (freezable) {
    entry.skipReason = 'Freeze authority present — token is freezable, skipped';
    void diagTokenRejected(mint, 'Freeze authority present').catch(() => {});
    persistAudit('REJECTED', entry.skipReason, result.mode, result.qualifyingWallets.length);
    buyLog.unshift(entry); if (buyLog.length > MAX_BUY_LOG) buyLog.pop();
    broadcastSniperStatus(); return;
  }

  // 5. Price filter: only enter tokens priced below $0.001
  if (priceAtDetection > 0 && priceAtDetection >= 0.001) {
    entry.skipReason = `Price $${priceAtDetection.toFixed(6)} >= $0.001 — entry skipped (price filter)`;
    void diagTokenRejected(mint, `Price ${priceAtDetection.toFixed(6)} >= $0.001`).catch(() => {});
    persistAudit('REJECTED', entry.skipReason, result.mode, result.qualifyingWallets.length);
    buyLog.unshift(entry); if (buyLog.length > MAX_BUY_LOG) buyLog.pop();
    broadcastSniperStatus(); return;
  }

  const modeLabel = result.mode === 'solo'
    ? `Solo conviction (score ${result.score} >= 95)`
    : `Consensus (${result.qualifyingWallets.length} wallets >= 80 within 5 min)`;

  let maxSlippageForQueue = 20;
  try { maxSlippageForQueue = (await getSettings()).sniperSlippagePct ?? 20; } catch { /* use default */ }

  if (openPositions.size >= MAX_POSITIONS) {
    entry.skipReason = `Max positions — queued (${modeLabel})`;
    enqueueSignal(
      mint, tok.name, tok.symbol, result.sizePct, txUsd, priceAtDetection, wallet, txTimestamp, result.tpTier,
      result.mode as 'solo' | 'consensus', result.score, result.qualifyingWallets.length, maxSlippageForQueue,
      result.qualifyingWallets,
    );
    persistAudit('QUEUED', entry.skipReason, result.mode, result.qualifyingWallets.length);
    buyLog.unshift(entry);
    if (buyLog.length > MAX_BUY_LOG) buyLog.pop();
    broadcastSniperStatus();
    return;
  }

  entry.entered = true;
  entry.skipReason = modeLabel;
  buyLog.unshift(entry);
  if (buyLog.length > MAX_BUY_LOG) buyLog.pop();
  persistAudit('ENTERED', modeLabel, result.mode, result.qualifyingWallets.length);
  broadcastSniperStatus();
  await enterSniperPosition(
    mint, tok.name, tok.symbol, result.sizePct, txUsd, priceAtDetection, wallet, txTimestamp, result.tpTier,
    result.mode as 'solo' | 'consensus', result.score, result.qualifyingWallets.length, undefined, result.qualifyingWallets,
  );
}

// ── Buy polling ───────────────────────────────────────────────────────────────

// `priority`: true when triggered by a WS logsNotification (the fast, real-time
// path) — these RPC calls jump ahead of routine background polling in the
// shared Helius queue (see helius-limiter.ts) so buy detection never sits
// behind housekeeping calls (market refresh, pool enrichment, validation).
// The scheduled fallback sweep (scheduleBuyPoll) calls this with priority=false.
async function pollTokenBuys(mint: string, priority = false): Promise<void> {
  // Per-mint concurrency guard — WS-triggered and scheduled polls must not
  // overlap for the same mint, or they'd both read the same "new" sigs before
  // either has had a chance to mark them seen.
  if (pollLocks.has(mint)) return;
  pollLocks.add(mint);

  // When Helius is rate-limit cooling, fall back to the public Solana RPC instead
  // of bailing out entirely — wallet transaction detection must keep flowing even
  // during Helius 429 backoff windows (up to 120s) or no buyers ever get scored.
  const usingFallback = isHeliusCoolingDown();
  const conn = usingFallback ? getPublicConn() : getConn();
  if (usingFallback) {
    logger.debug({ mint: mint.slice(0, 12) }, 'Sniper engine: Helius cooling — using public RPC fallback for buy detection');
  }

  // Helper: route RPC calls through the shared Helius rate-limiter when using
  // Helius, or call directly when on the public fallback (no shared budget).
  const rpcCall = <T>(fn: () => Promise<T>): Promise<T> =>
    usingFallback ? fn() : withHeliusLimit(fn, { priority });

  const pk   = new PublicKey(mint);

  if (!seenTxns.has(mint)) seenTxns.set(mint, new Set());
  const seen = seenTxns.get(mint)!;

  const tok = trackedTokens.get(mint);
  const pairAddr = tok?.poolAddress;

  try {
    // Detect whether this is a GMGN-discovered token (migrationTime = actual creation
    // time, potentially minutes in the past) vs a real-time Helius WS graduation
    // (migrationTime ≈ Date.now()). For GMGN tokens we use a smaller fetch window
    // and skip pagination entirely — fetching 1000 sigs + 5 pages for a 10-15 min
    // old token that may have thousands of historical transactions floods Helius and
    // blocks wallet scoring for all other tracked tokens in the sequential poll loop.
    const isHistoricalDiscovery = tok != null && tok.migrationTime < Date.now() - 3 * 60_000;

    // First poll: fetch a much larger window of sigs so we never truncate before
    // reaching the graduation moment — a delayed first poll (e.g. after Helius
    // rate-limit backoff) can otherwise have >100 sigs already posted, silently
    // hiding the earliest (and most important) buyer buys beyond the fetch window.
    // 1000 is the RPC's max per-call limit for getSignaturesForAddress.
    // For GMGN-discovered tokens we cap at 200 — enough to cover ~10 min of
    // activity on even the most active tokens, without pulling full history.
    const sigLimit = mintCheckpointed.has(mint) ? 30 : (isHistoricalDiscovery ? 200 : 1_000);
    const sigs = await rpcCall(() => conn.getSignaturesForAddress(pk, { limit: sigLimit }));
    if (!sigs.length) return;

    // First poll: baseline.
    // Mark all existing sigs as seen so we don't re-process them on future polls.
    // Also scan any that are RECENT (≤10 min old, after migration) — catches other buyers
    // who bought in the seconds after graduation while DexScreener was still catching up.
    if (!mintCheckpointed.has(mint)) {
      mintCheckpointed.add(mint);
      for (const s of sigs) seen.add(s.signature);

      const migrationSec   = tok ? Math.floor(tok.migrationTime / 1_000) : 0;
      const tenMinAgoSec   = Math.floor(Date.now() / 1_000) - 10 * 60;
      // For GMGN-discovered tokens (isHistoricalDiscovery=true), migrationTime is
      // the actual on-chain creation time — potentially 40+ min in the past.
      // Use migrationSec as the floor so we capture ALL transactions since launch,
      // not just the last 10 min. For real-time graduations, migrationTime ≈ now,
      // so Math.max correctly avoids pulling pre-graduation history.
      const earlyBuyFloor  = isHistoricalDiscovery ? migrationSec : Math.max(migrationSec, tenMinAgoSec);
      const earlyBuys    = sigs.filter(
        s => !s.err && s.blockTime != null && s.blockTime >= earlyBuyFloor,
      );

      // Fetch signatures may have hit the RPC page limit without reaching the
      // migration timestamp — that means there is unseen history further back.
      // Rather than silently missing it, page backwards with `before` until we
      // reach the migration time or run out of history.
      // Skip pagination for GMGN-discovered tokens — they set migrationTime to the
      // actual on-chain creation time, so the first 200 sigs already cover the full
      // 10-min scoring window. Paginating further only pulls older history we don't
      // need and generates a burst of Helius calls that 429s the whole pipeline.
      if (!isHistoricalDiscovery && sigs.length === sigLimit) {
        let before = sigs[sigs.length - 1].signature;
        for (let page = 0; page < 5; page++) {
          const older = await rpcCall(() => conn.getSignaturesForAddress(pk, { limit: 1_000, before })).catch(() => []);
          if (!older.length) break;
          for (const s of older) seen.add(s.signature);
          const olderEarly = older.filter(
            s => !s.err && s.blockTime != null && s.blockTime >= migrationSec,
          );
          earlyBuys.push(...olderEarly);
          const oldestBlockTime = older[older.length - 1]?.blockTime ?? 0;
          before = older[older.length - 1].signature;
          if (oldestBlockTime > 0 && oldestBlockTime < migrationSec) break; // reached pre-migration history
          if (older.length < 1_000) break; // no more pages
        }
      }

      // Scan up to 25 transactions for baseline discoveries so no transactions are missed.
      const earlyBuysCapped = earlyBuys.slice(0, 25);

      if (earlyBuysCapped.length === 0) return;

      logger.info(
        { mint: mint.slice(0, 12), count: earlyBuysCapped.length, capped: isHistoricalDiscovery },
        'Sniper engine: baseline — scanning recent txns for early buyer buys',
      );

      // Ensure SOL price is fresh so we can compute buyer's avg entry price from tx data.
      await fetchSolPrice().catch(() => {});

      // Process from oldest → newest to trigger on the FIRST qualifying buy.
      // Batch in groups of 5 (parallel) to maximise speed. Stop as soon as we enter.
      const toFetchEarly = earlyBuysCapped.slice().reverse().map(s => s.signature);

      // Mark this mint as having an active baseline scan so validateOrPrune defers
      // the age-cap prune until after we finish — otherwise the token gets pruned
      // during Helius 429 backoffs and handleVolumeUpdate returns null for every buy.
      mintHasActiveBaseline.add(mint);
      try {
        const BATCH = 5;
        outer:
        for (let i = 0; i < toFetchEarly.length; i += BATCH) {
          // If the token was pruned by something other than age-cap (e.g. micro-liq
          // check), stop processing — there's nobody to receive the handleVolumeUpdate.
          if (!trackedTokens.has(mint)) break outer;

          const batch = toFetchEarly.slice(i, i + BATCH);
          const txns  = await Promise.all(
            batch.map(sig =>
              rpcCall(() => conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 })).catch(() => null),
            ),
          );
          for (let j = 0; j < txns.length; j++) {
            const tx = txns[j];
            if (!tx) continue;
            // Detect buy or sell — both contribute to the 10s volume window
            const buy  = detectBuy(tx, mint);
            const sell = buy ? null : detectSell(tx, mint);
            const txSolAmount = buy ? buy.solSpent : (sell ? sell.solReceived : 0);
            if (txSolAmount < 0.0001) continue;
            const txUsd = txSolAmount * cachedSolPrice;
            if (txUsd <= 0) continue;
            const txWallet = buy ? buy.wallet : (sell ? sell.wallet : 'unknown');
            // Price at detection: use buyer's avg entry price for buys; 0 for sells (slippage check skipped)
            const txPrice = (buy && buy.tokensReceived > 0 && cachedSolPrice > 0)
              ? (buy.solSpent * cachedSolPrice) / buy.tokensReceived : 0;
            // Store vault addresses from this tx for later on-chain price reads
            const tokEntry = trackedTokens.get(mint);
            if (tokEntry) {
              const bv = buy?.poolBaseVault  ?? sell?.poolBaseVault;
              const qv = buy?.poolQuoteVault ?? sell?.poolQuoteVault;
              if (bv && !tokEntry.poolBaseVault)  tokEntry.poolBaseVault  = bv;
              if (qv && !tokEntry.poolQuoteVault) tokEntry.poolQuoteVault = qv;
            }
            const txTs = tx.blockTime ? tx.blockTime * 1_000 : Date.now();
            logger.info(
              { mint: mint.slice(0, 12), wallet: txWallet.slice(0, 8), usd: txUsd.toFixed(2),
                type: buy ? 'buy' : 'sell', sig: batch[j].slice(0, 12) },
              'Sniper engine: baseline — tx volume found',
            );
            await handleVolumeUpdate(mint, txWallet, txUsd, batch[j], txPrice, txTs, buy ? 'buy' : 'sell');
            if (trackedTokens.get(mint)?.entryTriggered) break outer;
          }
          // No inter-batch pause — speed is critical in the 10s window
        }
      } finally {
        mintHasActiveBaseline.delete(mint);
      }
      return;
    }

    const newSigs = sigs
      .filter(s => !seen.has(s.signature) && !s.err)
      .map(s => s.signature);

    for (const s of newSigs) seen.add(s);
    if (newSigs.length === 0) return;

    // Ensure SOL price is fresh before computing buyer avg entry price from tx data.
    await fetchSolPrice().catch(() => {});

    // Fetch up to 10 new txns in parallel (doubled for faster 10s window coverage)
    const toFetch = newSigs.slice(0, 10);
    const txns    = await Promise.all(
      toFetch.map(sig =>
        rpcCall(() => conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 })).catch(() => null),
      ),
    );

    for (let i = 0; i < txns.length; i++) {
      const tx = txns[i];
      if (!tx) continue;
      // Detect buy or sell — both count toward the 10s rolling volume window
      const buy  = detectBuy(tx, mint);
      const sell = buy ? null : detectSell(tx, mint);
      const txSolAmount = buy ? buy.solSpent : (sell ? sell.solReceived : 0);
      if (txSolAmount < 0.0001) continue;
      const txUsd = txSolAmount * cachedSolPrice;
      if (txUsd <= 0) continue;
      const txWallet = buy ? buy.wallet : (sell ? sell.wallet : 'unknown');
      // Price at detection: use buyer's avg entry price for buys; 0 for sells (slippage check skipped)
      const txPrice = (buy && buy.tokensReceived > 0 && cachedSolPrice > 0)
        ? (buy.solSpent * cachedSolPrice) / buy.tokensReceived : 0;
      // Store vault addresses from this tx for later on-chain price reads
      const tokLive = trackedTokens.get(mint);
      if (tokLive) {
        const bv = buy?.poolBaseVault  ?? sell?.poolBaseVault;
        const qv = buy?.poolQuoteVault ?? sell?.poolQuoteVault;
        if (bv && !tokLive.poolBaseVault)  tokLive.poolBaseVault  = bv;
        if (qv && !tokLive.poolQuoteVault) tokLive.poolQuoteVault = qv;
      }
      logger.info(
        { mint: mint.slice(0, 12), wallet: txWallet.slice(0, 8), usd: txUsd.toFixed(0), type: buy ? 'buy' : 'sell', txPrice, sig: toFetch[i].slice(0, 12) },
        'Sniper engine: tx detected',
      );
      await handleVolumeUpdate(mint, txWallet, txUsd, toFetch[i], txPrice, Date.now(), buy ? 'buy' : 'sell');
    }
  } catch (err: any) {
    logger.debug({ mint: mint.slice(0, 12), err: err?.message }, 'Sniper engine: poll error');
  } finally {
    pollLocks.delete(mint);
  }
}

// ── Position exit monitoring ──────────────────────────────────────────────────

// ── Partial close at a TP level ───────────────────────────────────────────────

async function partialCloseSniperTP(
  pos: SniperPosition,
  tpNum: 1 | 2 | 3,
  exitPct: number,       // % of initialSizeSol to sell (e.g. 30)
  currentPrice: number,
  newSLPrice: number,
  newSLDesc: string,
): Promise<void> {
  const chunkSol    = pos.initialSizeSol * (exitPct / 100);
  const returnedSol = chunkSol * (currentPrice / pos.entryPrice);
  const profitOnChunk = returnedSol - chunkSol;

  pos.bankedSol        += returnedSol;
  pos.remainingSizeSol -= chunkSol;
  pos.sizeSol           = pos.remainingSizeSol;  // keep UI field in sync
  pos.currentSLPrice    = newSLPrice;

  // Credit returned SOL to balance immediately
  await adjustBalance(returnedSol).catch(() => {});

  void saveSniperPosition(pos);
  broadcastSniperStatus();

  const gainPct = (currentPrice / pos.entryPrice - 1) * 100;
  logger.info(
    { mint: pos.mint.slice(0, 12), symbol: pos.symbol, tpNum,
      gainPct: gainPct.toFixed(1), chunkSol: chunkSol.toFixed(4),
      returnedSol: returnedSol.toFixed(4), profitOnChunk: profitOnChunk.toFixed(4),
      remaining: pos.remainingSizeSol.toFixed(4), newSLPrice },
    `Sniper engine: TP${tpNum} partial close`,
  );

  notifySniperTP({
    name: pos.name, symbol: pos.symbol, mint: pos.mint,
    tpNum, gainPct,
    chunkSol, returnedSol,
    remainingSizeSol: pos.remainingSizeSol,
    initialSizeSol:   pos.initialSizeSol,
    newSLPrice, newSLDesc,
    entryPrice: pos.entryPrice, currentPrice,
    totalBanked: pos.bankedSol,
  }).catch(() => {});
}

// ── Full position close ───────────────────────────────────────────────────────

async function closeSniperPosition(pos: SniperPosition, reason: string): Promise<void> {
  // Synchronous reservation — prevents two overlapping monitor cycles from
  // both closing (and double-crediting balance for) the same position.
  if (closeLocks.has(pos.mint) || !openPositions.has(pos.mint)) return;
  closeLocks.add(pos.mint);
  openPositions.delete(pos.mint);

  try {
    const exitPrice = pos.lastPrice;

    // Runner return: value of the remaining open portion at exit price.
    // bankedSol was already credited to balance on each partial TP close.
    const runnerReturn = pos.remainingSizeSol * (exitPrice / pos.entryPrice);
    const totalReturn  = pos.bankedSol + runnerReturn;
    const initSize     = pos.initialSizeSol > 0.0001 ? pos.initialSizeSol : pos.sizeSol;
    const pnlSol       = totalReturn - initSize;
    const pnlPct       = (pnlSol / initSize) * 100;

    // Only add runner's return — banked portions already credited
    await adjustBalance(runnerReturn).catch(() => {});

    closedPositions.unshift({ ...pos, closeTime: Date.now(), closeReason: reason, closePnlPct: pnlPct });
    if (closedPositions.length > 200) closedPositions.pop();
    void closeSniperPositionInDB(pos.id, reason, pnlPct);

    logger.info({ mint: pos.mint, symbol: pos.symbol, pnlPct: pnlPct.toFixed(1), pnlSol: pnlSol.toFixed(4), reason }, 'Sniper engine: CLOSED');

    notifySniperClose({
      name: pos.name, symbol: pos.symbol, mint: pos.mint,
      pnlPct, pnlSol, reason,
      entryPrice: pos.entryPrice, exitPrice, sizeSol: initSize,
    }).catch(() => {});

    broadcastSniperStatus();
    await processQueue();
  } finally {
    closeLocks.delete(pos.mint);
  }
}

async function monitorPositions(): Promise<void> {
  const mints = Array.from(openPositions.keys());
  if (mints.length === 0) return;

  let settings: Awaited<ReturnType<typeof getSettings>>;
  try { settings = await getSettings(); } catch { return; }

  try {
    const r      = await axios.get<any>(`${DEX_BASE}/latest/dex/tokens/${mints.slice(0, 30).join(',')}`, { timeout: 8_000 });
    const pairs: any[] = r.data?.pairs ?? [];

    for (const pos of Array.from(openPositions.values())) {
      const mintPairs = (pairs as any[]).filter((p: any) => p.baseToken?.address === pos.mint);
      const pumpswapPos = mintPairs
        .filter((p: any) => (p.dexId ?? '').toLowerCase() === 'pumpswap')
        .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      const byLiqPos = [...mintPairs].sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      const best = pumpswapPos[0] ?? byLiqPos[0];

      if (!best) continue;
      const price        = parseFloat(best.priceUsd ?? '0');
      const liquidity    = best.liquidity?.usd ?? 0;
      const priceChange1h: number | null = best?.priceChange?.h1 ?? null;
      if (price <= 0) continue;

      // Update live price & peak
      pos.lastPrice     = price;
      pos.lastLiquidity = liquidity;
      if (price > pos.peakPrice) pos.peakPrice = price;

      // Live P&L: accounts for banked SOL from partial closes
      const initSize = pos.initialSizeSol > 0.0001 ? pos.initialSizeSol : pos.sizeSol;
      pos.pnlPct = initSize > 0
        ? ((pos.bankedSol + pos.remainingSizeSol * (price / pos.entryPrice) - initSize) / initSize) * 100
        : ((price - pos.entryPrice) / pos.entryPrice) * 100;

      void saveSniperPosition(pos);

      const cfg = getTierConfig(pos.tpTier, settings as unknown as Record<string, number>);
      let tpHitThisCycle = false;

      // ── Multi-stage TP checks (in order) ──────────────────────────────────

      // TP1
      if (!pos.tp1Hit && price >= pos.entryPrice * (1 + cfg.tp1Pct / 100)) {
        pos.tp1Hit = true;
        const newSL = pos.entryPrice;  // breakeven
        await partialCloseSniperTP(pos, 1, cfg.tp1Exit, price, newSL, 'breakeven');
        tpHitThisCycle = true;
      }

      // TP2 (requires TP1)
      if (pos.tp1Hit && !pos.tp2Hit && price >= pos.entryPrice * (1 + cfg.tp2Pct / 100)) {
        pos.tp2Hit = true;
        const newSL = Math.max(pos.currentSLPrice, pos.peakPrice * (1 - cfg.tp2Trail / 100));
        await partialCloseSniperTP(pos, 2, cfg.tp2Exit, price, newSL, `-${cfg.tp2Trail}% from peak`);
        tpHitThisCycle = true;
      }

      // TP3 (requires TP2)
      if (pos.tp2Hit && !pos.tp3Hit && price >= pos.entryPrice * (1 + cfg.tp3Pct / 100)) {
        pos.tp3Hit = true;
        const newSL = Math.max(pos.currentSLPrice, pos.peakPrice * (1 - cfg.tp3Trail / 100));
        await partialCloseSniperTP(pos, 3, cfg.tp3Exit, price, newSL, `-${cfg.tp3Trail}% from peak (runner)`);
        tpHitThisCycle = true;
      }

      // ── Ratchet trailing SL upward as peak rises ──────────────────────────
      if (pos.tp3Hit) {
        const trail = pos.peakPrice * (1 - cfg.tp3Trail / 100);
        if (trail > pos.currentSLPrice) pos.currentSLPrice = trail;
      } else if (pos.tp2Hit) {
        const trail = pos.peakPrice * (1 - cfg.tp2Trail / 100);
        if (trail > pos.currentSLPrice) pos.currentSLPrice = trail;
      }

      // Grace period: suppress SL/liq/time exits for 90s post-entry.
      // Entry price (single-mint DexScreener) vs monitor price (multi-mint) can
      // diverge enough to trigger SL before the trade has developed.
      const posAgeMs = Date.now() - pos.entryTime;
      if (posAgeMs < 90_000) continue;

      // ── Exit conditions (skip if a TP just fired this cycle) ─────────────

      // SL hit
      if (!tpHitThisCycle && price <= pos.currentSLPrice) {
        let slReason: string;
        if (pos.tp3Hit)      slReason = `Runner SL (-${cfg.tp3Trail}% from peak)`;
        else if (pos.tp2Hit) slReason = `Trailing SL (-${cfg.tp2Trail}% from peak)`;
        else if (pos.tp1Hit) slReason = 'Breakeven SL';
        else                 slReason = `-${(PRICE_SL_PCT * 100).toFixed(0)}% hard stop loss`;
        await closeSniperPosition(pos, slReason);
        continue;
      }

      // Emergency: liquidity dropped >40%
      if (!tpHitThisCycle && pos.baselineLiquidity > 1 && liquidity > 0) {
        const drop = (pos.baselineLiquidity - liquidity) / pos.baselineLiquidity;
        if (drop > 0.4) {
          await closeSniperPosition(pos, `Liquidity -${(drop * 100).toFixed(0)}% emergency exit`);
          continue;
        }
      }

      // Emergency: liquidity went to zero
      if (!tpHitThisCycle && liquidity === 0 && pos.baselineLiquidity > 1) {
        await closeSniperPosition(pos, 'Liquidity $0 — emergency exit');
        continue;
      }

      // Stagnation exit: if price changed < sniperStagnationPct% in last 1h
      // and position has been open for at least 1h — no time limit otherwise.
      const stagnationPct = (settings as unknown as Record<string, number>)['sniperStagnationPct'] ?? 5;
      if (
        !tpHitThisCycle &&
        posAgeMs >= 3_600_000 &&
        priceChange1h !== null &&
        Math.abs(priceChange1h) < stagnationPct
      ) {
        await closeSniperPosition(pos, `Stagnation: ${Math.abs(priceChange1h).toFixed(1)}% move in 1h (< ${stagnationPct}% threshold)`);
        continue;
      }
    }
  } catch (err: any) {
    logger.debug({ err: err?.message }, 'Sniper engine: position monitor error');
  }
}

// ── Prune expired tracking ────────────────────────────────────────────────────

function pruneExpiredTracking(): void {
  const now = Date.now();
  let pruned = 0;

  // Prune pending graduations that timed out
  for (const [mint, pg] of pendingGraduations) {
    if (now > pg.detectedAt + POOL_WAIT_TIMEOUT_MS) {
      pendingGraduations.delete(mint);
      logger.warn({ mint: mint.slice(0, 12) }, 'Sniper engine: pending graduation timed out — pool never went live');
    }
  }

  for (const [mint, tok] of trackedTokens) {
    if (now <= tok.expiresAt) continue;
    trackedTokens.delete(mint);
    seenTxns.delete(mint);
    mintCheckpointed.delete(mint);
    clearMintConsensus(mint);
    wsUnsubscribeMint(mint);
    // Do NOT close the position when tracking window expires — positions are
    // held indefinitely and exited only by TP/SL/liquidity/stagnation rules.
    // monitorPositions() continues to track the mint independently via openPositions.
    void diagTokenExpired(mint).catch(() => {});
    pruned++;
  }
  const keep = signalQueue.filter(s => trackedTokens.has(s.mint));
  signalQueue.splice(0, signalQueue.length, ...keep);

  // Broadcast so the UI immediately reflects the removal — without this the
  // expired cards stay on screen until the next unrelated broadcastSniperStatus call.
  if (pruned > 0) {
    logger.info({ pruned }, 'Sniper engine: pruned expired tracked tokens');
    broadcastSniperStatus();
  }
}

// ── Immediate tracking activation on graduation ───────────────────────────────
//
// Old flow: wait 30-120s for DexScreener to index the pool, then add a 10s
// stability delay → first poll fires ~2 minutes after graduation → detection window closed.
//
// New flow: activate tracking IMMEDIATELY using the mint + poolAddress from the
// graduation TX (already available). Kick off background DexScreener enrichment
// to fill in name/symbol/liquidity once DexScreener catches up. Polling starts
// within 2s of graduation, catching buyers in the first block.

// Minimum post-grad pool liquidity required to keep a token tracked.
// Tokens that never reach this (micro/seeded grads, false detections) are pruned after
// VALIDATION_DELAY_MS. Real pump.fun grads seed ~$1-3k liquidity — $500 is conservative.
const MIN_POOL_LIQUIDITY_USD           = 500;
const VALIDATION_DELAY_MS             = 20_000;      // wait 20s before first quality check
const VALIDATION_TIMEOUT_MS           = 10 * 60_000; // hard cap: 10 min (extended from 5 min — covers slow DexScreener indexing)
const VALIDATION_POLL_MS              = 5_000;       // retry DexScreener every 5s during validation
// Stop retrying if the pool was already created > 15 min ago (too late for a meaningful entry).
// Uses pairCreatedAt from DexScreener; falls back to activatedAt as a conservative proxy.
const MAX_TOKEN_AGE_FOR_VALIDATION_MS = 15 * 60_000;
// After a transient validation failure (indexing lag / liq=0 / timeout), shorten the
// 1-hour GMGN re-discovery suppression to this delay so the token gets
// a second validation attempt once DexScreener finishes indexing.
const TRANSIENT_RETRY_DELAY_MS        = 3 * 60_000;

async function activateTrackingNow(mint: string): Promise<void> {
  const pending: PendingGraduation | undefined = pendingGraduations.get(mint);
  if (!pending) return;
  if (trackedTokens.has(mint)) { pendingGraduations.delete(mint); return; }
  // Lifetime guard: never re-track (let alone re-enter) a mint that has ever
  // been traded before, even if it "graduates" again due to a duplicate or
  // re-detected on-chain event.
  if (everTradedMints.has(mint) || slippageSkippedMints.has(mint)) {
    pendingGraduations.delete(mint);
    logger.info({ mint: mint.slice(0, 12) }, 'Sniper engine: ignoring re-graduation of already-traded/slippage-skipped mint');
    return;
  }

  // Activate immediately with placeholder metadata — DexScreener enriches these async
  pendingGraduations.delete(mint);
  trackedTokens.set(mint, {
    mint,
    name:          mint.slice(0, 6) + '…',
    symbol:        mint.slice(0, 4).toUpperCase(),
    poolAddress:   pending.poolAddress,
    migrationTime: pending.migrationTime,
    expiresAt:     pending.detectedAt + MAX_TRACKING_MS,
    entryTriggered: false,
    buyerActivity:     [],
  });
  seenTxns.set(mint, new Set());

  // Subscribe to Helius WS for instant buy detection on this mint
  wsSubscribeMint(mint);

  logger.info(
    { mint: mint.slice(0, 12), pool: pending.poolAddress?.slice(0, 16) },
    'Sniper engine: tracking activated immediately on graduation (polling within 2s)',
  );
  broadcastSniperStatus();

  // Background tasks — run in parallel, do NOT await
  void enrichTokenMetadataAsync(mint, pending.detectedAt);
  void validateOrPrune(mint, pending.detectedAt);
}

// Quality gate: after VALIDATION_DELAY_MS, check DexScreener for a real post-grad pool.
// If the pool has < MIN_POOL_LIQUIDITY_USD (e.g. micro/seeded grads, false detections),
// prune the token so it never shows on the UI or accepts entries.
// Real graduates (~$1-3k seed liquidity) clear the bar well within the timeout.
// Buys can still be detected and entered during the 20s window — in practice
// nobody can buy $500+ into a $2-liquidity pool, so no false entries occur.
//
// IMPORTANT: When DexScreener returns a pair with liq=0 or liq<MIN, we do NOT
// prune immediately. DexScreener commonly shows liq=0 for 30–90s after a new
// PumpSwap pool is created, because the liquidity data hasn't propagated through
// their indexer yet. We keep retrying until the deadline and only prune then
// if liquidity has never reached MIN_POOL_LIQUIDITY_USD. This prevents good
// tokens from being rejected due to DexScreener indexing lag.
//
// Only exception: if the same pool consistently shows a non-zero but very low
// liquidity (< PRUNE_MICRO_LIQ_USD) across multiple checks, it is a genuine
// micro/seeded grad and we prune early to free the slot.
const PRUNE_MICRO_LIQ_USD      = 50;    // if liq is this low after 2 checks, it's genuinely micro
const MICRO_LIQ_CONFIRM_CHECKS = 2;     // require this many consecutive low-liq reads before early prune

async function validateOrPrune(mint: string, activatedAt: number): Promise<void> {
  // Wait before first check — real pools take ~5-15s to appear on DexScreener
  await new Promise(r => setTimeout(r, VALIDATION_DELAY_MS));

  // Two-condition deadline:
  //   1. Hard 10-min cap from activation (VALIDATION_TIMEOUT_MS)
  //   2. Token age cap: stop retrying once pairCreatedAt > MAX_TOKEN_AGE_FOR_VALIDATION_MS
  //      (checked per-loop as soon as DexScreener returns pairCreatedAt)
  const deadline = activatedAt + VALIDATION_TIMEOUT_MS;
  let consecutiveLowLiq    = 0;
  let lastSeenLiq          = -1;
  // Lifecycle milestone flags — each fires its DB write exactly once
  let firstPairSeenAt: number | null     = null;
  let firstNonzeroLiqAt: number | null   = null;

  while (Date.now() < deadline) {
    const tok = trackedTokens.get(mint);
    if (!tok) return; // already pruned externally

    // Never prune a token where we've already entered a position
    if (tok.entryTriggered || openPositions.has(mint)) return;

    try {
      const r = await axios.get<any>(`${DEX_BASE}/latest/dex/tokens/${mint}`, { timeout: 8_000 });
      const allPairs: any[] = r.data?.pairs ?? [];
      // Prefer pumpswap; fall back to any DEX so non-pumpswap graduates aren't pruned incorrectly
      const pumpswapValidate = allPairs
        .filter((p: any) => (p.dexId ?? '').toLowerCase() === 'pumpswap')
        .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      // Exclude raw pumpfun bonding-curve pairs from post-grad validation.
      // Bonding-curve pairs always report liq=0 because there is no DEX pool yet;
      // including them causes the "pool indexed but liq below min" loop to run
      // for the full 10-min deadline (consecutiveLowLiq resets to 0 on every
      // liq=0 read, so it never prunes early). Only pumpswap / raydium / orca
      // etc. signal a real graduation.
      const byLiqValidate = [...allPairs]
        .filter((p: any) => (p.dexId ?? '').toLowerCase() !== 'pumpfun')
        .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      const postGradPairs = pumpswapValidate.length > 0 ? pumpswapValidate : byLiqValidate;

      if (postGradPairs.length > 0) {
        const now = Date.now();

        // ── Milestone: first DexScreener pair seen ──────────────────────────
        if (firstPairSeenAt === null) {
          firstPairSeenAt = now;
          void diagTokenValidationMilestone(mint, 'first_dexscreener_pair_at', now).catch(() => {});
          logger.debug(
            { mint: mint.slice(0, 12), delaySec: Math.round((now - activatedAt) / 1_000) },
            'Sniper engine: DexScreener pair first seen during validation',
          );
        }

        let liq = postGradPairs[0]?.liquidity?.usd ?? 0;
        lastSeenLiq = liq;

        // ── On-chain liquidity fallback ───────────────────────────────────────
        // DexScreener commonly shows liq=0 for 30–90s after a new PumpSwap pool
        // is created (indexing lag). If we have the pool address from graduation,
        // read on-chain vault balances directly — this is always up-to-date and
        // is the same technique used at entry time to override stale DexScreener data.
        if (liq === 0 && tok.poolAddress) {
          const onChainLiq = await fetchOnChainLiqUsd(tok.poolAddress, cachedSolPrice).catch(() => 0);
          if (onChainLiq > 0) {
            logger.info(
              { mint: mint.slice(0, 12), dexLiq: 0, onChainLiq: onChainLiq.toFixed(0) },
              'Sniper engine: DexScreener liq=0 (indexing lag) — on-chain vault override during validation',
            );
            liq = onChainLiq;
            lastSeenLiq = liq;
          }
        }

        // ── Milestone: first non-zero liquidity ──────────────────────────────
        if (liq > 0 && firstNonzeroLiqAt === null) {
          firstNonzeroLiqAt = now;
          void diagTokenValidationMilestone(mint, 'first_nonzero_liq_at', now).catch(() => {});
        }

        // ── Age cap via pairCreatedAt ─────────────────────────────────────────
        // Once DexScreener returns pairCreatedAt we know the true pool age.
        // Stop retrying if the pool is already too old for a timely entry.
        const pairCreatedAt: number | undefined = postGradPairs[0]?.pairCreatedAt;
        const tokenAgeMs = pairCreatedAt ? now - pairCreatedAt : now - activatedAt;
        if (tokenAgeMs > MAX_TOKEN_AGE_FOR_VALIDATION_MS) {
          // Defer the prune if an initial baseline scan is still in progress —
          // the baseline needs tok to remain in trackedTokens so handleVolumeUpdate
          // can push entries to the buyLog. Once the baseline finishes (removes
          // mint from mintHasActiveBaseline), the next loop iteration will prune.
          // Hard cap at BASELINE_PRUNE_HARD_CAP_MS to avoid holding forever if the
          // baseline stalls (e.g. complete Helius outage).
          if (mintHasActiveBaseline.has(mint) && tokenAgeMs <= BASELINE_PRUNE_HARD_CAP_MS) {
            logger.debug(
              { mint: mint.slice(0, 12), ageMin: (tokenAgeMs / 60_000).toFixed(1) },
              'Sniper engine: age cap reached but baseline active — deferring prune',
            );
            // fall through to next VALIDATION_POLL_MS iteration
          } else {
            logger.info(
              { mint: mint.slice(0, 12), ageMin: (tokenAgeMs / 60_000).toFixed(1), liq: liq.toFixed(0) },
              'Sniper engine: token exceeded age cap — pruning (too old for worthwhile entry)',
            );
            void diagTokenRejected(mint, 'Token age ' + (tokenAgeMs / 60_000).toFixed(1) + ' min exceeded ' + (MAX_TOKEN_AGE_FOR_VALIDATION_MS / 60_000) + ' min cap').catch(() => {});
            void diagTokenValidationMilestone(mint, 'validation_outcome', 'failed_age_cap').catch(() => {});
            if (!trackedTokens.get(mint)?.entryTriggered && !openPositions.has(mint)) pruneToken(mint);
            // No release — the token is already too old; re-discovery would hit the same cap
            return;
          }
        }

        if (liq >= MIN_POOL_LIQUIDITY_USD) {
          // Pool qualifies — token is a real graduate
          void diagTokenValidationMilestone(mint, 'liq_min_crossed_at', now).catch(() => {});
          void diagTokenValidationMilestone(mint, 'validation_outcome', 'passed').catch(() => {});
          logger.info(
            { mint: mint.slice(0, 12), liq: liq.toFixed(0), delaySec: Math.round((now - activatedAt) / 1_000) },
            'Sniper engine: pool quality validated — keeping token',
          );
          return; // enrichMetadataAsync will continue updating market data
        }

        // Pool is indexed but liquidity is below the minimum.
        // Only prune early if the pool consistently shows a non-zero but very low value,
        // which indicates a genuine micro/seeded pool rather than an indexing delay.
        if (liq > 0 && liq < PRUNE_MICRO_LIQ_USD) {
          consecutiveLowLiq++;
          if (consecutiveLowLiq >= MICRO_LIQ_CONFIRM_CHECKS) {
            if (trackedTokens.get(mint)?.entryTriggered || openPositions.has(mint)) return;
            logger.warn(
              { mint: mint.slice(0, 12), liq: liq.toFixed(0), checks: consecutiveLowLiq, minLiq: MIN_POOL_LIQUIDITY_USD },
              'Sniper engine: pool confirmed micro/seeded grad (non-zero low liq across multiple checks) — pruning',
            );
            void diagTokenRejected(mint, 'Pool liquidity ' + liq.toFixed(0) + ' consistently < ' + PRUNE_MICRO_LIQ_USD + ' (micro/seeded grad after ' + consecutiveLowLiq + ' checks)').catch(() => {});
            void diagTokenValidationMilestone(mint, 'validation_outcome', 'failed_micro').catch(() => {});
            pruneToken(mint);
            // Do NOT release — this is a genuine micro pool, not an indexing delay
            return;
          }
        } else {
          // liq=0 (still indexing even after on-chain check) or moderate liq — reset counter
          consecutiveLowLiq = 0;
        }

        logger.info(
          { mint: mint.slice(0, 12), liq: liq.toFixed(0), minLiq: MIN_POOL_LIQUIDITY_USD, consecutiveLowLiq },
          'Sniper engine: pool indexed but liq below min — retrying',
        );
      } else {
        // DexScreener hasn't indexed the token at all yet.
        // Try on-chain directly if we have the pool address from graduation —
        // the pool exists on-chain immediately; DexScreener just hasn't caught up.
        const poolAddr = trackedTokens.get(mint)?.poolAddress;
        if (poolAddr) {
          const onChainLiq = await fetchOnChainLiqUsd(poolAddr, cachedSolPrice).catch(() => 0);
          if (onChainLiq >= MIN_POOL_LIQUIDITY_USD) {
            const now = Date.now();
            void diagTokenValidationMilestone(mint, 'liq_min_crossed_at', now).catch(() => {});
            void diagTokenValidationMilestone(mint, 'validation_outcome', 'passed').catch(() => {});
            logger.info(
              { mint: mint.slice(0, 12), onChainLiq: onChainLiq.toFixed(0), delaySec: Math.round((now - activatedAt) / 1_000) },
              'Sniper engine: no DexScreener pairs yet — validated via on-chain vault liquidity',
            );
            return;
          }
          if (onChainLiq > 0) lastSeenLiq = onChainLiq;
        }
      }
      // No qualified pool yet — keep retrying until deadline
    } catch { /* non-fatal — retry */ }

    await new Promise(r => setTimeout(r, VALIDATION_POLL_MS));
  }

  // Deadline reached: no qualified pool found → re-check entry state before pruning
  if (!trackedTokens.get(mint)?.entryTriggered && !openPositions.has(mint)) {
    const liqStr     = lastSeenLiq >= 0 ? String(Math.round(lastSeenLiq)) : 'none';
    const hadPairs   = firstPairSeenAt !== null;
    const outcomeKey = hadPairs ? 'failed_timeout' : 'failed_no_pairs';

    logger.warn(
      { mint: mint.slice(0, 12), lastSeenLiq: liqStr, hadPairs },
      'Sniper engine: no qualified post-grad pool within validation window — pruning token',
    );
    void diagTokenRejected(mint, 'No qualified pool within ' + (VALIDATION_TIMEOUT_MS / 60_000) + 'min timeout (last seen liq: ' + liqStr + ')').catch(() => {});
    void diagTokenValidationMilestone(mint, 'validation_outcome', outcomeKey).catch(() => {});

    pruneToken(mint);

    // ── Release for re-discovery ──────────────────────────────────────────────
    // The timeout is almost always caused by DexScreener indexing lag, not by
    // the pool having zero liquidity. Shortening the 1-hour suppression window
    // lets GMGN re-fire the token after TRANSIENT_RETRY_DELAY_MS so
    // a fresh validateOrPrune attempt can see the (now-indexed) pool.
    // If DexScreener still shows nothing on the retry, the token will age out
    // naturally via the MAX_TOKEN_AGE_FOR_VALIDATION_MS cap.
    releaseForRediscovery(mint, TRANSIENT_RETRY_DELAY_MS);
    void diagTokenReleased(mint).catch(() => {});
    logger.info(
      { mint: mint.slice(0, 12), retryInSec: Math.round(TRANSIENT_RETRY_DELAY_MS / 1_000) },
      'Sniper engine: token released for re-discovery (DexScreener indexing lag)',
    );
  }
}

// pruneToken: remove a tracked token completely. Guards against pruning after entry
// so the invariant "never remove tracking state for an active position" is enforced
// centrally and not just at each call site.
function pruneToken(mint: string): void {
  // Final safety: never prune if a position is already open, entry has started, or consensus is pending
  if (openPositions.has(mint) || trackedTokens.get(mint)?.entryTriggered || pendingConsensusSignals.has(mint)) return;
  trackedTokens.delete(mint);
  seenTxns.delete(mint);
  mintCheckpointed.delete(mint);
  clearMintConsensus(mint);
  wsUnsubscribeMint(mint);
  broadcastSniperStatus();
}

// Polls DexScreener until it has indexed the post-graduation pool, then updates
// the already-active tracked token's metadata (name, symbol, liquidity, price).
// Does NOT gate trading — polling is already running in parallel.
async function enrichTokenMetadataAsync(mint: string, activatedAt: number): Promise<void> {
  const deadline = activatedAt + POOL_WAIT_TIMEOUT_MS;
  // Once the initial name+liq is set we slow down to 15 s refreshes rather than
  // stopping altogether.  Liquidity can grow 2–3× in the first few minutes after
  // graduation as LPs add, so keeping tok.liquidity current is critical for the
  // entry quality-gate check (which reads this field directly).
  let initialEnrichDone = false;

  while (Date.now() < deadline) {
    // Fast poll (3 s) until we have name+liq; slow poll (15 s) afterwards.
    const pollMs = initialEnrichDone ? 15_000 : POOL_WAIT_POLL_MS;
    await new Promise(r => setTimeout(r, pollMs));

    const tok = trackedTokens.get(mint);
    if (!tok) return; // token was pruned
    // Stop once an entry is live — the position monitor owns market-data refresh.
    if (tok.entryTriggered || openPositions.has(mint)) return;

    try {
      const r = await axios.get<any>(`${DEX_BASE}/latest/dex/tokens/${mint}`, { timeout: 8_000 });
      const allPairs: any[] = r.data?.pairs ?? [];
      if (allPairs.length === 0) continue; // not indexed yet — keep retrying

      // Prefer pumpswap, fall back to highest-liquidity pair on any DEX
      const pumpswapPairs = allPairs
        .filter((p: any) => (p.dexId ?? '').toLowerCase() === 'pumpswap')
        .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      const byLiqPairs = [...allPairs].sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      const best = pumpswapPairs[0] ?? byLiqPairs[0];
      const name      = best?.baseToken?.name   ?? '';
      const symbol    = best?.baseToken?.symbol ?? '';
      const liquidity = best?.liquidity?.usd    ?? 0;
      if (!name) continue; // metadata not populated yet

      // Re-read tok in case it was replaced while we were awaiting
      const tokNow = trackedTokens.get(mint);
      if (!tokNow) return;

      tokNow.name            = name;
      tokNow.symbol          = symbol;
      tokNow.poolAddress     = tokNow.poolAddress ?? best?.pairAddress;
      tokNow.dexId           = best?.dexId ?? '';
      tokNow.price           = parseFloat(best?.priceUsd ?? '0');
      tokNow.mcap            = best?.marketCap ?? best?.fdv ?? 0;
      if (liquidity > 0) tokNow.liquidity = liquidity; // never overwrite a real value with 0
      tokNow.priceChange5m   = best?.priceChange?.m5  ?? 0;
      tokNow.priceChange1h   = best?.priceChange?.h1  ?? 0;
      tokNow.priceChange24h  = best?.priceChange?.h24 ?? 0;
      tokNow.volume5m        = best?.volume?.m5        ?? 0;
      tokNow.volume1h        = best?.volume?.h1        ?? 0;
      tokNow.volume24h       = best?.volume?.h24       ?? 0;
      tokNow.txnsH1Buys      = best?.txns?.h1?.buys   ?? 0;
      tokNow.txnsH1Sells     = best?.txns?.h1?.sells  ?? 0;
      tokNow.txnsH24Buys     = best?.txns?.h24?.buys  ?? 0;
      tokNow.txnsH24Sells    = best?.txns?.h24?.sells ?? 0;
      tokNow.lastMarketUpdate = Date.now();
      if (best?.pairCreatedAt) tokNow.pairCreatedAt = best.pairCreatedAt;

      if (!initialEnrichDone) {
        logger.info(
          { mint: mint.slice(0, 12), symbol, dex: best?.dexId, liq: liquidity.toFixed(0),
            enrichSec: Math.round((Date.now() - activatedAt) / 1_000) },
          'Sniper engine: token metadata enriched from DexScreener',
        );
        broadcastSniperStatus();
        initialEnrichDone = true;
      } else if (liquidity > 0) {
        // Quiet liq refresh — log only when liq changed meaningfully (>5%)
        const prev = tokNow.liquidity ?? 0;
        if (prev > 0 && Math.abs(liquidity - prev) / prev > 0.05) {
          logger.info(
            { mint: mint.slice(0, 12), liqPrev: prev.toFixed(0), liqNow: liquidity.toFixed(0) },
            'Sniper engine: liquidity refreshed',
          );
        }
        broadcastSniperStatus();
      }
    } catch { /* non-fatal — keep retrying */ }
  }

  logger.warn({ mint: mint.slice(0, 12) }, 'Sniper engine: metadata enrichment timed out — token tracked with placeholder name (trading still active)');
}

// ── Public API ────────────────────────────────────────────────────────────────

export function addGraduatedToken(ev: { mint: string; poolAddress?: string; ts: number; openTimestamp?: number; reserveUsd?: number }): void {
  // Filter genuinely pre-startup graduation events (e.g. historical backfill that
  // somehow leaked through). We do NOT use a fixed time window (the old 5-min limit)
  // because rate-limited polling retries can legitimately take many minutes to process
  // a real graduation — a fixed window would silently drop those real events.
  const cutoff = SERVER_START_MS - STALE_GRAD_GRACE_MS;
  if (ev.ts < cutoff) {
    logger.debug(
      { mint: ev.mint.slice(0, 12), ageMin: ((Date.now() - ev.ts) / 60_000).toFixed(1) },
      'Sniper engine: skipping pre-startup graduation — predates this server session',
    );
    return;
  }

  // Pre-filter tokens whose on-chain openTimestamp is already older than the
  // validation age cap. These would be activated into trackedTokens and then
  // immediately pruned by validateOrPrune — wasting a poll-loop slot for up to
  // 15 min and flooding the sequential sweep with dead-weight tokens.
  // Doing the check here keeps trackedTokens lean and scoring uninterrupted.
  if (ev.openTimestamp) {
    const tokenAgeMs = Date.now() - ev.openTimestamp * 1_000;
    if (tokenAgeMs > MAX_TOKEN_AGE_FOR_VALIDATION_MS) {
      logger.debug(
        { mint: ev.mint.slice(0, 12), ageMin: (tokenAgeMs / 60_000).toFixed(1) },
        'Sniper engine: pre-filtering GMGN token — already exceeds age cap before activation',
      );
      return;
    }
  }

  if (trackedTokens.has(ev.mint) || pendingGraduations.has(ev.mint)) return;
  if (everTradedMints.has(ev.mint) || slippageSkippedMints.has(ev.mint)) {
    logger.debug({ mint: ev.mint.slice(0, 12) }, 'Sniper engine: ignoring graduation of already-traded/slippage-skipped mint');
    return;
  }

  // Use Date.now() as detectedAt so the pool-wait deadline and tracking window
  // start from when WE detected the token, not when the block was mined.
  // migrationTime uses the token's actual on-chain openTimestamp (seconds → ms)
  // so the baseline scan's earlyBuys filter correctly captures historical buyers
  // since creation rather than filtering to "blockTime >= now" (always empty).
  const detectedAt = Date.now();
  const migrationTime = ev.openTimestamp ? ev.openTimestamp * 1_000 : detectedAt;

  pendingGraduations.set(ev.mint, {
    mint:       ev.mint,
    poolAddress: ev.poolAddress,
    detectedAt,
    migrationTime,
  });
  void diagTokenDiscovered(ev.mint, 'gmgn', { initialLiquidity: ev.reserveUsd }).catch(() => {});

  logger.info(
    { mint: ev.mint.slice(0, 16), pool: ev.poolAddress?.slice(0, 16) },
    'Sniper engine: graduation detected — activating tracking immediately',
  );
  broadcastSniperStatus();

  // Activate tracking immediately; metadata enriched from DexScreener in background
  void activateTrackingNow(ev.mint);
}

export function getSniperStatus() {
  return {
    serverStartMs:    SERVER_START_MS,   // unix ms when this server process started — used by UI to filter diagnostics to current session
    trackedTokens:    Array.from(trackedTokens.values()),
    openPositions:    Array.from(openPositions.values()),
    closedPositions:  closedPositions.slice(0, 200),   // full history for accurate stats
    recentBuyLog:     buyLog.slice(0, 30),
    queuedSignals:    [...signalQueue],
    solPriceUsd:      cachedSolPrice,
    pendingCount:     pendingGraduations.size,
    gmgnConfigured:   isGmgnConfigured(),
    gmgnBannedUntil:  getGmgnBannedUntil(), // unix ms; 0 if not currently rate-limit banned
    stats: {
      tracking:  trackedTokens.size,
      positions: openPositions.size,
      queued:    signalQueue.length,
      pending:   pendingGraduations.size,
    },
  };
}

function broadcastSniperStatus(): void {
  try {
    broadcast({ type: 'sniper_status' as any, data: getSniperStatus() });
  } catch { /* non-fatal */ }
}

// ── Periodic market data refresh for active tracked tokens ────────────────────
//
// Uses DexScreener's batch endpoint (up to 30 mints per request) so that
// 128 tracked tokens are refreshed in ~5 requests instead of 128 serial calls.
// Old approach: 128 tokens × 500ms stagger = 64s per cycle (completely broken).
// New approach: ceil(128/30) = 5 batches × 300ms inter-batch pause = ~5s per cycle.

const MARKET_REFRESH_MS       = 3_000;  // interval between refresh cycles (3s for near-live data)
const MARKET_BATCH_SIZE       = 30;     // DexScreener batch limit
const MARKET_BATCH_PAUSE_MS   = 300;    // pause between batches to avoid rate-limits

function applyDexData(tok: TrackedToken, d: DexMarketData): void {
  tok.lastMarketUpdate = Date.now();
  // Always capture pool identity + timestamps regardless of price
  if (!tok.poolAddress && d.pairAddress)         tok.poolAddress  = d.pairAddress;
  if (!tok.pairCreatedAt && d.pairCreatedAt > 0) tok.pairCreatedAt = d.pairCreatedAt;
  if (tok.name.endsWith('…') && d.name)          { tok.name = d.name; tok.symbol = d.symbol; }
  // Update liquidity/mcap even when price=0 (DexScreener can return price=0 briefly
  // while still having accurate liquidity; keeping stale low-liq causes false rejections).
  if (d.liquidity > 0)  tok.liquidity = d.liquidity;
  if (d.mcap > 0)       tok.mcap      = d.mcap;
  // Price-dependent fields only update when we have a valid price
  if (d.price > 0) {
    tok.dexId           = d.dexId;
    tok.price           = d.price;
    tok.priceChange5m   = d.priceChange5m;
    tok.priceChange1h   = d.priceChange1h;
    tok.priceChange24h  = d.priceChange24h;
    tok.volume5m        = d.volume5m;
    tok.volume1h        = d.volume1h;
    tok.volume24h       = d.volume24h;
    tok.txnsH1Buys      = d.txnsH1Buys;
    tok.txnsH1Sells     = d.txnsH1Sells;
    tok.txnsH24Buys     = d.txnsH24Buys;
    tok.txnsH24Sells    = d.txnsH24Sells;
  }
}

async function refreshTrackedTokensMarketData(): Promise<void> {
  const allMints = Array.from(trackedTokens.keys());
  if (!allMints.length) return;

  // Chunk into batches of MARKET_BATCH_SIZE
  const batches: string[][] = [];
  for (let i = 0; i < allMints.length; i += MARKET_BATCH_SIZE) {
    batches.push(allMints.slice(i, i + MARKET_BATCH_SIZE));
  }

  let updated = false;
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    try {
      const dataMap = await fetchTokenPriceBatch(batch);
      const now = Date.now();
      for (const mint of batch) {
        const tok = trackedTokens.get(mint);
        if (!tok) continue;
        const d = dataMap.get(mint);
        if (d) {
          applyDexData(tok, d);
        } else {
          // No data returned for this mint — still advance timestamp so UI doesn't freeze
          tok.lastMarketUpdate = now;
        }
        updated = true;
      }
      // Broadcast after each batch so the UI gets partial updates immediately
      // rather than waiting for all batches to complete
      if (updated) broadcastSniperStatus();
    } catch { /* non-fatal — keep stale data for this batch */ }

    // Pause between batches (skip after the last one)
    if (bi < batches.length - 1) {
      await new Promise(r => setTimeout(r, MARKET_BATCH_PAUSE_MS));
    }
  }

  try {
    await processPendingConsensusSignals();
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'Sniper engine: error processing pending consensus signals');
  }
}

async function verifyWalletsStillHolding(mint: string, wallets: string[], consensusTimestamp: number): Promise<boolean> {
  const tok = trackedTokens.get(mint);
  if (tok) {
    for (const act of tok.buyerActivity) {
      if (act.txType === 'sell' && act.timestamp >= consensusTimestamp && wallets.includes(act.wallet)) {
        logger.info(
          { mint: mint.slice(0, 12), wallet: act.wallet.slice(0, 12) },
          'WALLET VALIDATION: failed — wallet sold token in recorded activity',
        );
        return false;
      }
    }
  }

  const conn = getConn();
  for (const wallet of wallets) {
    try {
      const parsed = await withHeliusLimit(() =>
        conn.getParsedTokenAccountsByOwner(new PublicKey(wallet), { mint: new PublicKey(mint) }),
      );
      if (!parsed || !parsed.value || parsed.value.length === 0) {
        logger.info(
          { mint: mint.slice(0, 12), wallet: wallet.slice(0, 12) },
          'WALLET VALIDATION: failed — no token account found for wallet',
        );
        return false;
      }
      const hasBalance = parsed.value.some(acc => {
        const info = acc.account?.data?.parsed?.info;
        const uiAmt = info?.tokenAmount?.uiAmount;
        const rawAmt = info?.tokenAmount?.amount;
        return (uiAmt != null && uiAmt > 0) || (rawAmt != null && BigInt(rawAmt) > 0n);
      });
      if (!hasBalance) {
        logger.info(
          { mint: mint.slice(0, 12), wallet: wallet.slice(0, 12) },
          'WALLET VALIDATION: failed — wallet token balance is 0',
        );
        return false;
      }
    } catch (err: any) {
      logger.warn(
        { mint: mint.slice(0, 12), wallet: wallet.slice(0, 12), err: err?.message },
        'WALLET VALIDATION: RPC lookup error for wallet balance check — failing safe',
      );
      return false;
    }
  }
  return true;
}

async function processPendingConsensusSignals(): Promise<void> {
  if (pendingConsensusSignals.size === 0) return;
  const now = Date.now();

  for (const [mint, pending] of Array.from(pendingConsensusSignals.entries())) {
    const elapsedMs = now - pending.consensusTimestamp;
    if (elapsedMs > PENDING_CONSENSUS_TTL_MS) {
      logger.info(
        { mint: mint.slice(0, 12), symbol: pending.symbol, elapsedMin: (elapsedMs / 60_000).toFixed(1) },
        'CONSENSUS EXPIRED: pending consensus signal expired after 20m',
      );
      pendingConsensusSignals.delete(mint);
      continue;
    }

    const tok = trackedTokens.get(mint);
    let currentLiq = tok?.liquidity ?? 0;

    if (currentLiq < 25_000 && tok?.poolAddress) {
      try {
        await fetchSolPrice();
        const onChainLiq = await fetchOnChainLiqUsd(tok.poolAddress, cachedSolPrice);
        if (onChainLiq > 0) {
          currentLiq = onChainLiq;
          if (tok) tok.liquidity = onChainLiq;
        }
      } catch { /* non-fatal */ }
    }

    if (currentLiq < 25_000) continue;

    logger.info(
      { mint: mint.slice(0, 12), symbol: pending.symbol, liquidity: currentLiq.toFixed(0) },
      'LIQUIDITY REACHED: liquidity reached $25k threshold',
    );

    logger.info(
      { mint: mint.slice(0, 12), symbol: pending.symbol, wallets: pending.qualifyingWallets.map(w => w.slice(0, 12)) },
      'WALLET VALIDATION: checking if qualifying wallets are still holding',
    );

    const stillHolding = await verifyWalletsStillHolding(mint, pending.qualifyingWallets, pending.consensusTimestamp);
    if (!stillHolding) {
      logger.info(
        { mint: mint.slice(0, 12), symbol: pending.symbol },
        'WALLET VALIDATION: failed — qualifying wallet no longer holding, cancelling pending signal',
      );
      pendingConsensusSignals.delete(mint);
      continue;
    }

    logger.info(
      { mint: mint.slice(0, 12), symbol: pending.symbol },
      'WALLET VALIDATION: passed — all qualifying wallets are still holding',
    );

    if (openPositions.has(mint) || tok?.entryTriggered || entryLocks.has(mint) || everTradedMints.has(mint) || slippageSkippedMints.has(mint)) {
      logger.info(
        { mint: mint.slice(0, 12), symbol: pending.symbol },
        'Deferred entry skipped: token already traded or entry in progress',
      );
      pendingConsensusSignals.delete(mint);
      continue;
    }

    const poolBornMs = Math.min(
      tok?.migrationTime ?? Infinity,
      tok?.pairCreatedAt && tok.pairCreatedAt > 0 ? tok.pairCreatedAt : Infinity,
    );
    const ageMinutes = (Date.now() - poolBornMs) / 60_000;
    if (ageMinutes < 10) {
      logger.info(
        { mint: mint.slice(0, 12), symbol: pending.symbol, ageMin: ageMinutes.toFixed(1) },
        'Deferred entry waiting: token too new (< 10 min age)',
      );
      continue;
    }

    const freezable = await isMintFreezable(mint);
    if (freezable) {
      logger.info(
        { mint: mint.slice(0, 12), symbol: pending.symbol },
        'Deferred entry skipped: token is freezable',
      );
      pendingConsensusSignals.delete(mint);
      continue;
    }

    const currentPrice = tok?.price ?? pending.priceAtDetection;
    if (currentPrice > 0 && currentPrice >= 0.001) {
      logger.info(
        { mint: mint.slice(0, 12), symbol: pending.symbol, price: currentPrice },
        'Deferred entry skipped: price >= $0.001 filter',
      );
      pendingConsensusSignals.delete(mint);
      continue;
    }

    logger.info(
      { mint: mint.slice(0, 12), symbol: pending.symbol },
      'DEFERRED ENTRY: executing deferred consensus trade',
    );

    let maxSlippageForQueue = 20;
    try { maxSlippageForQueue = (await getSettings()).sniperSlippagePct ?? 20; } catch {}

    if (openPositions.size >= MAX_POSITIONS) {
      enqueueSignal(
        mint, pending.name, pending.symbol, pending.sizePct, pending.triggerAmountUsd,
        currentPrice, pending.buyerWallet, pending.buyDetectedTimestamp, pending.tpTier,
        pending.entryMode, pending.entryScore, pending.qualifyingWalletsCount, maxSlippageForQueue,
        pending.qualifyingWallets,
      );
    } else {
      await enterSniperPosition(
        mint, pending.name, pending.symbol, pending.sizePct, pending.triggerAmountUsd,
        currentPrice, pending.buyerWallet, pending.buyDetectedTimestamp, pending.tpTier,
        pending.entryMode, pending.entryScore, pending.qualifyingWalletsCount, undefined, pending.qualifyingWallets,
      );
    }

    pendingConsensusSignals.delete(mint);
  }
}

// Non-overlapping market refresh: waits for each run to finish before scheduling the next
// ── Session on/off flag + generation token ────────────────────────────────────
// _sniperEngineRunning gates rescheduling. _loopGen is a monotonic counter that
// increments on every stop(); each loop captures its generation at start time
// and bails if the generation has changed — preventing stale callbacks from a
// previous run from spawning a new chain after a resume().
let _sniperEngineRunning = false;
let _loopGen = 0;

function scheduleMarketRefresh(gen = _loopGen): void {
  setTimeout(async () => {
    if (!_sniperEngineRunning || _loopGen !== gen) return;
    try { await refreshTrackedTokensMarketData(); } catch { /* non-fatal */ }
    if (_sniperEngineRunning && _loopGen === gen) scheduleMarketRefresh(gen);
  }, MARKET_REFRESH_MS);
}

// Non-overlapping buy-poll loop: waits for the full sweep to finish before
// scheduling the next one so the same buyer buy is never detected twice.
// Per-mint pollLocks prevent concurrent polls of the same mint, so running
// mints in parallel batches is safe — per-mint duplicates are impossible.
//
// OLD: serial loop with 300ms stagger → 39 tokens × ~500ms = ~20s cycle.
//      Transactions were 2-6 minutes old by the time they were detected.
// NEW: parallel batches of POLL_CONCURRENCY → ~2s cycle for 39 tokens.
// Lowered from 10 to 4: HELIUS_MAX_CONCURRENT=3 means only 3 calls can
// actually run at once anyway; 10 parallel mints created a burst backlog
// that triggered back-to-back 429s (5→10→20s cascades) every sweep,
// freezing wallet scoring for up to 20s at a time.
const POLL_CONCURRENCY = 4; // poll up to 4 mints concurrently (matches Helius concurrent budget)

function scheduleBuyPoll(gen = _loopGen): void {
  setTimeout(async () => {
    if (!_sniperEngineRunning || _loopGen !== gen) return;
    try {
      // Always prune expired tokens — independent of trading window.
      // Without this guard, expired tokens accumulate in memory whenever the
      // trading window is closed, and the UI never shows them as removed.
      pruneExpiredTracking();

      // Always poll — handleVolumeUpdate's own trading-window guard blocks
      // actual entries when outside the window, but wallet scoring and the
      // signal feed must run 24/7 so the UI always shows buy activity.
      // Previously this block was gated on isInTradingWindow(), which caused
      // the signal feed to show "No buyer wallets scored yet" for the entire
      // off-hours period (e.g. 00:00–17:00 IST when window=17:00–00:00).
      const mints = Array.from(trackedTokens.keys());
      // Poll all tracked mints in parallel batches — per-mint pollLocks
      // prevent any single mint from overlapping with itself.
      for (let i = 0; i < mints.length; i += POLL_CONCURRENCY) {
        await Promise.all(
          mints.slice(i, i + POLL_CONCURRENCY).map(mint => pollTokenBuys(mint, false)),
        );
      }
    } catch { /* non-fatal */ }
    if (_sniperEngineRunning && _loopGen === gen) scheduleBuyPoll(gen);
  }, POLL_INTERVAL_MS);
}

// Non-overlapping position monitor loop — same rationale as scheduleBuyPoll.
function schedulePositionMonitor(gen = _loopGen): void {
  setTimeout(async () => {
    if (!_sniperEngineRunning || _loopGen !== gen) return;
    try {
      await monitorPositions();
      broadcastSniperStatus();
    } catch { /* non-fatal */ }
    if (_sniperEngineRunning && _loopGen === gen) schedulePositionMonitor(gen);
  }, PRICE_CHECK_MS);
}

// ── Manual management (called from HTTP routes) ───────────────────────────────

export function findSniperPositionById(id: string): SniperPosition | undefined {
  for (const pos of openPositions.values()) {
    if (pos.id === id) return pos;
  }
  return undefined;
}

function findClosedByIdInternal(id: string): ClosedSniperPosition | undefined {
  return closedPositions.find(p => p.id === id);
}

/** Manually close an open buyer position at its last known price */
export async function manualCloseSniperPosition(id: string, reason: string): Promise<boolean> {
  const pos = findSniperPositionById(id);
  if (!pos) return false;
  // If already being closed by concurrent monitor, report failure (position still exists)
  if (closeLocks.has(pos.mint)) return false;
  await closeSniperPosition(pos, reason);
  // Return true only if position was actually removed from the map
  return !openPositions.has(pos.mint);
}

/** Edit fields of an open buyer position */
export function editSniperPositionFields(id: string, updates: {
  entryPrice?: number; currentSLPrice?: number; triggerAmountUsd?: number;
}): SniperPosition | undefined {
  const pos = findSniperPositionById(id);
  if (!pos) return undefined;
  if (updates.entryPrice !== undefined && updates.entryPrice > 0) {
    pos.entryPrice = updates.entryPrice;
    // Recalculate hard SL if TP1 not yet hit
    if (!pos.tp1Hit) pos.currentSLPrice = updates.entryPrice * (1 - PRICE_SL_PCT);
  }
  if (updates.currentSLPrice !== undefined && updates.currentSLPrice > 0) {
    pos.currentSLPrice = updates.currentSLPrice;
  }
  if (updates.triggerAmountUsd !== undefined && updates.triggerAmountUsd > 0) {
    pos.triggerAmountUsd = updates.triggerAmountUsd;
    pos.tpTier = determineTier(updates.triggerAmountUsd);
  }
  void saveSniperPosition(pos);
  broadcastSniperStatus();
  return pos;
}

/** Delete an open buyer position and refund remaining SOL to balance */
export async function deleteSniperPositionById(id: string): Promise<boolean> {
  const pos = findSniperPositionById(id);
  if (!pos || closeLocks.has(pos.mint) || !openPositions.has(pos.mint)) return false;
  closeLocks.add(pos.mint);
  openPositions.delete(pos.mint);
  try {
    await adjustBalance(pos.remainingSizeSol).catch(() => {});
    await query(`DELETE FROM sniper_positions WHERE id = $1`, [pos.id]).catch(() => {});
    broadcastSniperStatus();
    await processQueue();
  } finally {
    closeLocks.delete(pos.mint);
  }
  return true;
}

/** Edit a closed buyer position record */
export async function editClosedSniperPositionById(id: string, updates: {
  closeReason?: string; closePnlPct?: number;
}): Promise<ClosedSniperPosition | undefined> {
  const pos = findClosedByIdInternal(id);
  if (!pos) return undefined;

  // If PNL % is being changed, adjust the balance by the SOL delta so the
  // portfolio value at the top of the UI stays accurate.
  if (updates.closePnlPct !== undefined && updates.closePnlPct !== pos.closePnlPct) {
    const initSize = pos.initialSizeSol > 0 ? pos.initialSizeSol : pos.sizeSol;
    const oldPnlSol = initSize * (pos.closePnlPct / 100);
    const newPnlSol = initSize * (updates.closePnlPct / 100);
    const deltaSol  = newPnlSol - oldPnlSol;
    await adjustBalance(deltaSol).catch(() => {});
    await broadcastBalance().catch(() => {});
  }

  if (updates.closeReason !== undefined) pos.closeReason = updates.closeReason;
  if (updates.closePnlPct !== undefined) pos.closePnlPct = updates.closePnlPct;
  await query(
    `UPDATE sniper_positions SET close_reason = $2, close_pnl_pct = $3 WHERE id = $1`,
    [id, pos.closeReason, pos.closePnlPct],
  ).catch(() => {});
  broadcastSniperStatus();
  return pos;
}

/** Delete a closed buyer position record */
export async function deleteClosedSniperPositionById(id: string): Promise<boolean> {
  const idx = closedPositions.findIndex(p => p.id === id);
  if (idx === -1) return false;
  closedPositions.splice(idx, 1);
  await query(`DELETE FROM sniper_positions WHERE id = $1`, [id]).catch(() => {});
  broadcastSniperStatus();
  return true;
}

/** Reset all in-memory buyer state — called on full data reset */
export function resetSniperState(): void {
  pendingGraduations.clear();
  trackedTokens.clear();
  openPositions.clear();
  buyLog.splice(0, buyLog.length);
  signalQueue.splice(0, signalQueue.length);
  closedPositions.splice(0, closedPositions.length);
  entryLocks.clear();
  closeLocks.clear();
  pollLocks.clear();
  seenTxns.clear();
  mintCheckpointed.clear();
  resetConsensusState();
  pendingConsensusSignals.clear();
  // Only cleared here because this is invoked by the explicit "reset all data"
  // admin action (which also wipes the DB tables) — a real fresh start.
  // Neither set is cleared as a side effect of normal trading.
  everTradedMints.clear();
  slippageSkippedMints.clear();
  // Unsubscribe all Helius WS mints
  for (const mint of Array.from(_mintUnsubscribe.keys())) wsUnsubscribeMint(mint);
  broadcastSniperStatus();
  logger.info('Sniper engine: state reset (all positions and tracking cleared)');
}

/** Stop all background polling loops. In-flight cycles finish gracefully. */
export function stopSniperEngine(): void {
  if (!_sniperEngineRunning) return;
  _sniperEngineRunning = false;
  _loopGen++; // invalidate any pending setTimeout callbacks from the old generation
  // Unsubscribe all per-mint Helius WS watchers
  for (const mint of Array.from(_mintUnsubscribe.keys())) wsUnsubscribeMint(mint);
  logger.info('Sniper engine: stopped (polling loops will not reschedule)');
}

/** Resume polling loops after a stopSniperEngine() call. Reloads lifetime dedup sets from DB. */
export function resumeSniperEngine(): void {
  if (_sniperEngineRunning) return;
  _sniperEngineRunning = true;
  // Reload lifetime block registries from DB so any mints traded while the
  // sniper was paused (or persisted from a prior session) are never re-entered.
  void loadTradedMintsFromDB();
  void loadSlippageSkippedMintsFromDB();
  scheduleBuyPoll();
  schedulePositionMonitor();
  scheduleMarketRefresh();
  void fetchSolPrice();
  if (isHeliusWsConfigured()) {
    connectSniperWs();
  }
  logger.info('Sniper engine: resumed (lifetime dedup sets reloaded from DB)');
}

// ── GMGN ban-replay ───────────────────────────────────────────────────────────
// Runs every 15 s. When the ban has cleared, re-scores all parked buys so no
// valid signal is permanently lost due to a temporary GMGN rate-limit window.
async function replayBanQueue(): Promise<void> {
  if (getGmgnBannedUntil() > 0) return; // still banned — wait
  if (banReplayQueue.length === 0) return;

  const now = Date.now();
  // Drain the queue first so new ban-queued events during replay don't get re-replayed in this batch.
  const toReplay = banReplayQueue.splice(0).filter(
    e => now - e.txTimestamp <= BAN_REPLAY_MAX_AGE_MS,
  );
  const dropped = banReplayQueue.length; // already spliced — anything re-added was added back by concurrent code
  if (toReplay.length === 0) return;

  logger.info(
    { replaying: toReplay.length },
    'Sniper engine: GMGN ban lifted — replaying queued buy events',
  );
  for (const e of toReplay) {
    if (!trackedTokens.has(e.mint)) continue; // token aged out of the tracking window
    await handleVolumeUpdate(e.mint, e.wallet, e.txUsd, e.txSig, e.priceAtDetection, e.txTimestamp, 'buy');
  }
}

export async function startSniperEngine(): Promise<void> {
  logger.info('Sniper engine: started (paper mode — following pump.fun graduations)');

  // Await both lifetime-block registries before enabling any entry flow so there
  // is no window where a previously blocked mint could slip through on startup.
  await Promise.all([
    loadTradedMintsFromDB(),
    loadSlippageSkippedMintsFromDB(),
  ]);
  void restoreSniperPositionsFromDB();

  _sniperEngineRunning = true;
  scheduleBuyPoll();
  schedulePositionMonitor();

  // Non-overlapping market data refresh for tracked tokens
  scheduleMarketRefresh();

  void fetchSolPrice();

  // Replay buys that were queued during a GMGN rate-limit ban (checks every 15 s).
  setInterval(() => { void replayBanQueue(); }, 15_000);

  // Helius WS for near-instant buy detection (requires HELIUS_API_KEY)
  if (isHeliusWsConfigured()) {
    connectSniperWs();
  } else {
    logger.info('Sniper engine: no HELIUS_API_KEY — using poll-only mode (2s interval)');
  }
}
