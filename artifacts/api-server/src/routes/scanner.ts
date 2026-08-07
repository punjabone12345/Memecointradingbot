import { Router } from 'express';
import {
  getDiscoveryFeed,
  getDiscoveryTotal,
  getFiredBySource,
  getTrenchesDiagnostics,
  MIGRATION_WALLET,
} from '../services/trenches.service.js';
import { query } from '../lib/db.js';

const router = Router();

/**
 * GET /api/scanner/sources
 * Returns discovery stats + recent migration feed for the frontend.
 */
router.get('/sources', (_req, res) => {
  const total  = getDiscoveryTotal();
  const feed   = getDiscoveryFeed();
  const diag   = getTrenchesDiagnostics();
  const firedBySource = getFiredBySource();

  res.json({
    // Legacy field kept for any existing consumers
    dexscreener: { total, recent: feed },

    // Primary — pump.fun migration wallet tracker
    pumpfun: {
      total,
      recent:         feed,
      walletAddress:  MIGRATION_WALLET,
      pollCount:      diag.pollCount,
      lastPollAgoSec: diag.lastPollAgoSec,
      consecutiveFailures: diag.consecutiveFailures,
      lastError:      diag.lastPollError,
      heliusApiKeySet: diag.heliusApiKeySet,
      rpcEndpoint:    diag.rpcEndpoint,
      tokensPerHour:  diag.tokensPerHour,
      txFetchErrorRate: diag.txFetchErrorRate,
      firedBySource,
    },

    // Legacy gmgn shape so the frontend can handle both old and new format
    gmgn: {
      total,
      recent: feed,
      recentBySource: { pumpfun_wallet: feed },
      firedBySource:  { rank_1h: 0, migrated: total },
      pollers:        {
        migrated: {
          label:               'pumpfun_wallet',
          pollCount:           diag.pollCount,
          lastSuccessMs:       diag.lastPollSuccessMs,
          lastSuccessAgoSec:   diag.lastPollAgoSec,
          consecutiveFailures: diag.consecutiveFailures,
          lastError:           diag.lastPollError,
          intervalMs:          diag.pollIntervalMs,
          firedTotal:          total,
        },
      },
      avgDiscoveryDelaySec: null,
      gmgnApiKeySet:  false,
      gmgnBanned:     false,
    },
  });
});

/**
 * GET /api/scanner/status
 * Compact real-time status for the migration wallet tracker.
 */
router.get('/status', (_req, res) => {
  res.json(getTrenchesDiagnostics());
});

/**
 * GET /api/scanner/migrations
 * Last 100 detected migrations from DB.
 */
router.get('/migrations', async (_req, res) => {
  try {
    const rows = await query<{
      id: string;
      source: string;
      instruction_type: string | null;
      tx_signature: string;
      pool_address: string | null;
      mint: string | null;
      symbol: string | null;
      liquidity: string;
      creator_wallet: string | null;
      detected_at: string;
    }>(`
      SELECT id, source, instruction_type, tx_signature, pool_address,
             mint, symbol, liquidity, creator_wallet, detected_at
      FROM detected_migrations
      ORDER BY detected_at DESC
      LIMIT 100
    `);
    res.json({ migrations: rows, total: rows.length });
  } catch (err: any) {
    res.json({ migrations: [], total: 0, error: err?.message });
  }
});

export default router;
