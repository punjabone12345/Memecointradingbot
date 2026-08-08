// ── Smart Wallet Consensus — entry decision engine ───────────────────────────
//
// A tracked token is bought ONLY when:
//
//   Consensus: at least TWO distinct wallets with a GMGN score >= 80 buy the
//     same token within a 5-minute window → tpTier 2, 1% risk.
//
// Solo conviction (single wallet >= 95) is intentionally disabled — only
// Tier 2 / consensus entries are permitted.
//
// Wallet score lookups (wallet-score.service.ts) are async and GMGN-backed;
// this module only holds lightweight in-memory bookkeeping of qualifying
// buys per mint so it never blocks the real-time transaction-detection loop.

import { getWalletScore, WalletScoreBreakdown } from './wallet-score.service.js';
import { logger } from '../lib/logger.js';

const CONSENSUS_WINDOW_MS = 5 * 60_000; // 5 minutes
export const SOLO_SCORE_THRESHOLD = 95;
export const CONSENSUS_SCORE_THRESHOLD = 80;
export const SOLO_RISK_PCT = 1.0;
export const CONSENSUS_RISK_PCT = 1.0;

interface QualifyingBuy {
  wallet: string;
  score: number;
  timestamp: number;
}

// mint → qualifying (score >= 80) buys seen in the last 5 minutes
const qualifyingBuys = new Map<string, QualifyingBuy[]>();

export type ConsensusMode = 'solo' | 'consensus' | 'tracking' | 'none' | 'ban_queued';

export interface ConsensusResult {
  trigger: boolean;
  mode: ConsensusMode;
  sizePct: number;
  tpTier: 1 | 2 | 3;
  score: number;
  wallet: string;
  qualifyingWallets: string[];
  scoreBreakdown: WalletScoreBreakdown;
}

function pruneWindow(mint: string, now: number): QualifyingBuy[] {
  const list = qualifyingBuys.get(mint) ?? [];
  const fresh = list.filter(b => now - b.timestamp <= CONSENSUS_WINDOW_MS);
  qualifyingBuys.set(mint, fresh);
  return fresh;
}

/**
 * Evaluate a single detected buy transaction against the Smart Wallet
 * Consensus rules. Looks up the buyer's GMGN score (cached, async) and
 * returns whether this buy should trigger an entry.
 */
export async function evaluateBuy(
  mint: string,
  wallet: string,
  timestamp: number,
  precomputedScore?: WalletScoreBreakdown,
): Promise<ConsensusResult> {
  const scoreResult = precomputedScore ?? await getWalletScore(wallet);

  // If GMGN is rate-banned this wallet scored 0 only because of the ban, not real quality.
  // Return ban_queued so the caller can park the event and replay it once the ban lifts —
  // prevents valid buys from being permanently discarded during a temporary rate-limit window.
  if (scoreResult._skippedDueToBan) {
    return { trigger: false, mode: 'ban_queued', sizePct: 0, tpTier: 1, score: 0, wallet, qualifyingWallets: [], scoreBreakdown: scoreResult };
  }

  const { score } = scoreResult;

  // Solo conviction (score >= 95) is intentionally disabled — only Tier 2 consensus entries are allowed.
  // A score >= 95 still qualifies for the consensus window (it meets the >= 80 threshold).

  if (score >= CONSENSUS_SCORE_THRESHOLD) {
    const now = Date.now();
    const fresh = pruneWindow(mint, now);
    if (!fresh.some(b => b.wallet === wallet)) fresh.push({ wallet, score, timestamp });
    qualifyingBuys.set(mint, fresh);

    const distinctWallets = Array.from(new Set(fresh.map(b => b.wallet)));
    if (distinctWallets.length >= 2) {
      logger.info(
        { mint: mint.slice(0, 12), wallets: distinctWallets.map(w => w.slice(0, 12)) },
        'Wallet consensus: consensus trigger (2+ wallets score >= 80 within 5 min)',
      );
      return { trigger: true, mode: 'consensus', sizePct: CONSENSUS_RISK_PCT, tpTier: 2, score, wallet, qualifyingWallets: distinctWallets, scoreBreakdown: scoreResult };
    }

    return { trigger: false, mode: 'tracking', sizePct: 0, tpTier: 1, score, wallet, qualifyingWallets: distinctWallets, scoreBreakdown: scoreResult };
  }

  return { trigger: false, mode: 'none', sizePct: 0, tpTier: 1, score, wallet, qualifyingWallets: [], scoreBreakdown: scoreResult };
}

/** Drop bookkeeping for a mint once it's no longer tracked (expired, entered, or reset). */
export function clearMintConsensus(mint: string): void {
  qualifyingBuys.delete(mint);
}

/** Reset all in-memory consensus state — called on full data reset. */
export function resetConsensusState(): void {
  qualifyingBuys.clear();
}
