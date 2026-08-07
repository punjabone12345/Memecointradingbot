/**
 * Trade Funnel Diagnostic Routes
 * Mounted at /api/diagnostics
 */

import { Router } from 'express';
import {
  getDiagTokens,
  getDiagTopRejected,
  getDiagDailySummary,
  getDiagErrors,
  getDiagFunnelStats,
  getDiagCoverageStats,
} from '../lib/diagnostics.js';
import { getTrenchesDiagnostics } from '../services/trenches.service.js';

const router = Router();

/**
 * GET /api/diagnostics/tokens
 * Paginated list of all tracked tokens.
 * Query params: status (DISCOVERED|TRACKED|TRADED|REJECTED|EXPIRED), limit, offset
 */
router.get('/tokens', async (req, res) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const limit  = req.query.limit  ? parseInt(req.query.limit  as string, 10) : 100;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
    const since  = req.query.since  ? parseInt(req.query.since  as string, 10) : undefined;
    const result = await getDiagTokens({ status, limit, offset, since });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Internal error' });
  }
});

/**
 * GET /api/diagnostics/top-rejected
 * Top 20 tokens that came closest to being traded (proximity score descending).
 */
router.get('/top-rejected', async (req, res) => {
  try {
    const since = req.query.since ? parseInt(req.query.since as string, 10) : undefined;
    const rows = await getDiagTopRejected({ since });
    res.json({ rows });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Internal error' });
  }
});

/**
 * GET /api/diagnostics/summary
 * End-of-day / current-day summary with filter funnel breakdown and rejection reasons.
 * Query param: date (YYYY-MM-DD, defaults to today UTC)
 */
router.get('/summary', async (req, res) => {
  try {
    const date = typeof req.query.date === 'string' ? req.query.date : undefined;
    const summary = await getDiagDailySummary(date);
    res.json(summary);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Internal error' });
  }
});

/**
 * GET /api/diagnostics/errors
 * Recent technical errors (GMGN API failures, price fetch failures, etc.)
 * Query params: limit (default 200), errorType
 */
router.get('/errors', async (req, res) => {
  try {
    const limit     = req.query.limit     ? parseInt(req.query.limit     as string, 10) : 200;
    const errorType = typeof req.query.errorType === 'string' ? req.query.errorType : undefined;
    const rows = await getDiagErrors({ limit, errorType });
    res.json({ rows });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Internal error' });
  }
});

/**
 * GET /api/diagnostics/funnel
 * Aggregated funnel stats for the last 7 days: how many tokens passed each filter stage.
 */
router.get('/funnel', async (req, res) => {
  try {
    const since = req.query.since ? parseInt(req.query.since as string, 10) : undefined;
    const stats = await getDiagFunnelStats({ since });
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Internal error' });
  }
});

/**
 * GET /api/diagnostics/coverage
 * Discovery pipeline coverage: GMGN discovery stats, DexScreener validation delays,
 * validation outcome breakdown, and re-discovery stats.
 * Combines in-memory scanner stats (from trenches service) with DB-computed lifecycle timing.
 * Query param: since (unix ms, defaults to last 24 h)
 */
router.get('/coverage', async (req, res) => {
  try {
    const since   = req.query.since ? parseInt(req.query.since as string, 10) : undefined;
    const scanner = getTrenchesDiagnostics();
    const db      = await getDiagCoverageStats({ since });
    res.json({ scanner, db });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Internal error' });
  }
});

export default router;
