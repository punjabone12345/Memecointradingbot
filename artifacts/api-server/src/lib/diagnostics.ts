/**
 * Trade Funnel Diagnostic System
 *
 * Tracks every discovered token through the pipeline from discovery → trade/rejection/expiry.
 * ONE record per mint (contract address). All writes are fire-and-forget — zero impact on
 * the trading pipeline.
 *
 * Tables: diag_tokens, diag_errors
 */

import { query } from './db.js';
import { logger } from './logger.js';
import { SESSION_START_MS } from './startup.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type DiagTokenStatus =
  | 'DISCOVERED'
  | 'TRACKED'
  | 'TRADED'
  | 'REJECTED'
  | 'EXPIRED';

export interface DiagScanUpdate {
  name?: string;
  symbol?: string;
  currentMc?: number;
  currentLiquidity?: number;
  currentVolume?: number;
  currentBuySellRatio?: number;
  walletScore?: number;
  qualifyingWalletsCount?: number;
  ageMinutes?: number;
  // Filter pass flags — only ever set true, never cleared back to false
  passedMc?: boolean;
  passedLiquidity?: boolean;
  passedVolume?: boolean;
  passedRugcheck?: boolean;
  passedHolder?: boolean;
  passedCreator?: boolean;
  passedWallet?: boolean;
  passedEntry?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Write API — all async, all should be called with `void fn().catch(() => {})`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Called when a token is first discovered by the scanner.
 * Creates the initial diagnostic record (no-op if already exists).
 */
export async function diagTokenDiscovered(
  mint: string,
  source: string,
  data: {
    name?: string;
    symbol?: string;
    initialMc?: number;
    initialLiquidity?: number;
    initialVolume?: number;
    initialBuySellRatio?: number;
  } = {},
): Promise<void> {
  const now = Date.now();
  const mc  = data.initialMc ?? 0;
  const liq = data.initialLiquidity ?? 0;
  const vol = data.initialVolume ?? 0;
  const bsr = data.initialBuySellRatio ?? 0;
  try {
    await query(`
      INSERT INTO diag_tokens (
        mint, name, symbol,
        first_seen_at, discovery_source,
        initial_mc, initial_liquidity, initial_volume, initial_buy_sell_ratio,
        current_mc, current_liquidity, current_volume, current_buy_sell_ratio,
        highest_mc, highest_liquidity, highest_volume, highest_buy_sell_ratio,
        status, last_updated, created_at
      ) VALUES (
        $1,$2,$3,
        $4,$5,
        $6,$7,$8,$9,
        $6,$7,$8,$9,
        $6,$7,$8,$9,
        'DISCOVERED',$4,$4
      )
      ON CONFLICT (mint) DO NOTHING
    `, [mint, data.name ?? '', data.symbol ?? '', now, source, mc, liq, vol, bsr]);
  } catch (err: any) {
    logger.debug({ err: err?.message, mint }, 'diag: tokenDiscovered write failed (non-fatal)');
  }
}

/**
 * Called on every buy evaluation for a tracked token.
 * Updates current + peak values, filter-pass timestamps, and scan counter.
 * Safe to call many times — all updates are incremental and non-destructive.
 */
export async function diagTokenScanned(mint: string, update: DiagScanUpdate): Promise<void> {
  const now = Date.now();
  try {
    // Build SET clause dynamically to avoid overwriting fields we don't have data for
    const sets: string[] = [
      `scan_count   = diag_tokens.scan_count + 1`,
      `last_updated = $1`,
      `status = CASE WHEN status = 'DISCOVERED' THEN 'TRACKED' ELSE status END`,
    ];
    const params: unknown[] = [now];
    let p = 2;

    function addField(col: string, val: unknown): void {
      if (val === undefined || val === null) return;
      sets.push(`${col} = $${p++}`);
      params.push(val);
    }

    function addPeak(currentCol: string, peakCol: string, val: number | undefined): void {
      if (val === undefined) return;
      sets.push(`${currentCol} = $${p}`);
      sets.push(`${peakCol} = GREATEST(COALESCE(diag_tokens.${peakCol}, 0), $${p})`);
      params.push(val);
      p++;
    }

    if (update.name)   addField('name',   update.name);
    if (update.symbol) addField('symbol', update.symbol);

    addPeak('current_mc',              'highest_mc',              update.currentMc);
    addPeak('current_liquidity',       'highest_liquidity',       update.currentLiquidity);
    addPeak('current_volume',          'highest_volume',          update.currentVolume);
    addPeak('current_buy_sell_ratio',  'highest_buy_sell_ratio',  update.currentBuySellRatio);
    addPeak('current_wallet_score',    'highest_wallet_score',    update.walletScore);

    if (update.qualifyingWalletsCount !== undefined) {
      sets.push(`current_qualifying_wallets = $${p}`);
      sets.push(`highest_qualifying_wallets = GREATEST(COALESCE(diag_tokens.highest_qualifying_wallets, 0), $${p})`);
      params.push(update.qualifyingWalletsCount);
      p++;
    }

    addField('current_age_minutes', update.ageMinutes);

    // Filter pass timestamps: COALESCE keeps the first-ever timestamp
    const filterMap: [boolean | undefined, string][] = [
      [update.passedMc,        'passed_mc_at'],
      [update.passedLiquidity, 'passed_liquidity_at'],
      [update.passedVolume,    'passed_volume_at'],
      [update.passedRugcheck,  'passed_rugcheck_at'],
      [update.passedHolder,    'passed_holder_at'],
      [update.passedCreator,   'passed_creator_at'],
      [update.passedWallet,    'passed_wallet_at'],
      [update.passedEntry,     'passed_entry_at'],
    ];
    for (const [passed, col] of filterMap) {
      if (passed === true) {
        sets.push(`${col} = COALESCE(diag_tokens.${col}, $${p})`);
        params.push(now);
        p++;
      }
    }

    params.push(mint);
    const whereIdx = p;

    await query(
      `UPDATE diag_tokens SET ${sets.join(', ')} WHERE mint = $${whereIdx}`,
      params,
    );
  } catch (err: any) {
    logger.debug({ err: err?.message, mint }, 'diag: tokenScanned write failed (non-fatal)');
  }
}

/**
 * Called when a token is permanently rejected by any filter.
 * Will not overwrite an existing TRADED or EXPIRED status.
 */
export async function diagTokenRejected(mint: string, reason: string): Promise<void> {
  const now = Date.now();
  try {
    await query(`
      UPDATE diag_tokens
      SET    status       = 'REJECTED',
             reject_reason = $2,
             last_updated  = $3
      WHERE  mint = $1
        AND  status NOT IN ('TRADED', 'EXPIRED')
    `, [mint, reason, now]);
  } catch (err: any) {
    logger.debug({ err: err?.message, mint }, 'diag: tokenRejected write failed (non-fatal)');
  }
}

/**
 * Called immediately after a trade is entered.
 * Sets status = TRADED and stores all entry-checklist fields.
 */
export async function diagTokenTraded(
  mint: string,
  trade: {
    entryTime: number;
    entryPrice: number;
    entryMc: number;
    walletScore: number;
    qualifyingWalletsCount: number;
    entryMode: string;
    riskTier: string;
    entryReason: string;
  },
): Promise<void> {
  const now = Date.now();
  try {
    await query(`
      UPDATE diag_tokens
      SET  status                    = 'TRADED',
           passed_entry_at           = COALESCE(passed_entry_at, $2),
           entry_time                = $2,
           entry_price               = $3,
           entry_mc                  = $4,
           entry_wallet_score        = $5,
           entry_qualifying_wallets  = $6,
           entry_mode                = $7,
           entry_risk_tier           = $8,
           entry_reason              = $9,
           last_updated              = $10
      WHERE mint = $1
    `, [
      mint,
      trade.entryTime,
      trade.entryPrice,
      trade.entryMc,
      trade.walletScore,
      trade.qualifyingWalletsCount,
      trade.entryMode,
      trade.riskTier,
      trade.entryReason,
      now,
    ]);
  } catch (err: any) {
    logger.debug({ err: err?.message, mint }, 'diag: tokenTraded write failed (non-fatal)');
  }
}

/**
 * Called when a token's tracking window expires with no trade.
 * Does not overwrite TRADED or REJECTED status.
 */
export async function diagTokenExpired(mint: string): Promise<void> {
  const now = Date.now();
  try {
    await query(`
      UPDATE diag_tokens
      SET  status      = 'EXPIRED',
           last_updated = $2
      WHERE mint = $1
        AND status NOT IN ('TRADED', 'REJECTED')
    `, [mint, now]);
  } catch (err: any) {
    logger.debug({ err: err?.message, mint }, 'diag: tokenExpired write failed (non-fatal)');
  }
}

/**
 * Log a technical error (API timeout, RPC failure, price unavailable, etc.).
 * Separate table — never blocks.
 */
export async function diagTechError(
  errorType: string,
  message: string,
  mint?: string,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    await query(`
      INSERT INTO diag_errors (error_type, message, mint, details, occurred_at)
      VALUES ($1, $2, $3, $4, $5)
    `, [errorType, message, mint ?? null, details ? JSON.stringify(details) : null, Date.now()]);
  } catch {
    // non-fatal — never log errors about errors
  }
}

// ── Discovery pipeline lifecycle events ───────────────────────────────────────

/**
 * Records a key milestone timestamp during the validation phase.
 * Uses COALESCE to preserve the first-ever value across re-discovery attempts.
 *
 * Timestamp fields:
 *   first_dexscreener_pair_at — when the validator first got a DexScreener pair
 *   first_nonzero_liq_at      — when the validator first saw liq > 0
 *   liq_min_crossed_at        — when liq first crossed the configured minimum ($500)
 *
 * Text field:
 *   validation_outcome — final result: 'passed' | 'failed_timeout' | 'failed_no_pairs'
 *                        | 'failed_micro' | 'failed_age_cap'
 */
export async function diagTokenValidationMilestone(
  mint: string,
  field: 'first_dexscreener_pair_at' | 'first_nonzero_liq_at' | 'liq_min_crossed_at' | 'validation_outcome',
  value: number | string,
): Promise<void> {
  const now = Date.now();
  try {
    let p = 1;
    if (field === 'validation_outcome') {
      // Overwrite: the last outcome wins (re-discovery may change it to 'passed')
      await query(
        'UPDATE diag_tokens SET validation_outcome = $' + p++ + ', last_updated = $' + p++ + ' WHERE mint = $' + p++,
        [value, now, mint],
      );
    } else {
      // Use COALESCE: keep only the first-ever timestamp (re-discoveries don't reset)
      await query(
        'UPDATE diag_tokens SET ' + field + ' = COALESCE(diag_tokens.' + field + ', $' + p++ + '), last_updated = $' + p++ + ' WHERE mint = $' + p++,
        [value, now, mint],
      );
    }
  } catch (err: any) {
    logger.debug({ err: err?.message, mint, field }, 'diag: validationMilestone write failed (non-fatal)');
  }
}

/**
 * Called when the sniper engine releases a token for re-discovery after a
 * transient validation failure (DexScreener indexing lag, liq = 0, timeout).
 * Increments rediscovery_count so we can see how many tokens needed multiple
 * discovery attempts before passing validation.
 */
export async function diagTokenReleased(mint: string): Promise<void> {
  const now = Date.now();
  try {
    let p = 1;
    await query(
      'UPDATE diag_tokens SET rediscovery_count = COALESCE(rediscovery_count, 0) + 1, last_updated = $' + p++ + ' WHERE mint = $' + p++,
      [now, mint],
    );
  } catch (err: any) {
    logger.debug({ err: err?.message, mint }, 'diag: tokenReleased write failed (non-fatal)');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Read API — used by the /api/diagnostics route
// ─────────────────────────────────────────────────────────────────────────────

export async function getDiagTokens(opts: {
  status?: string;
  limit?: number;
  offset?: number;
  since?: number;  // unix ms — only include tokens first seen at or after this time
}): Promise<{ rows: unknown[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let p = 1;

  if (opts.status) {
    conditions.push('status = $' + p++);
    params.push(opts.status);
  }
  if (opts.since != null) {
    conditions.push('first_seen_at >= $' + p++);
    params.push(opts.since);
  }

  const where  = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit  = Math.min(opts.limit  ?? 100, 500);
  const offset = opts.offset ?? 0;

  const [rows, countResult] = await Promise.all([
    query<unknown>(`
      SELECT *,
        to_char(to_timestamp(first_seen_at / 1000) AT TIME ZONE 'UTC',        'YYYY-MM-DD HH24:MI:SS') AS first_seen_utc,
        to_char(to_timestamp(first_seen_at / 1000) AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI:SS') AS first_seen_ist
      FROM diag_tokens
      ${where}
      ORDER BY last_updated DESC
      LIMIT ${limit} OFFSET ${offset}
    `, params),
    query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM diag_tokens ${where}`, params),
  ]);

  return { rows, total: parseInt(countResult[0]?.count ?? '0', 10) };
}

export async function getDiagTopRejected(opts: { since?: number } = {}): Promise<unknown[]> {
  const conditions: string[] = [`status IN ('REJECTED', 'EXPIRED')`];
  const params: unknown[] = [];
  let p = 1;

  if (opts.since != null) {
    conditions.push('first_seen_at >= $' + p++);
    params.push(opts.since);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  return query<unknown>(`
    SELECT *,
      -- Proximity score 0–100: how close this token came to being traded
      LEAST(100, ROUND(
        (COALESCE(highest_wallet_score, 0)        * 0.40) +
        (LEAST(COALESCE(highest_qualifying_wallets, 0), 2) * 15.0) +
        (CASE WHEN passed_wallet_at    IS NOT NULL THEN 15 ELSE 0 END) +
        (CASE WHEN passed_liquidity_at IS NOT NULL THEN 10 ELSE 0 END) +
        (CASE WHEN passed_mc_at        IS NOT NULL THEN  5 ELSE 0 END) +
        (CASE WHEN passed_volume_at    IS NOT NULL THEN  5 ELSE 0 END) +
        (CASE WHEN passed_rugcheck_at  IS NOT NULL THEN  5 ELSE 0 END) +
        (CASE WHEN passed_holder_at    IS NOT NULL THEN  3 ELSE 0 END) +
        (CASE WHEN passed_creator_at   IS NOT NULL THEN  2 ELSE 0 END)
      )) AS proximity_score,
      to_char(to_timestamp(first_seen_at / 1000) AT TIME ZONE 'UTC',         'YYYY-MM-DD HH24:MI:SS') AS first_seen_utc,
      to_char(to_timestamp(first_seen_at / 1000) AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI:SS') AS first_seen_ist
    FROM diag_tokens
    ${where}
    ORDER BY
      proximity_score DESC,
      highest_wallet_score DESC
    LIMIT 20
  `, params);
}

export async function getDiagDailySummary(date?: string): Promise<unknown> {
  // When an explicit date is given show that full UTC day.
  // When called without a date (the normal UI path) restrict to the current
  // server session so stats always start at zero after a restart.
  const dayStart = date
    ? new Date(date + 'T00:00:00Z')
    : (() => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; })();
  // Lower bound: session start (resets on restart) unless a specific date was requested.
  const dayStartMs  = date ? dayStart.getTime() : SESSION_START_MS;
  const dayEndMs    = dayStart.getTime() + 86_400_000; // always end-of-day so today's data is included

  const [summary] = await query<{
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
  }>(`
    SELECT
      COUNT(*)::text                                                      AS total_discovered,
      COALESCE(SUM(scan_count), 0)::text                                  AS total_scans,
      ROUND(COALESCE(AVG(scan_count), 0), 1)::text                       AS avg_scans,
      COUNT(*) FILTER (WHERE passed_mc_at        IS NOT NULL)::text       AS passed_mc,
      COUNT(*) FILTER (WHERE passed_liquidity_at IS NOT NULL)::text       AS passed_liquidity,
      COUNT(*) FILTER (WHERE passed_volume_at    IS NOT NULL)::text       AS passed_volume,
      COUNT(*) FILTER (WHERE passed_rugcheck_at  IS NOT NULL)::text       AS passed_rugcheck,
      COUNT(*) FILTER (WHERE passed_wallet_at    IS NOT NULL)::text       AS passed_wallet,
      COUNT(*) FILTER (WHERE passed_entry_at     IS NOT NULL)::text       AS passed_entry,
      COUNT(*) FILTER (WHERE status = 'TRADED')::text                     AS total_traded,
      COUNT(*) FILTER (WHERE status = 'REJECTED')::text                   AS total_rejected,
      COUNT(*) FILTER (WHERE status = 'EXPIRED')::text                    AS total_expired,
      COUNT(*) FILTER (WHERE status = 'TRACKED')::text                    AS total_tracked
    FROM diag_tokens
    WHERE created_at >= $1 AND created_at < $2
  `, [dayStartMs, dayEndMs]);

  const rejectionBreakdown = await query<{ reject_reason: string; count: string }>(`
    SELECT reject_reason, COUNT(*)::text AS count
    FROM   diag_tokens
    WHERE  status IN ('REJECTED', 'EXPIRED')
      AND  reject_reason IS NOT NULL
      AND  created_at >= $1 AND created_at < $2
    GROUP BY reject_reason
    ORDER BY COUNT(*) DESC
  `, [dayStartMs, dayEndMs]);

  const errorSummary = await query<{ error_type: string; count: string }>(`
    SELECT error_type, COUNT(*)::text AS count
    FROM   diag_errors
    WHERE  occurred_at >= $1 AND occurred_at < $2
    GROUP BY error_type
    ORDER BY COUNT(*) DESC
  `, [dayStartMs, dayEndMs]);

  return {
    date:               dayStart.toISOString().slice(0, 10),
    ...summary,
    rejectionBreakdown,
    errorSummary,
  };
}

export async function getDiagErrors(opts: { limit?: number; errorType?: string }): Promise<unknown[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let p = 1;

  if (opts.errorType) {
    conditions.push(`error_type = $${p++}`);
    params.push(opts.errorType);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(opts.limit ?? 200, 1000);
  params.push(limit);

  return query<unknown>(`
    SELECT *,
      to_char(to_timestamp(occurred_at / 1000) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS occurred_utc
    FROM diag_errors
    ${where}
    ORDER BY occurred_at DESC
    LIMIT $${p}
  `, params);
}

export async function getDiagFunnelStats(opts: { since?: number } = {}): Promise<unknown> {
  // Default to SESSION_START_MS so the funnel resets on every server restart.
  // Callers can override with an explicit since timestamp (e.g. for historical views).
  const cutoff = opts.since ?? SESSION_START_MS;

  const funnel = await query<{
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
  }>(`
    SELECT
      COUNT(*)::text                                                        AS total,
      COUNT(*) FILTER (WHERE passed_wallet_at    IS NOT NULL)::text         AS ever_passed_wallet,
      COUNT(*) FILTER (WHERE passed_liquidity_at IS NOT NULL)::text         AS ever_passed_liquidity,
      COUNT(*) FILTER (WHERE passed_entry_at     IS NOT NULL)::text         AS ever_reached_entry,
      COUNT(*) FILTER (WHERE status = 'TRADED')::text                       AS traded,
      COUNT(*) FILTER (WHERE reject_reason ILIKE '%wallet%'
                          OR reject_reason ILIKE '%score%'
                          OR reject_reason ILIKE '%consensus%')::text       AS rejected_wallet,
      COUNT(*) FILTER (WHERE reject_reason ILIKE '%liquidity%'
                          OR reject_reason ILIKE '%sol%')::text             AS rejected_liquidity,
      COUNT(*) FILTER (WHERE reject_reason ILIKE '%too new%'
                          OR reject_reason ILIKE '%age%'
                          OR reject_reason ILIKE '%min old%')::text         AS rejected_age,
      COUNT(*) FILTER (WHERE reject_reason ILIKE '%freeze%')::text          AS rejected_freeze,
      COUNT(*) FILTER (WHERE reject_reason ILIKE '%slippage%')::text        AS rejected_slippage,
      COUNT(*) FILTER (WHERE reject_reason ILIKE '%pool%'
                          OR reject_reason ILIKE '%prune%')::text           AS rejected_pool,
      COUNT(*) FILTER (WHERE status IN ('REJECTED','EXPIRED')
                          AND reject_reason NOT ILIKE '%wallet%'
                          AND reject_reason NOT ILIKE '%score%'
                          AND reject_reason NOT ILIKE '%consensus%'
                          AND reject_reason NOT ILIKE '%liquidity%'
                          AND reject_reason NOT ILIKE '%sol%'
                          AND reject_reason NOT ILIKE '%too new%'
                          AND reject_reason NOT ILIKE '%age%'
                          AND reject_reason NOT ILIKE '%min old%'
                          AND reject_reason NOT ILIKE '%freeze%'
                          AND reject_reason NOT ILIKE '%slippage%'
                          AND reject_reason NOT ILIKE '%pool%'
                          AND reject_reason NOT ILIKE '%prune%')::text      AS rejected_other
    FROM diag_tokens
    WHERE created_at >= $1
  `, [cutoff]);

  return funnel[0] ?? {};
}

/**
 * Discovery pipeline coverage stats — validation lifecycle timing and outcome
 * breakdown. Computed from the new lifecycle columns added to diag_tokens.
 * Covers the last 24 hours unless `since` is specified.
 */
export async function getDiagCoverageStats(opts: { since?: number } = {}): Promise<unknown> {
  const cutoff = opts.since ?? SESSION_START_MS;

  const [lifecycle] = await query<{
    total: string;
    ever_had_pair: string;
    ever_had_nonzero_liq: string;
    ever_crossed_min: string;
    avg_pair_delay_sec: string | null;
    avg_nonzero_liq_delay_sec: string | null;
    avg_min_crossed_delay_sec: string | null;
    total_rediscoveries: string;
    tokens_with_rediscovery: string;
  }>(`
    SELECT
      COUNT(*)::text                                                          AS total,
      COUNT(*) FILTER (WHERE first_dexscreener_pair_at IS NOT NULL)::text    AS ever_had_pair,
      COUNT(*) FILTER (WHERE first_nonzero_liq_at      IS NOT NULL)::text    AS ever_had_nonzero_liq,
      COUNT(*) FILTER (WHERE liq_min_crossed_at        IS NOT NULL)::text    AS ever_crossed_min,
      ROUND(AVG(
        CASE WHEN first_dexscreener_pair_at IS NOT NULL
             THEN (first_dexscreener_pair_at - first_seen_at) / 1000.0 END
      ), 1)::text                                                            AS avg_pair_delay_sec,
      ROUND(AVG(
        CASE WHEN first_nonzero_liq_at IS NOT NULL
             THEN (first_nonzero_liq_at - first_seen_at) / 1000.0 END
      ), 1)::text                                                            AS avg_nonzero_liq_delay_sec,
      ROUND(AVG(
        CASE WHEN liq_min_crossed_at IS NOT NULL
             THEN (liq_min_crossed_at - first_seen_at) / 1000.0 END
      ), 1)::text                                                            AS avg_min_crossed_delay_sec,
      COALESCE(SUM(rediscovery_count), 0)::text                              AS total_rediscoveries,
      COUNT(*) FILTER (WHERE rediscovery_count > 0)::text                    AS tokens_with_rediscovery
    FROM diag_tokens
    WHERE first_seen_at >= $1
  `, [cutoff]);

  const outcomes = await query<{ validation_outcome: string; count: string }>(`
    SELECT
      COALESCE(validation_outcome, 'pending') AS validation_outcome,
      COUNT(*)::text AS count
    FROM diag_tokens
    WHERE first_seen_at >= $1
    GROUP BY validation_outcome
    ORDER BY COUNT(*) DESC
  `, [cutoff]);

  return {
    windowMs:    Date.now() - cutoff,
    windowHours: Math.round((Date.now() - cutoff) / 3_600_000),
    ...lifecycle,
    outcomeBreakdown: outcomes,
  };
}
