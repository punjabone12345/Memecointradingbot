import { logger } from './logger.js';

// ── Shared Helius RPC rate limiter ─────────────────────────────────────────
// Multiple services (trenches, sniper, meteora watcher) each hit the
// same Helius API key independently. Previously each had its own backoff,
// so when one service got rate-limited the others kept firing — the
// aggregate request rate never actually dropped, causing a continuous
// stream of 429s (and, downstream, a scanner/UI that never updates because
// every RPC call keeps failing).
//
// This module centralizes ALL Helius RPC calls behind:
//   1. A shared token-bucket (max N requests/sec, default conservative).
//   2. A shared concurrency cap.
//   3. A GLOBAL cooldown — a 429 from ANY service pauses ALL Helius calls
//      across the whole process until the cooldown clears, with exponential
//      growth on repeated 429s.

const MAX_RPS = Math.max(1, Number(process.env.HELIUS_MAX_RPS ?? 5));
const MIN_INTERVAL_MS = Math.ceil(1000 / MAX_RPS);
const MAX_CONCURRENT = Math.max(1, Number(process.env.HELIUS_MAX_CONCURRENT ?? 3));

const COOLDOWN_BASE_MS = 5_000;
const COOLDOWN_MAX_MS = 120_000;

let inFlight = 0;
let lastRequestAt = 0;
// Two-lane wait queue: entry-critical calls (buy detection, entry price
// reads) always jump ahead of routine background polling (market refresh,
// pool-metadata enrichment, validation sweeps) when a concurrency slot frees
// up. Both lanes still share the same global RPS/concurrency/cooldown limits
// — this only affects ORDERING, not the total request budget — so it never
// bypasses Helius rate limits, it just stops the entry pipeline from sitting
// behind low-priority housekeeping calls in the queue.
const priorityQueue: Array<() => void> = [];
const normalQueue: Array<() => void> = [];

let cooldownUntil = 0;
let consecutive429s = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRateLimitedError(err: unknown): boolean {
  const e = err as { message?: string; code?: number } | undefined;
  const msg = String(e?.message ?? '').toLowerCase();
  return (
    msg.includes('429') ||
    e?.code === -32429 ||
    msg.includes('max usage') ||
    msg.includes('too many requests')
  );
}

function reportRateLimit(): void {
  consecutive429s++;
  const delay = Math.min(COOLDOWN_BASE_MS * 2 ** (consecutive429s - 1), COOLDOWN_MAX_MS);
  const until = Date.now() + delay;
  if (until > cooldownUntil) {
    cooldownUntil = until;
    logger.warn(
      { delaySec: Math.round(delay / 1000), consecutive429s },
      'Helius limiter: 429 detected — pausing ALL Helius RPC calls process-wide',
    );
  }
}

function reportSuccess(): void {
  if (consecutive429s > 0) {
    logger.info('Helius limiter: RPC call succeeded — resetting 429 backoff');
  }
  consecutive429s = 0;
}

export function isHeliusCoolingDown(): boolean {
  return Date.now() < cooldownUntil;
}

export function heliusCooldownRemainingMs(): number {
  return Math.max(0, cooldownUntil - Date.now());
}

async function acquireSlot(priority: boolean): Promise<void> {
  for (;;) {
    const now = Date.now();
    if (now < cooldownUntil) {
      await sleep(Math.min(cooldownUntil - now, 5_000));
      continue;
    }
    if (inFlight >= MAX_CONCURRENT) {
      await new Promise<void>((resolve) => {
        (priority ? priorityQueue : normalQueue).push(resolve);
      });
      continue;
    }
    const sinceLast = now - lastRequestAt;
    if (sinceLast < MIN_INTERVAL_MS) {
      await sleep(MIN_INTERVAL_MS - sinceLast);
      continue;
    }
    break;
  }
  inFlight++;
  lastRequestAt = Date.now();
}

function releaseSlot(): void {
  inFlight--;
  // Priority lane always drains first — a queued entry-critical call must
  // never wait behind routine background polling for a free slot.
  const next = priorityQueue.shift() ?? normalQueue.shift();
  if (next) next();
}

// Wrap any Helius RPC call (getParsedTransaction, getSignaturesForAddress, etc.)
// so it respects the shared rate limit + global cooldown.
// `priority: true` marks entry-critical calls (buy detection, entry price
// reads) so they cut ahead of routine background polling in the wait queue
// when concurrency is saturated — see priorityQueue/normalQueue above.
export async function withHeliusLimit<T>(fn: () => Promise<T>, opts?: { priority?: boolean }): Promise<T> {
  await acquireSlot(opts?.priority ?? false);
  try {
    const result = await fn();
    reportSuccess();
    return result;
  } catch (err) {
    if (isRateLimitedError(err)) reportRateLimit();
    throw err;
  } finally {
    releaseSlot();
  }
}
