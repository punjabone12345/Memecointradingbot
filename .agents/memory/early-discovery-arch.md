---
name: Early Discovery Architecture
description: Complete Early Demand Discovery system — routes, service, frontend, scoring engine
---

## Architecture

Replaced graduation-sniper + paper-sniper with a single "Early Demand Discovery" system:

- **Backend service**: `artifacts/api-server/src/services/early-discovery.service.ts`
- **Scoring engine**: `artifacts/api-server/src/services/demand-scorer.ts` (max 120 pts)
- **Routes**: `artifacts/api-server/src/routes/early-discovery.ts` — NO `/api` prefix (mounted at `/api` in app.ts via `app.use("/api", router)`)
- **WebSocket server**: `artifacts/api-server/src/websocket/server.ts` — now exports standalone `broadcast(msg)` function using module-level `wss` reference; old service-specific broadcaster callbacks removed
- **Frontend pages**: `artifacts/terminal/src/pages/Dashboard.tsx`, `AnalyticsPage.tsx`, `SettingsPage.tsx`
- **Frontend API hooks**: `artifacts/terminal/src/lib/api.ts` — useWebSocket, useEDStatus, useEDTokens, useEDPositions, useEDConfig, useUpdateEDConfig, useResetPaperBalance, useInjectTestToken
- **Frontend types**: `artifacts/terminal/src/lib/types.ts` — EDToken, EDPosition, EDConfig, EDStatus, EDScores

## Key gotchas

**Route prefix**: `app.ts` mounts router at `/api` → `app.use("/api", router)`. Routes in `early-discovery.ts` must be `/ed/status`, NOT `/api/ed/status` (doubles up to `/api/api/ed/status`).

**broadcast export**: The old `websocket/server.ts` only had an internal `broadcast(wss, msg)` helper. Rewrote to export `broadcast(msg)` using module-level `wss` variable set in `initWebSocketServer()`.

**virtualBalance initialization**: Service class property initializes to `STARTING_BALANCE = 1.0`. `loadBalance()` only overwrites if DB key exists; otherwise stays at 1.0. API logs show `virtualBalance: 1` on init.

## Scoring (demand-scorer.ts)

Max 120 pts:
- Buyer Growth: 25 pts
- Volume: 25 pts  
- Buy Pressure: 25 pts
- Wallet Quality: 25 pts
- Bonding Curve: 20 pts

## Entry conditions

- Score ≥ 95, confirmed for 2 continuous minutes
- Unique buyers ≥ 25, buy pressure ≥ 3x, bonding curve ≥ 70%
- Rugcheck passed, creator < 5%, top holder < 15%

## Position sizing multiplier

- Score 110–120 → 1.0× (100% of positionSizeSol)
- Score 100–109 → 0.75×
- Score 95–99 → 0.5×

## Data sources

- Helius WS: `wss://atlas-mainnet.helius-rpc.com?api-key=${HELIUS_API_KEY}` — transactionSubscribe for pump.fun program
- Pump.fun API: `https://client-api-2-74b1891ee9f9.herokuapp.com/coins/{mint}`
- DexScreener: `https://api.dexscreener.com/tokens/v1/solana/{mint}`
- Rugcheck: reused existing `rugcheck.service.ts`

## WS broadcast type

`"ed_update"` — frontend invalidates `["ed-status"]`, `["ed-tokens"]`, `["ed-positions"]` on receipt.

## Paper TP/SL defaults

- SL: -20%
- TP1: +80% → sell 25% → move SL to breakeven
- TP2: +200% → sell 35%
- Runner trailing: -25% from high
