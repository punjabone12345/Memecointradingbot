import { query } from '../lib/db.js';
import { Settings } from '../types/index.js';

// In-memory settings cache — avoids a DB round-trip on every 1s check tick.
// Invalidated immediately on any write (updateSetting/updateSettings).
let settingsCache: Settings | null = null;
let settingsCacheAt = 0;
const SETTINGS_CACHE_TTL = 8_000; // 8 seconds

// Balance cache — refreshed every 5s instead of every 1s tick
let balanceCache: number | null = null;
let balanceCacheAt = 0;
const BALANCE_CACHE_TTL = 5_000;

export function invalidateSettingsCache(): void {
  settingsCache = null;
  settingsCacheAt = 0;
  balanceCache = null;
  balanceCacheAt = 0;
}

export async function getSettings(): Promise<Settings> {
  const now = Date.now();
  if (settingsCache && now - settingsCacheAt < SETTINGS_CACHE_TTL) {
    return settingsCache;
  }

  const rows = await query<{ key: string; value: string }>('SELECT key, value FROM settings');
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;

  const num = (k: string, def: number) => parseFloat(map[k] ?? String(def));
  const bool = (k: string, def: boolean) => (map[k] ?? String(def)) === 'true';
  const str = (k: string, def: string) => map[k] ?? def;

  const settings: Settings = {
    botEnabled: bool('botEnabled', true),
    startingBalanceSol: num('startingBalanceSol', 10),
    currentBalanceSol: num('currentBalanceSol', 10),
    rpcEndpoint: str('rpcEndpoint', 'https://api.mainnet-beta.solana.com'),
    slippagePct: num('slippagePct', 1),
    priorityFeeSol: num('priorityFeeSol', 0.001),
    walletPublicKey: str('walletPublicKey', ''),
    sniperSlippagePct: num('sniperSlippagePct', 20),
    sniperStagnationPct: num('sniperStagnationPct', 5),
    tradingWindowEnabled: bool('tradingWindowEnabled', false),
    tradingWindowStart: str('tradingWindowStart', '17:00'),
    tradingWindowEnd: str('tradingWindowEnd', '00:00'),
    // Sniper TP tier configs
    wt1Tp1Pct: num('wt1Tp1Pct', 50),   wt1Tp1Exit: num('wt1Tp1Exit', 30),
    wt1Tp2Pct: num('wt1Tp2Pct', 125),  wt1Tp2Exit: num('wt1Tp2Exit', 30),  wt1Tp2Trail: num('wt1Tp2Trail', 30),
    wt1Tp3Pct: num('wt1Tp3Pct', 200),  wt1Tp3Exit: num('wt1Tp3Exit', 30),  wt1Tp3Trail: num('wt1Tp3Trail', 20),
    wt2Tp1Pct: num('wt2Tp1Pct', 100),  wt2Tp1Exit: num('wt2Tp1Exit', 30),
    wt2Tp2Pct: num('wt2Tp2Pct', 250),  wt2Tp2Exit: num('wt2Tp2Exit', 30),  wt2Tp2Trail: num('wt2Tp2Trail', 25),
    wt2Tp3Pct: num('wt2Tp3Pct', 400),  wt2Tp3Exit: num('wt2Tp3Exit', 30),  wt2Tp3Trail: num('wt2Tp3Trail', 15),
    wt3Tp1Pct: num('wt3Tp1Pct', 150),  wt3Tp1Exit: num('wt3Tp1Exit', 30),
    wt3Tp2Pct: num('wt3Tp2Pct', 350),  wt3Tp2Exit: num('wt3Tp2Exit', 30),  wt3Tp2Trail: num('wt3Tp2Trail', 20),
    wt3Tp3Pct: num('wt3Tp3Pct', 550),  wt3Tp3Exit: num('wt3Tp3Exit', 30),  wt3Tp3Trail: num('wt3Tp3Trail', 10),
  };

  settingsCache = settings;
  settingsCacheAt = Date.now();
  return settings;
}

export async function updateSetting(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  );
  invalidateSettingsCache();
}

export async function updateSettings(updates: Partial<Record<string, string>>): Promise<void> {
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) await updateSetting(key, value);
  }
  invalidateSettingsCache();
}

export async function getBalance(): Promise<number> {
  const now = Date.now();
  if (balanceCache !== null && now - balanceCacheAt < BALANCE_CACHE_TTL) {
    return balanceCache;
  }
  const rows = await query<{ value: string }>(`SELECT value FROM settings WHERE key = 'currentBalanceSol'`);
  const balance = parseFloat(rows[0]?.value ?? '10');
  balanceCache = balance;
  balanceCacheAt = now;
  return balance;
}

export async function setBalance(sol: number): Promise<void> {
  balanceCache = sol;
  balanceCacheAt = Date.now();
  await updateSetting('currentBalanceSol', String(sol));
}

// Serializes all balance read-modify-write operations so concurrent callers
// (sniper-engine.service.ts) can never race and silently clobber each other's
// balance updates.
let balanceMutex: Promise<unknown> = Promise.resolve();

function withBalanceLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = balanceMutex.then(fn, fn);
  // Swallow errors here so a failed op doesn't permanently block the queue;
  // the actual error still propagates to the caller via `run`.
  balanceMutex = run.catch(() => undefined);
  return run;
}

/**
 * Atomically adjusts the current balance by `deltaSol` (positive or negative),
 * always reading the freshest DB value (bypassing the cache) under a lock so
 * concurrent adjustments never overwrite each other. Returns the new balance.
 * If `floorAtZero` is true (default), the result is clamped to >= 0.
 */
export async function adjustBalance(deltaSol: number, floorAtZero = true): Promise<number> {
  return withBalanceLock(async () => {
    const rows = await query<{ value: string }>(`SELECT value FROM settings WHERE key = 'currentBalanceSol'`);
    const current = parseFloat(rows[0]?.value ?? '10');
    let next = current + deltaSol;
    if (floorAtZero) next = Math.max(0, next);
    balanceCache = next;
    balanceCacheAt = Date.now();
    await updateSetting('currentBalanceSol', String(next));
    return next;
  });
}

export async function resetAllData(): Promise<void> {
  await query(`DELETE FROM sniper_positions`);
  await query(`DELETE FROM traded_mints`).catch(() => {});
  await query(`DELETE FROM slippage_skipped_mints`).catch(() => {});
  const rows = await query<{ value: string }>(`SELECT value FROM settings WHERE key = 'startingBalanceSol'`);
  const start = parseFloat(rows[0]?.value ?? '10');
  balanceCache = start;
  balanceCacheAt = Date.now();
  await updateSetting('currentBalanceSol', String(start));
}
