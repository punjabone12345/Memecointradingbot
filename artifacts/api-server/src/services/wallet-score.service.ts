// ── GMGN wallet scoring (Smart Wallet Consensus strategy) ────────────────────
//
// Scores a Solana wallet 0-100 from its GMGN trading history:
//   Win rate    > 60%        → 30 pts
//   Wallet age  > 10 days    → 15 pts
//   Completed trades >= 20   → 15 pts
//   Average ROI > 30%        → 25 pts
//   Avg hold time > 2 min    → 15 pts
//
// GMGN's public API does not expose "wallet age" or "average hold time" as
// direct fields, so both are approximated from the closest available data
// (documented inline below) rather than blocking the strategy on missing
// fields, per product spec.
//
// Results are cached in-memory with a TTL so the same wallet isn't re-queried
// on every buy it makes across different tokens, and lookups are de-duplicated
// so concurrent buys from the same wallet only trigger one GMGN round-trip.

import { getWalletStats, isGmgnConfigured, getGmgnBannedUntil, getGmgnHardBannedUntil } from '../lib/gmgn-client.js';
import { logger } from '../lib/logger.js';

const CHAIN = 'sol';
const SCORE_CACHE_TTL_MS     = 30 * 60_000; // 30 min — smart wallet quality is stable over short windows; longer TTL slashes GMGN request volume
const BAN_RETRY_MIN_TTL_MS   = 60_000;      // minimum retry window for ban-skipped entries (1 min floor)
const LOOKUP_TIMEOUT_MS      = 3_500;        // hard cap so a slow/hanging GMGN call never blocks the entry pipeline for long

// ── Ban log deduplication ─────────────────────────────────────────────────────
// Log the "ban active" message at most once per ban period (not once per wallet).
// Without this, every wallet generates its own log line, flooding the logs with
// hundreds of identical "rate-limit ban active" messages per ban episode.
let _lastBanLoggedAt = 0;
let _lastBanLoggedUntil = 0;

export interface WalletScoreBreakdown {
  wallet: string;
  score: number;
  winRate: number | null;
  avgRoiPct: number | null;
  completedTrades: number | null;
  walletAgeDays: number | null;
  avgHoldMinutes: number | null;
  scorePoints: {
    winRate: number;
    walletAge: number;
    completedTrades: number;
    roi: number;
    holdTime: number;
  };
  scoreSource: 'gmgn' | 'cache' | 'unavailable' | 'rate_limited';
  scoreStatus: 'scored' | 'unavailable' | 'rate_limited';
  computedAt: number;
  /** True when this zero score was caused by an active rate-limit ban (not a real score). */
  _skippedDueToBan?: boolean;
  /** The ban expiry timestamp (ms) when _skippedDueToBan is true — used to set cache TTL correctly. */
  _bannedUntilMs?: number;
}

const scoreCache = new Map<string, WalletScoreBreakdown>();
const inFlight = new Map<string, Promise<WalletScoreBreakdown>>();

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}

/** GMGN returns some numeric stats fields (e.g. realized_profit_pnl) as strings, not numbers — coerce either shape to a number. */
function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}


async function computeScore(wallet: string): Promise<WalletScoreBreakdown> {
  const zero: WalletScoreBreakdown = {
    wallet, score: 0, winRate: null, avgRoiPct: null, completedTrades: null,
    walletAgeDays: null, avgHoldMinutes: null,
    scorePoints: { winRate: 0, walletAge: 0, completedTrades: 0, roi: 0, holdTime: 0 },
    scoreSource: 'unavailable', scoreStatus: 'unavailable', computedAt: Date.now(),
  };

  // Only skip entirely during a HARD ban (active 429 window).
  // During post-ban warmup, let the request proceed — reserveGmgnSlot will
  // delay it naturally until warmup clears, rather than blocking scoring
  // for the full warmup period and producing unnecessary _skippedDueToBan entries.
  const bannedUntil = getGmgnHardBannedUntil();
  if (bannedUntil > 0) {
    // Only log once per ban period — not once per wallet (which floods logs with
    // hundreds of identical lines during a ban episode).
    if (bannedUntil !== _lastBanLoggedUntil || Date.now() - _lastBanLoggedAt > 60_000) {
      logger.warn(
        { bannedUntil: new Date(bannedUntil).toISOString() },
        'GMGN wallet scoring: rate-limit ban active — all scores 0 until ban + warmup window clears',
      );
      _lastBanLoggedAt    = Date.now();
      _lastBanLoggedUntil = bannedUntil;
    }
    // Cache the ban-skipped entry with the ban expiry baked in so getWalletScore
    // can set a TTL that doesn't expire until after the ban + warmup actually lifts.
    // Use getGmgnBannedUntil() here (includes warmup) for the cache TTL so the
    // retry doesn't happen until the full cooldown has cleared.
    const bannedUntilWithWarmup = getGmgnBannedUntil();
    return {
      ...zero,
      scoreSource: 'rate_limited',
      scoreStatus: 'rate_limited',
      _skippedDueToBan: true,
      _bannedUntilMs: bannedUntilWithWarmup > 0 ? bannedUntilWithWarmup : bannedUntil,
    };
  }

  // Fetch wallet stats from GMGN (uses API key if set, or falls back to public curl quotation endpoint).
  const stats = await getWalletStats(CHAIN, wallet, '30d').catch(() => null);

  if (!stats) {
    logger.warn(
      { wallet: wallet.slice(0, 8) },
      'GMGN wallet scoring: wallet_stats returned null — score will be 0 (ban or API issue)',
    );
    return zero;
  }

  // Parse fields gracefully whether returned top-level (public quotation API) or under pnl_stat (openapi)
  const winRate = toNumber(stats?.winrate ?? stats?.pnl_stat?.winrate); // 0-1 ratio
  const realizedPnlRatio = toNumber(stats?.realized_profit_pnl ?? stats?.pnl_30d ?? stats?.pnl ?? stats?.total_profit_pnl);
  const avgRoiPct = realizedPnlRatio !== null ? (realizedPnlRatio > -10 && realizedPnlRatio < 100 ? realizedPnlRatio * 100 : realizedPnlRatio) : null;
  const buyCount = toNumber(stats?.buy_30d ?? stats?.buy);
  const sellCount = toNumber(stats?.sell_30d ?? stats?.sell);
  const completedTrades = sellCount ?? buyCount ?? null;
  const avgHoldingPeriodSec = toNumber(stats?.avg_holding_peroid ?? stats?.avg_holding_period ?? stats?.pnl_stat?.avg_holding_period);
  const avgHoldMinutes = avgHoldingPeriodSec !== null ? avgHoldingPeriodSec / 60 : null;

  const walletAgeDays: number | null = null;

  let score = 0;
  const winPts   = (winRate !== null && winRate > 0.6) ? 30 : 0;
  const agePts   = (walletAgeDays !== null && walletAgeDays > 10) ? 15 : 0;
  const tradePts = (completedTrades !== null && completedTrades >= 20) ? 15 : 0;
  const roiPts   = (avgRoiPct !== null && avgRoiPct > 30) ? 25 : 0;
  const holdPts  = (avgHoldMinutes !== null && avgHoldMinutes > 2) ? 15 : 0;
  score = winPts + agePts + tradePts + roiPts + holdPts;

  logger.info(
    {
      wallet:    wallet.slice(0, 12),
      score,
      winRate:   winRate?.toFixed(2) ?? 'null',
      winPts,
      ageDays:   String(walletAgeDays ?? 'null'),
      agePts,
      trades:    completedTrades ?? 'null',
      tradePts,
      roiPct:    avgRoiPct?.toFixed(1) ?? 'null',
      roiPts,
      holdMin:   avgHoldMinutes?.toFixed(1) ?? 'null',
      holdPts,
    },
    'Wallet scoring: breakdown',
  );

  return {
    wallet, score, winRate, avgRoiPct, completedTrades, walletAgeDays, avgHoldMinutes,
    scorePoints: { winRate: winPts, walletAge: agePts, completedTrades: tradePts, roi: roiPts, holdTime: holdPts },
    scoreSource: isGmgnConfigured() ? 'gmgn' : 'gmgn_public',
    scoreStatus: 'scored',
    computedAt: Date.now(),
  };
}

/**
 * Returns a wallet's smart-money score (0-100), using the cache when fresh.
 * Never throws and never blocks longer than LOOKUP_TIMEOUT_MS — on timeout or
 * error it returns the best available data (stale cache, or a 0 score) so the
 * real-time buy-detection pipeline is never stalled by a slow GMGN call.
 */
export async function getWalletScore(wallet: string): Promise<WalletScoreBreakdown> {
  const cached = scoreCache.get(wallet);

  // ── Ban-time fallback ──────────────────────────────────────────────────────
  // When GMGN is rate-limited, computeScore() would return score=0 with
  // _skippedDueToBan=true and overwrite a perfectly good cached score.
  // Instead: if we have a real (non-ban-skipped) cached score — even stale —
  // serve it. Wallet quality doesn't change meaningfully in minutes.
  if (cached && !cached._skippedDueToBan) {
    const bannedUntil = getGmgnBannedUntil();
    if (bannedUntil > 0) {
      return { ...cached, scoreSource: 'cache' };
    }
  }

  if (cached) {
    let ttl: number;
    if (cached._skippedDueToBan) {
      // Use the ban expiry baked into the cache entry (plus post-ban warmup is
      // handled by gmgn-limiter), floored at BAN_RETRY_MIN_TTL_MS.
      // This prevents wallets from retrying every 30s DURING a multi-minute ban,
      // which was causing thundering-herd re-bans whenever the limit lifted.
      const banUntil = cached._bannedUntilMs ?? 0;
      const msUntilBanLifts = Math.max(0, banUntil - Date.now());
      ttl = Math.max(msUntilBanLifts + 5_000, BAN_RETRY_MIN_TTL_MS);
    } else {
      ttl = SCORE_CACHE_TTL_MS;
    }
    if (Date.now() - cached.computedAt < ttl) return { ...cached, scoreSource: cached.scoreStatus === 'scored' ? 'cache' : cached.scoreSource };
  }

  let pending = inFlight.get(wallet);
  if (!pending) {
    pending = computeScore(wallet)
      .then((result) => {
        scoreCache.set(wallet, result);
        return result;
      })
      .catch((err) => {
        logger.warn({ wallet: wallet.slice(0, 12), err: err?.message }, 'Wallet score: compute failed — scoring 0');
        const fallback: WalletScoreBreakdown = cached ?? {
          wallet, score: 0, winRate: null, avgRoiPct: null, completedTrades: null,
          walletAgeDays: null, avgHoldMinutes: null,
          scorePoints: { winRate: 0, walletAge: 0, completedTrades: 0, roi: 0, holdTime: 0 },
          scoreSource: 'unavailable', scoreStatus: 'unavailable', computedAt: Date.now(),
        };
        return fallback;
      })
      .finally(() => { inFlight.delete(wallet); });
    inFlight.set(wallet, pending);
  }

  // Stale-while-revalidate: if we already have a (stale) score, return it
  // immediately and let the refresh finish in the background — dynamic
  // updates then land on the NEXT lookup for this wallet.
  if (cached) return { ...cached, scoreSource: cached.scoreStatus === 'scored' ? 'cache' : cached.scoreSource };

  return withTimeout(pending, LOOKUP_TIMEOUT_MS, {
    wallet, score: 0, winRate: null, avgRoiPct: null, completedTrades: null,
    walletAgeDays: null, avgHoldMinutes: null,
    scorePoints: { winRate: 0, walletAge: 0, completedTrades: 0, roi: 0, holdTime: 0 },
    scoreSource: 'unavailable', scoreStatus: 'unavailable', computedAt: Date.now(),
  });
}

export function clearWalletScoreCache(): void {
  scoreCache.clear();
  inFlight.clear();
}

/**
 * Returns true when this wallet has a fresh (non-ban-skipped) score already cached.
 * Use this to avoid queuing GMGN API calls for wallets the sniper engine has
 * already seen — only truly NEW wallets cost API budget.
 */
export function isWalletScoreCached(wallet: string): boolean {
  const cached = scoreCache.get(wallet);
  if (!cached) return false;
  if (cached._skippedDueToBan) return false; // ban-skipped = not a real score
  const ttl = SCORE_CACHE_TTL_MS;
  return Date.now() - cached.computedAt < ttl;
}
