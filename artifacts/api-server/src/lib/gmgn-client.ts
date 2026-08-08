// ── GMGN OpenAPI client — read-only wallet analytics ─────────────────────────
//
// Minimal client for the "exist auth" (read-only) subset of the official GMGN
// OpenAPI (https://openapi.gmgn.ai) — the same API surface documented by the
// official `gmgn-cli` / GMGN Agent Skills package (github.com/GMGNAI/gmgn-skills).
//
// Only read endpoints are used (wallet_stats, wallet_activity) — these use
// "exist auth" (X-APIKEY + timestamp + client_id query params, no private-key
// signature required). We deliberately do NOT implement the "signed auth"
// (swap/order/trade) endpoints — this bot never trades through GMGN, it only
// reads wallet performance data to score smart-money wallets.
//
// No API key configured → every call resolves to `null` so callers can treat
// "no data" identically to "GMGN unavailable" and fail safe (no trade).
//
// Multiple keys are supported for credential failover, but they do NOT increase
// throughput: gmgn-limiter.ts enforces one global queue and one global cooldown
// because GMGN rate-limits the source IP.

import axios from 'axios';
import { logger } from './logger.js';
import {
  reserveGmgnSlot,
  applyGmgnBan,
  clearGmgnBan,
  getGmgnKeyBannedUntil,
  getGmgnAllKeysBannedUntil,
  getGmgnAllKeysHardBannedUntil,
  GmgnKeyBannedError,
} from './gmgn-limiter.js';

const GMGN_HOST = process.env.GMGN_API_HOST || 'https://openapi.gmgn.ai';
const REQUEST_TIMEOUT_MS = 4_000;

// ── Per-key state ──────────────────────────────────────────────────────────────
//
// Rate limiting and ban management are now handled by the shared gmgn-limiter.ts
// (which both this module and gmgn-discovery.ts use). This prevents the two
// modules from simultaneously firing on the same API key and triggering bans.

interface KeyState {
  key:       string;
  queueDepth: number;
}

let _keyStates: KeyState[] | null = null;
let _loggedMissingKey             = false;

function getKeyStates(): KeyState[] {
  if (_keyStates !== null) return _keyStates;

  // Deduplicate in case both env vars are set to the same value
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const k of [
    process.env.GMGN_API_KEY,
    process.env.GMGN_API_KEY_2,
    process.env.GMGN_API_KEY_3,
    process.env.GMGN_API_KEY_4,
    process.env.GMGN_API_KEY_5,
    process.env.GMGN_API_KEY_6,
  ]) {
    if (k && !seen.has(k)) { seen.add(k); keys.push(k); }
  }

  if (keys.length === 0) {
    if (!_loggedMissingKey) {
      _loggedMissingKey = true;
      logger.warn(
        'Neither GMGN_API_KEY nor GMGN_API_KEY_2 is set — smart wallet consensus scoring disabled ' +
        '(all wallet scores will be 0, no entries will trigger)',
      );
    }
  } else {
    logger.info(
      { keyCount: keys.length },
      keys.length > 1
        ? 'GMGN: using multiple API keys for failover — shared IP limiter remains global'
        : 'GMGN: using 1 API key',
    );
  }

  _keyStates = keys.map(key => ({ key, queueDepth: 0 }));

  return _keyStates;
}

/**
 * Picks the least-loaded key that the shared limiter considers available.
 * "Least loaded" = lowest queueDepth; ties broken by ban state (prefer unbanned).
 */
function pickKeySlot(): KeyState | null {
  const available = getKeyStates().filter(s => getGmgnKeyBannedUntil(s.key) === 0);
  if (available.length > 0) {
    return available.reduce((best, s) => s.queueDepth < best.queueDepth ? s : best);
  }
  // All keys banned — pick the one whose ban expires soonest (for error reporting only).
  const all = getKeyStates();
  if (all.length === 0) return null;
  return all.reduce((best, s) => getGmgnKeyBannedUntil(s.key) < getGmgnKeyBannedUntil(best.key) ? s : best);
}

/**
 * Reserves a request slot via the shared GMGN rate limiter.
 * Returns the API key string to use for the request.
 * Throws GmgnKeyBannedError when all keys are banned or none are configured.
 */
async function reserveSlot(): Promise<string> {
  const slot = pickKeySlot();
  if (!slot) throw new GmgnKeyBannedError('No GMGN keys configured');

  slot.queueDepth++;
  try {
    await reserveGmgnSlot(slot.key);
    return slot.key;
  } catch (err) {
    if (err instanceof GmgnKeyBannedError) throw err;
    throw err;
  } finally {
    slot.queueDepth--;
  }
}

function buildAuthQuery(): { timestamp: number; client_id: string } {
  return { timestamp: Math.floor(Date.now() / 1000), client_id: cryptoRandomUUID() };
}

function resetAtSeconds(raw: unknown): number {
  const value = typeof raw === 'number'
    ? raw
    : typeof raw === 'string'
      ? Number(raw)
      : NaN;
  if (!Number.isFinite(value) || value <= 0) return 0;
  // Some responses use milliseconds even though the field is named reset_at.
  return value > 10_000_000_000 ? Math.floor(value / 1_000) : Math.floor(value);
}

function isGmgnRateLimit(body: any, httpStatus?: number): boolean {
  const candidates = [
    body?.error,
    body?.code,
    body?.msg,
    body?.message,
    body?.data?.error,
    body?.data?.code,
    body?.data?.msg,
    body?.data?.message,
  ];
  return httpStatus === 429 || candidates.some((value) =>
    String(value ?? '') === '429' ||
    String(value ?? '').toUpperCase().includes('RATE_LIMIT') ||
    String(value ?? '').toUpperCase().includes('TOO MANY REQUEST'),
  );
}

function getResetAtSeconds(body: any): number {
  return resetAtSeconds(
    body?.reset_at ??
    body?.resetAt ??
    body?.data?.reset_at ??
    body?.data?.resetAt,
  );
}

// Avoid importing node:crypto's randomUUID under a different module boundary —
// use the global (available in Node 20 / browsers) with a fallback.
function cryptoRandomUUID(): string {
  const g = globalThis as any;
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  // Fallback RFC4122-ish v4 UUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function existAuthGet<T = any>(subPath: string, query: Record<string, any>): Promise<T | null> {
  const states = getKeyStates();
  if (states.length === 0) return null; // no keys configured

  let key: string;
  try {
    key = await reserveSlot();
  } catch (err) {
    if (err instanceof GmgnKeyBannedError) return null; // all keys banned — fail fast
    throw err;
  }

  try {
    const { timestamp, client_id } = buildAuthQuery();
    const res = await axios.get(`${GMGN_HOST}${subPath}`, {
      params:  { ...query, timestamp, client_id },
      headers: { 'X-APIKEY': key, 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT_MS,
    });

    // Successful response — let the shared limiter know so it can clear stale ban flags.
    clearGmgnBan(key);

    const body = res.data;
    // GMGN wraps responses as { code, msg, data }. code 0 = success.
    if (body && typeof body === 'object' && 'code' in body) {
      if (body.code !== 0) {
        // Check for in-body rate limit signal (some GMGN versions return code 429 in body).
        // reset_at may arrive as a number OR a numeric string — handle both.
        if (isGmgnRateLimit(body)) {
          const resetAtSec = getResetAtSeconds(body);
          // Apply ban with parsed reset_at, or fallback to 2-minute ban if unparseable.
          applyGmgnBan(key, resetAtSec > 0 ? resetAtSec : Math.floor(Date.now() / 1000) + 120);
        } else {
          logger.warn({ subPath, code: body.code, msg: body.msg }, 'GMGN: API returned non-zero code — wallet score will fall back to 0');
        }
        return null;
      }
      return body.data as T;
    }
    return body as T;
  } catch (err: any) {
    const data = err?.response?.data;
    const isRateLimit = isGmgnRateLimit(data, err?.response?.status);
    if (isRateLimit) {
      // reset_at may arrive as number OR numeric string — handle both; fallback to 2 min.
      const resetAtSec = getResetAtSeconds(data);
      applyGmgnBan(key, resetAtSec > 0 ? resetAtSec : Math.floor(Date.now() / 1000) + 120);
    } else {
      // Elevated to warn so GMGN failures are visible in production logs.
      logger.warn(
        { subPath, status: err?.response?.status, data, err: err?.message },
        'GMGN: request failed — wallet score will fall back to 0',
      );
    }
    return null;
  }
}

// NOTE on field names: these mirror the ACTUAL /v1/user/wallet_stats response
// shape (verified against the live API), which differs from GMGN's older/other
// docs. Win rate and average holding period are nested under `pnl_stat`, trade
// counts are plain `buy`/`sell` (not `buy_count`/`sell_count`), and the
// realized-PnL ratio is `realized_profit_pnl` (not `pnl`). Getting any of these
// wrong silently zeroes every wallet score (all fields read as `undefined`,
// so every scoring condition falls through) — always verify against a live
// response before renaming.
export interface GmgnWalletStats {
  realized_profit?: number;
  unrealized_profit?: number;
  realized_profit_pnl?: number; // ratio, e.g. -0.072 = -7.2% realized ROI
  total_cost?: number;
  buy?: number;
  sell?: number;
  pnl_stat?: {
    winrate?: number; // 0-1 ratio
    avg_holding_period?: number; // seconds
    token_num?: number;
    [key: string]: any;
  };
  [key: string]: any;
}

export interface GmgnWalletActivityItem {
  tx_hash?: string;
  event_type?: 'buy' | 'sell' | 'add' | 'remove' | 'transfer';
  token?: { address?: string; symbol?: string };
  token_amount?: number;
  cost_usd?: number;
  price_usd?: number;
  timestamp?: number;
  [key: string]: any;
}

export interface GmgnWalletActivityResponse {
  activities?: GmgnWalletActivityItem[];
  next?: string;
  [key: string]: any;
}

/** GET /v1/user/wallet_stats — win rate, pnl, buy/sell counts for a wallet over a period. */
export async function getWalletStats(chain: string, wallet: string, period: '1d' | '7d' | '30d' = '30d'): Promise<GmgnWalletStats | null> {
  const data = await existAuthGet<any>('/v1/user/wallet_stats', { chain, wallet_address: wallet, period });
  // API can return either a single object or a single-element array for one wallet.
  if (Array.isArray(data)) return data[0] ?? null;
  return data ?? null;
}

/** GET /v1/user/wallet_activity — recent transaction history, used to approximate wallet age & hold time. */
export async function getWalletActivity(chain: string, wallet: string, limit = 50): Promise<GmgnWalletActivityResponse | null> {
  return existAuthGet<GmgnWalletActivityResponse>('/v1/user/wallet_activity', { chain, wallet_address: wallet, limit });
}

/** True when at least one GMGN API key is configured. */
export function isGmgnConfigured(): boolean {
  return getKeyStates().length > 0;
}

/**
 * Non-zero when ALL configured GMGN keys are simultaneously rate-limit banned (unix ms).
 * Includes post-ban warmup period — use this for UI display and cache TTL calculations.
 * Returns 0 as soon as any key becomes available (ban + warmup cleared for that key).
 * Delegates to the shared gmgn-limiter which is the authoritative ban state.
 */
export function getGmgnBannedUntil(): number {
  const states = getKeyStates();
  if (states.length === 0) return 0;
  return getGmgnAllKeysBannedUntil(states.map(s => s.key));
}

/**
 * Non-zero only during an ACTIVE hard ban (429 window) — does NOT include post-ban warmup.
 * Use this in computeScore to decide whether to skip GMGN calls entirely.
 * During warmup, scoring should proceed (reserveGmgnSlot will delay the request naturally)
 * rather than returning _skippedDueToBan, which would block entries unnecessarily.
 */
export function getGmgnHardBannedUntil(): number {
  const states = getKeyStates();
  if (states.length === 0) return 0;
  return getGmgnAllKeysHardBannedUntil(states.map(s => s.key));
}
