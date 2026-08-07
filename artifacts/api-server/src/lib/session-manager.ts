/**
 * Session Manager — governs whether all background services are running.
 *
 * Two signals are combined into one "should run" decision:
 *   1. botEnabled (manual toggle, persisted in DB) — false = hard stop, no auto-resume.
 *   2. tradingWindow (IST schedule) — when enabled, services pause outside the window
 *      and auto-resume when the window opens, as long as botEnabled is true.
 *
 * A 60-second ticker re-evaluates the window every minute so transitions happen
 * within 1 minute of the configured start/end time.
 */

import { getSettings } from '../services/settings.service.js';
import { startTrenchesScanner, stopTrenchesScanner } from '../services/trenches.service.js';
import { resumeSniperEngine, stopSniperEngine } from '../services/sniper-engine.service.js';
import { startTelegramCommands, stopTelegramCommands } from './telegram-commands.js';
import { stopHeliusWs } from './helius-ws-shared.js';
import { logger } from './logger.js';

// Current observed state of services. null = not yet initialised.
let _servicesRunning: boolean | null = null;
let _scheduleTimer: ReturnType<typeof setTimeout> | null = null;

// ── IST window helpers ────────────────────────────────────────────────────────

function getISTMinutes(): number {
  // Intl.DateTimeFormat is the only correct way to get IST regardless of host timezone.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === 'hour')?.value  ?? '0', 10);
  const m = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  return (h % 24) * 60 + m; // normalise hour=24 (midnight) to 0
}

function isInsideWindow(start: string, end: string): boolean {
  const cur = getISTMinutes();
  const [sh, sm] = (start || '00:00').split(':').map(Number);
  const [eh, em] = (end   || '00:00').split(':').map(Number);
  const startMin = sh * 60 + (sm || 0);
  // "00:00" end → treat as 1440 (just before midnight)
  const endMin = (eh === 0 && (em || 0) === 0) ? 1440 : eh * 60 + (em || 0);
  if (startMin < endMin) return cur >= startMin && cur < endMin;
  return cur >= startMin || cur < endMin; // cross-midnight window
}

// ── Decision logic ────────────────────────────────────────────────────────────

/**
 * Compute whether services SHOULD be running right now.
 *  - botEnabled=false  → always stopped (manual override, never auto-resumed)
 *  - tradingWindowEnabled=false → always running (no time restriction)
 *  - tradingWindowEnabled=true  → running only inside the IST window
 *
 * `hard` = true means a full hard-stop (botEnabled=false manual pause).
 * `hard` = false means a soft window-close — only new-entry services stop;
 *          the sniper engine position monitor keeps running for open trades.
 */
async function shouldServicesRun(): Promise<{ run: boolean; hard: boolean; reason: string }> {
  const s = await getSettings();
  if (!s.botEnabled) return { run: false, hard: true,  reason: 'botEnabled=false (manual pause)' };
  if (!s.tradingWindowEnabled) return { run: true, hard: false, reason: 'botEnabled=true, no time restriction' };
  const inWindow = isInsideWindow(s.tradingWindowStart, s.tradingWindowEnd);
  return {
    run: inWindow,
    hard: false, // window transitions are never hard-stops
    reason: inWindow
      ? `inside trading window ${s.tradingWindowStart}–${s.tradingWindowEnd} IST`
      : `outside trading window ${s.tradingWindowStart}–${s.tradingWindowEnd} IST`,
  };
}

// ── Start / stop helpers ──────────────────────────────────────────────────────

function startServices(): void {
  startTrenchesScanner();
  resumeSniperEngine();   // idempotent — no-op if already running
  startTelegramCommands();
}

/**
 * Soft stop — called when the trading window closes.
 * Stops new-graduation detection and Telegram, but intentionally leaves the
 * sniper engine and Helius WS alive so open positions continue to be tracked
 * for P&L, TP, and SL until they close naturally.
 * The sniper engine's own isInTradingWindow() guards block any new entries.
 */
function stopNewEntryServices(): void {
  stopTrenchesScanner();
  stopTelegramCommands();
  logger.info('Session Manager: soft stop — graduation scanner paused; open positions continue tracking');
}

/**
 * Hard stop — called only when botEnabled=false (manual PAUSE BOT).
 * Stops everything including the sniper engine and Helius WS.
 */
function stopAllServices(): void {
  stopTrenchesScanner();
  stopSniperEngine();
  stopTelegramCommands();
  stopHeliusWs();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Re-evaluate the desired state and apply any start/stop transition.
 * No-op when the state hasn't changed. Safe to call from the settings route
 * whenever botEnabled or tradingWindow settings are updated.
 */
export async function applyBotEnabledChange(): Promise<void> {
  const { run, hard, reason } = await shouldServicesRun();
  if (_servicesRunning === run) return; // no transition needed
  _servicesRunning = run;
  if (run) {
    logger.info({ reason }, 'Session Manager: STARTING all services');
    startServices();
  } else if (hard) {
    logger.info({ reason }, 'Session Manager: HARD STOP — all services stopped');
    stopAllServices();
  } else {
    logger.info({ reason }, 'Session Manager: SOFT STOP — pausing new entries, keeping position monitor alive');
    stopNewEntryServices();
  }
}

/** Recurring check — fires every 60 s to catch trading window open/close. */
function scheduleWindowCheck(): void {
  if (_scheduleTimer) { clearTimeout(_scheduleTimer); _scheduleTimer = null; }
  _scheduleTimer = setTimeout(async () => {
    try { await applyBotEnabledChange(); } catch { /* non-fatal */ }
    scheduleWindowCheck();
  }, 60_000);
}

/**
 * Call once from index.ts after all services have been started.
 * Applies the initial state (stops services if needed), then starts the
 * 60-second window-check loop.
 */
export async function initSessionManager(): Promise<void> {
  const { run, hard, reason } = await shouldServicesRun();
  _servicesRunning = run;

  if (!run && hard) {
    logger.info({ reason }, 'Session Manager: initialising in HARD STOP state — stopping all services');
    stopAllServices();
  } else if (!run) {
    logger.info({ reason }, 'Session Manager: initialising in SOFT STOP state — pausing new entries, position monitor alive');
    stopNewEntryServices();
  } else {
    logger.info({ reason }, 'Session Manager: initialising in RUNNING state');
  }

  // Start the recurring window check regardless of initial state, so the bot
  // auto-resumes when the trading window opens.
  scheduleWindowCheck();
}
