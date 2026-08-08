/**
 * Shared GMGN rate limiter — single global queue
 *
 * GMGN enforces its rate limit per IP (not per API key). Having multiple
 * configured keys does NOT multiply the allowed throughput — every request,
 * regardless of which key it uses, counts toward the same IP-level limit.
 *
 * The previous per-key queue design allowed N keys to fire simultaneously,
 * producing N × (1 / INTERVAL_MS) req/s total — exceeding the 1 req/min
 * ceiling with just 2 keys at 90s each (2/90s = 1.33 req/min > 1 req/min).
 *
 * This module uses a SINGLE global queue that serialises every outbound GMGN
 * request across all callers and all keys, ensuring the combined rate never
 * exceeds 1 req / INTERVAL_MS regardless of key count.
 *
 * Per-key ban state is still tracked so:
 *   • applyGmgnBan / clearGmgnBan correctly identify which key was banned
 *   • gmgn-client.ts can fail-fast and switch keys during active bans
 *   • Ban expiry timestamps are surfaced to the UI
 */

import { logger } from './logger.js';

// ── Config ────────────────────────────────────────────────────────────────────

/**
 * Minimum gap between ANY two outbound GMGN requests (all keys combined).
 *
 * GMGN's documented rate limit is 1 req/min per IP. Running at exactly 60 s
 * causes bans due to clock drift vs GMGN's fixed window. 90 s gives a 33%
 * safety margin (0.67 req/min) that survives realistic timing variance.
 * Override via GMGN_INTERVAL_MS env var.
 */
const INTERVAL_MS = Number(process.env.GMGN_INTERVAL_MS) || 1_500;

/**
 * After a hard ban clears, hold all requests for this extra warmup period
 * to prevent the queued-wallet thundering herd from immediately re-triggering
 * another ban as soon as the first post-ban request succeeds.
 */
const POST_BAN_WARMUP_MS = 5_000;

// ── Per-key ban state ─────────────────────────────────────────────────────────

interface KeyState {
  bannedUntilMs:  number;
  resumeAfterMs:  number;  // max(bannedUntilMs, bannedUntilMs + POST_BAN_WARMUP_MS)
  queueDepth:     number;
}

const _keyStates = new Map<string, KeyState>();

function getOrCreate(key: string): KeyState {
  let s = _keyStates.get(key);
  if (!s) {
    s = { bannedUntilMs: 0, resumeAfterMs: 0, queueDepth: 0 };
    _keyStates.set(key, s);
  }
  return s;
}

// ── Global request queue ──────────────────────────────────────────────────────

let _globalQueue: Promise<void> = Promise.resolve();
let _globalLastAt = 0;
// GMGN rate limits the source IP, not just the API key. A ban reported for
// one key therefore blocks every key until the reset window plus warmup ends.
let _globalBannedUntilMs = 0;
let _globalResumeAfterMs = 0;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export class GmgnKeyBannedError extends Error {}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Waits until it is safe to send a GMGN request for this API key.
 *
 * All calls — regardless of which key they use — share a single global queue.
 * Only one request fires every INTERVAL_MS globally, so even with multiple
 * keys the combined rate stays at 1 req / INTERVAL_MS = 0.67 req/min.
 *
 * Throws GmgnKeyBannedError immediately when the key is still hard-banned
 * (so callers can fail-fast without blocking the queue for other keys).
 */
export function reserveGmgnSlot(key: string): Promise<void> {
  const s = getOrCreate(key);

  // Fail-fast during either a key ban or the shared IP ban. Switching keys
  // during a GMGN IP ban only re-triggers the ban.
  if (s.bannedUntilMs > Date.now() || _globalBannedUntilMs > Date.now()) {
    return Promise.reject(
      new GmgnKeyBannedError(
        `GMGN traffic is banned until ${new Date(
          Math.max(s.bannedUntilMs, _globalBannedUntilMs),
        ).toISOString()}`,
      ),
    );
  }

  s.queueDepth++;
  const run = _globalQueue.then(async () => {
    try {
      const now = Date.now();

      // Re-check bans — another request may have received a 429 while this
      // request was waiting in the global queue.
      if (s.bannedUntilMs > now || _globalBannedUntilMs > now) {
        throw new GmgnKeyBannedError();
      }

      // Post-ban warmup: hold if any key recently triggered the shared ban.
      const warmupUntil = Math.max(s.resumeAfterMs, _globalResumeAfterMs);
      if (warmupUntil > Date.now()) {
        await sleep(warmupUntil - Date.now());
      }

      // Global minimum interval — only one request fires every INTERVAL_MS.
      const elapsed = Date.now() - _globalLastAt;
      if (elapsed < INTERVAL_MS) await sleep(INTERVAL_MS - elapsed);

      _globalLastAt = Date.now();
    } finally {
      s.queueDepth--;
    }
  });

  // Keep the chain alive for subsequent requests even if this slot threw.
  _globalQueue = run.catch(() => {});
  return run;
}

/**
 * Applies a rate-limit ban from a GMGN 429 response.
 * Adds POST_BAN_WARMUP_MS after the ban clears so queued wallets ramp back
 * gradually instead of all firing at once (which was causing immediate re-bans).
 */
export function applyGmgnBan(key: string, resetAtSec: number): void {
  const s = getOrCreate(key);
  const untilMs = resetAtSec * 1_000;
  if (untilMs > s.bannedUntilMs) {
    s.bannedUntilMs = untilMs;
    s.resumeAfterMs = untilMs + POST_BAN_WARMUP_MS;
  }

  // This is intentionally global. GMGN's RATE_LIMIT_BANNED response is tied
  // to the source IP, so another configured key is not a safe failover path
  // until the shared cooldown has elapsed.
  if (untilMs > _globalBannedUntilMs) {
    _globalBannedUntilMs = untilMs;
    _globalResumeAfterMs = untilMs + POST_BAN_WARMUP_MS;
    logger.warn(
      {
        key:         key.slice(0, 8) + '…',
        bannedUntil: new Date(untilMs).toISOString(),
        resumeAfter: new Date(_globalResumeAfterMs).toISOString(),
      },
      'GMGN shared limiter: key banned — all GMGN traffic halted until ban + warmup window clears',
    );
  }
}

/**
 * Clears ban state after a successful response.
 * Only clears if the ban has already expired.
 */
export function clearGmgnBan(key: string): void {
  const s = getOrCreate(key);
  if (s.bannedUntilMs !== 0 && s.bannedUntilMs <= Date.now()) {
    s.bannedUntilMs = 0;
    // Keep resumeAfterMs — let the warmup period drain naturally.
  }
  if (_globalBannedUntilMs !== 0 && _globalBannedUntilMs <= Date.now()) {
    _globalBannedUntilMs = 0;
    // Keep _globalResumeAfterMs so the queue still ramps up gradually.
  }
}

/**
 * Returns the ban expiry timestamp (ms) for a key, or 0 if not banned.
 * Only reflects the hard ban (bannedUntilMs). Does NOT include post-ban warmup.
 */
export function getGmgnKeyBannedUntil(key: string): number {
  const s = _keyStates.get(key);
  if (!s) return 0;
  const until = Math.max(s.bannedUntilMs, _globalBannedUntilMs);
  return until > Date.now() ? until : 0;
}

/**
 * Returns the HARD ban expiry for ALL given keys, or 0 if any key has no hard ban.
 * Does NOT include post-ban warmup.
 */
export function getGmgnAllKeysHardBannedUntil(keys: string[]): number {
  const now = Date.now();
  if (_globalBannedUntilMs > now) return _globalBannedUntilMs;
  const statuses = keys.map(k => {
    const s = _keyStates.get(k);
    if (!s) return 0;
    return s.bannedUntilMs > now ? s.bannedUntilMs : 0;
  });
  if (statuses.some(v => v === 0)) return 0;
  return Math.min(...statuses.filter(v => v > 0));
}

/**
 * Returns the earliest time (ms) at which ANY of the given keys will be
 * available (ban + warmup cleared). Returns 0 immediately if any key is ready.
 */
export function getGmgnAllKeysBannedUntil(keys: string[]): number {
  const now = Date.now();
  const globalBlockedUntil = Math.max(_globalBannedUntilMs, _globalResumeAfterMs);
  if (globalBlockedUntil > now) return globalBlockedUntil;
  const statuses = keys.map(k => {
    const s = _keyStates.get(k);
    if (!s) return 0;
    const blockedUntil = Math.max(s.bannedUntilMs, s.resumeAfterMs);
    return blockedUntil > now ? blockedUntil : 0;
  });
  if (statuses.some(v => v === 0)) return 0;
  return Math.min(...statuses.filter(v => v > 0));
}

/**
 * No-op — kept for API compatibility. Key staggering is no longer needed
 * because all keys share a single global queue; they cannot fire simultaneously
 * regardless of their individual initialization order.
 */
export function staggerKeyInitialization(_keys: string[], _intervalMs: number): void {
  // Intentionally empty — global queue renders per-key staggering redundant.
}
