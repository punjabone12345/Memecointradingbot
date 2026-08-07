import { WebSocket } from 'ws';
import { logger } from './logger.js';

// ── Shared Helius WebSocket client ──────────────────────────────────────────
// Helius free/dev-tier API keys allow only ONE concurrent WebSocket connection.
// Previously, three separate services (Meteora watcher, PumpFun migration-wallet
// watcher, sniper per-mint watcher) each opened their own independent
// `wss://mainnet.helius-rpc.com` connection with the same key. They competed
// for the single connection slot — at most one would succeed while the others
// got rejected with HTTP 429, then all reconnected on their own timers,
// perpetuating a reconnect storm that starved real-time detection.
//
// This module owns exactly ONE physical connection and multiplexes any number
// of logical `logsSubscribe` subscriptions over it. Callers register/unregister
// subscriptions; on (re)connect, every still-registered subscription is
// automatically re-sent.

interface LogsSub {
  key: string;
  mentions: string[];
  commitment: 'confirmed' | 'processed';
  handler: (value: { signature: string; logs: string[]; err: unknown }) => void;
  subId?: number; // Helius-assigned subscription id once confirmed
}

let ws: WebSocket | null = null;
let ready = false;
let reqId = 1;
let nextSubKey = 1;

const subs = new Map<string, LogsSub>();          // our key -> sub definition
const pendingReqToKey = new Map<number, string>(); // outbound logsSubscribe id -> our key
const subIdToKey = new Map<number, string>();      // Helius subId -> our key

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
// Zombie-connection watchdog: some proxies/NATs (seen on Render) silently drop
// an idle TCP connection without ever sending a FIN/RST, so `ws` stays
// readyState=OPEN and never fires 'close' — no data flows, but nothing ever
// triggers our reconnect logic either. A WS-level ping/pong roundtrip with an
// enforced deadline detects this and forces a reconnect instead of hanging
// indefinitely (or until something unrelated nudges the process).
let lastPongAt = 0;
const PONG_TIMEOUT_MS = 45_000;

const BACKOFF_NORMAL_MIN = 5_000;
const BACKOFF_NORMAL_MAX = 60_000;
const BACKOFF_429_MIN = 60_000;
// Was 300_000 (5 min) — combined with the HTTP-poll cooldown (max 120s) this
// could leave migration discovery degraded for a long stretch during a
// sustained Helius rate-limit episode. Capped to 120s so the WS path retries
// on a similar cadence to the poll fallback's own recovery.
const BACKOFF_429_MAX = 120_000;
let backoffDelay = BACKOFF_NORMAL_MIN;
let last429 = false;
let startedOnce = false;

function getWsUrl(): string | null {
  const apiKey = process.env.HELIUS_API_KEY;
  return process.env.HELIUS_WS_URL ?? (apiKey ? `wss://mainnet.helius-rpc.com/?api-key=${apiKey}` : null);
}

export function isHeliusWsConfigured(): boolean {
  return getWsUrl() !== null;
}

function sendSubscribe(sub: LogsSub): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const id = reqId++;
  pendingReqToKey.set(id, sub.key);
  ws.send(JSON.stringify({
    jsonrpc: '2.0', id,
    method: 'logsSubscribe',
    params: [{ mentions: sub.mentions }, { commitment: sub.commitment }],
  }));
}

function connect(): void {
  const wsUrl = getWsUrl();
  if (!wsUrl) return;

  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (ws) { ws.removeAllListeners(); try { ws.terminate(); } catch {} ws = null; }
  ready = false;

  const safeUrl = wsUrl.replace(/api-key=[^&?]+/, 'api-key=***');
  logger.info({ url: safeUrl, activeSubs: subs.size }, 'Helius WS (shared): connecting…');
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    ready = true;
    backoffDelay = BACKOFF_NORMAL_MIN;
    last429 = false;
    logger.info({ activeSubs: subs.size }, 'Helius WS (shared): connected — resubscribing all');

    // Clear stale subscription-id mappings; re-send every registered subscription.
    subIdToKey.clear();
    pendingReqToKey.clear();
    for (const sub of subs.values()) {
      sub.subId = undefined;
      sendSubscribe(sub);
    }

    lastPongAt = Date.now();
    pingTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
        logger.warn(
          { silentMs: Date.now() - lastPongAt },
          'Helius WS (shared): no pong within deadline — connection is likely a zombie, forcing reconnect',
        );
        ws.terminate(); // triggers 'close' → normal reconnect path
        return;
      }
      ws.ping();
      // App-level getHealth is kept alongside the WS ping as a secondary
      // signal (some intermediary proxies only forward app-level traffic).
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 999999, method: 'getHealth' }));
    }, 30_000);
  });

  ws.on('pong', () => { lastPongAt = Date.now(); });

  ws.on('message', (raw: Buffer) => {
    lastPongAt = Date.now(); // any inbound traffic proves the connection is alive
    try {
      const msg = JSON.parse(raw.toString());

      if (typeof msg.result === 'number' && msg.id !== undefined) {
        const key = pendingReqToKey.get(msg.id);
        if (key) {
          pendingReqToKey.delete(msg.id);
          const sub = subs.get(key);
          if (sub) {
            sub.subId = msg.result;
            subIdToKey.set(msg.result, key);
          } else {
            // Subscription was removed before confirmation arrived — unsubscribe orphan.
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ jsonrpc: '2.0', id: reqId++, method: 'logsUnsubscribe', params: [msg.result] }));
            }
          }
        }
        return;
      }

      if (msg.method !== 'logsNotification') return;
      const value = msg.params?.result?.value;
      if (!value) return;

      const subId: number = msg.params?.subscription;
      const key = subIdToKey.get(subId);
      if (!key) return;
      const sub = subs.get(key);
      if (!sub) return;

      sub.handler({ signature: value.signature, logs: value.logs ?? [], err: value.err });
    } catch { /* ignore parse errors */ }
  });

  ws.on('error', (err: Error) => {
    const msg = err.message ?? '';
    if (msg.includes('429') || msg.toLowerCase().includes('max usage')) {
      last429 = true;
      logger.warn({ msg }, 'Helius WS (shared): 429 rate-limited — will back off before reconnect');
    } else {
      logger.debug({ msg }, 'Helius WS (shared): connection error');
    }
  });

  ws.on('close', () => {
    ready = false;
    ws = null;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }

    if (last429) {
      backoffDelay = Math.min(Math.max(backoffDelay * 2, BACKOFF_429_MIN), BACKOFF_429_MAX);
      last429 = false;
    } else {
      backoffDelay = Math.min(backoffDelay * 2, BACKOFF_NORMAL_MAX);
      if (backoffDelay < BACKOFF_NORMAL_MIN) backoffDelay = BACKOFF_NORMAL_MIN;
    }

    logger.info({ backoffMs: backoffDelay }, 'Helius WS (shared): disconnected — reconnecting with backoff');
    reconnectTimer = setTimeout(connect, backoffDelay);
  });
}

/** Ensure the shared connection is started (idempotent — safe to call from multiple services). */
export function ensureHeliusWsStarted(): void {
  if (startedOnce) return;
  if (!getWsUrl()) {
    logger.warn('Helius WS (shared): no HELIUS_API_KEY / HELIUS_WS_URL — real-time subscriptions disabled (polling only)');
    return;
  }
  startedOnce = true;
  connect();
}

/**
 * Fully stop the shared Helius WebSocket connection and cancel any pending
 * reconnect timer. Resets `startedOnce` so `ensureHeliusWsStarted()` will
 * reconnect cleanly if called again.
 */
export function stopHeliusWs(): void {
  startedOnce = false;
  ready = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (ws) {
    ws.removeAllListeners();
    try { ws.terminate(); } catch {}
    ws = null;
  }
  // Clear server-assigned sub IDs; subscriptions are re-registered on next connect
  for (const sub of subs.values()) sub.subId = undefined;
  subIdToKey.clear();
  pendingReqToKey.clear();
  logger.info('Helius WS (shared): stopped');
}

/**
 * Register a logsSubscribe subscription for one or more "mentions" (program ID or
 * account address). Returns an unsubscribe function. Automatically resubscribes
 * after reconnects.
 */
export function subscribeLogs(
  mentions: string[],
  handler: LogsSub['handler'],
  commitment: 'confirmed' | 'processed' = 'confirmed',
): () => void {
  const key = `sub_${nextSubKey++}`;
  const sub: LogsSub = { key, mentions, commitment, handler };
  subs.set(key, sub);

  ensureHeliusWsStarted();
  if (ready) sendSubscribe(sub);

  return () => {
    const existing = subs.get(key);
    subs.delete(key);
    if (existing?.subId !== undefined) {
      subIdToKey.delete(existing.subId);
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: reqId++, method: 'logsUnsubscribe', params: [existing.subId] }));
      }
    }
  };
}
