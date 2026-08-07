---
name: Helius shared WebSocket connection
description: Why all Helius WS subscriptions must go through one shared connection, not one socket per service
---

Helius API keys (free/dev tier) allow only ONE concurrent WebSocket connection. Any service that needs real-time `logsSubscribe` data must register through the shared client in `helius-ws-shared.ts` (`subscribeLogs(mentions, handler, commitment)`), never open its own `new WebSocket('wss://mainnet.helius-rpc.com/?api-key=...')`.

**Why:** Three services (Meteora watcher, migration-wallet watcher, whale-sniper per-mint watcher) each opened independent Helius WS connections. They competed for the single connection slot — only one could succeed at a time, the rest got HTTP 429 on handshake, and (one of them had no backoff at all, just a flat 10s retry) the resulting reconnect storm continuously 429'd all three, starving real-time graduation/whale-buy detection. Symptom looked like "frontend frozen" even though polling fallbacks and Telegram notifications kept working.

**How to apply:** `helius-ws-shared.ts` owns the single physical connection with exponential backoff (5-60s normal, 60-300s on 429) and multiplexes any number of logical subscriptions, auto-resubscribing everything on reconnect. When adding a new real-time Helius WS consumer, call `subscribeLogs()` and keep the returned unsubscribe function — do not instantiate `ws.WebSocket` directly against the Helius URL.
