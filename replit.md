# Apex Meme Trader

A Solana memecoin graduation sniper bot — automatically detects tokens graduating from Pump.fun to Raydium and executes timed buy/sell trades with configurable TP/SL/trailing-stop logic.

## Run & Operate

- API server runs on port **8080** (`artifacts/api-server`) — `pnpm --filter @workspace/api-server run dev`
- Frontend runs on port **5000** (`artifacts/terminal`) — `pnpm --filter @workspace/terminal run dev`
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- Required env: `DATABASE_URL` — Postgres connection string (set in Replit Secrets)

## Stack

- pnpm workspaces, Node.js 20, TypeScript 5
- API: Express 5, port 8080
- DB: PostgreSQL + Drizzle ORM
- Build: esbuild (ESM bundle via `build.mjs`)
- Frontend: React + Vite (proxies `/api` and `/ws` to :8080)
- Solana: @solana/web3.js + Jupiter Lite API (`https://lite-api.jup.ag/swap/v1/`)

## Where things live

- `artifacts/api-server/src/services/sniper-engine.service.ts` — the ONLY entry/exit engine (no separate "whale" mirror-trading module exists): tracks Pump.fun graduations for 30 min, scores every buyer wallet via GMGN, and enters on the Smart Wallet Consensus decision; manages TP/SL/trailing-stop positions in the `sniper_positions` table
- `artifacts/api-server/src/services/trenches.service.ts` — GMGN-first token discovery: polls `/defi/quotation/v1/tokens/new_pairs/sol` every 15 s and `/defi/quotation/v1/rank/sol/swaps/5m` (trending) every 30 s; same exported interface as before so no other files changed
- `artifacts/api-server/src/lib/gmgn-discovery.ts` — dedicated GMGN HTTP client for discovery; separate rate limiter (500 ms interval) so wallet-scoring calls (gmgn-client.ts) are never starved
- `artifacts/api-server/src/services/wallet-score.service.ts` — GMGN-backed wallet scoring (0-100) with in-memory TTL cache
- `artifacts/api-server/src/services/wallet-consensus.service.ts` — per-mint consensus bookkeeping (2×score≥80 within 5 min, or 1×score≥95) → entry trigger + position size + TP tier
- `artifacts/api-server/src/lib/gmgn-client.ts` — minimal GMGN OpenAPI read-only client (wallet_stats, wallet_activity)
- `artifacts/api-server/src/services/jupiter-swap.service.ts` — buy/sell via Jupiter; dynamicSlippage; Helius fee estimation
- `artifacts/api-server/src/services/solana-wallet.service.ts` — keypair, signAndSendAndConfirm, getOptimalPriorityFee
- `artifacts/terminal/src/` — React frontend

## Architecture decisions

- **Smart Wallet Consensus entry strategy** (current): replaces the old 10s net-buy-volume tiers. Every buyer wallet on a tracked (post-graduation) token is scored via GMGN (`wallet-score.service.ts`); an entry triggers when either 2+ distinct wallets score ≥80 within a 5-min window (consensus, 0.75% risk, TP tier 2) or a single wallet scores ≥95 (solo conviction, 1% risk, TP tier 3). GMGN doesn't expose "wallet age" or "avg hold time" directly — both are approximated from the wallet's recent activity page (oldest tx timestamp; buy→sell time deltas), documented inline in `wallet-score.service.ts`. Without `GMGN_API_KEY` set, all wallet scores resolve to 0 and no entries trigger (fails safe, no crash).
- **dynamicSlippage only**: Jupiter `/swap` is called with `dynamicSlippage: { minBps: 50, maxBps: 9000 }` and NO `slippageBps` field — passing both causes the static value to override dynamic calculation, which was the root cause of all Custom:1 errors.
- **Helius p75 priority fees**: `getOptimalPriorityFee()` fetches the 75th-percentile of recent prioritization fees from Helius; floored at `priorityFeeLamports` config value (500k lamports), capped at 5M lamports.
- **`@solana/web3.js` externalized in esbuild**: marked as external in `build.mjs` to avoid bundling issues; loaded from node_modules at runtime.
- **Paper trading mode**: when `SOLANA_PRIVATE_KEY` is absent, the bot runs in simulation mode — all buy/sell paths degrade gracefully without throwing.

## Product

- Monitors Pump.fun token graduations via Helius WebSocket
- Tracks each graduated token for 30 minutes, scoring buyer wallets via GMGN and entering on Smart Wallet Consensus (see Architecture decisions)
- Manages each position with configurable TP1/TP2/trailing-stop/SL
- Real-time dashboard showing open positions, P&L, wallet balance
- Telegram alerts for entries, exits, and errors

## Recent changes

- **Entry latency fix (2026-07-15)**: Smart Wallet Consensus entries were landing 30-40s after the qualifying buy instead of the target ~3-4s. Root causes: a blocking DexScreener call for display-only name/symbol/mcap at the top of `enterSniperPosition` (now deferred to a background refine step), a flat 2s `ENTRY_DELAY_MS` no longer needed now that entry price reads from tx-captured vault addresses directly (cut to 400ms), and entry-critical Helius RPC calls sharing one queue with routine background polling (added a priority lane in `helius-limiter.ts` so buy-detection/entry-price reads jump ahead of housekeeping calls — same rate limit budget, just reordered). No thresholds/timeouts that could cause a qualifying transaction to be skipped were changed. See `.agents/memory/sniper-consensus-entry-latency.md` for details. **This only takes effect on Render** (where the live-trading secrets live) after pushing — run `push.sh` to sync to GitHub for Render to pick up.

## Gotchas

- **GMGN wallet-stats field names**: `/v1/user/wallet_stats` nests `winrate` and `avg_holding_period` under `pnl_stat`, uses `buy`/`sell` (not `buy_count`/`sell_count`) for trade counts, and `realized_profit_pnl` (not `pnl`) for ROI — and returns some of those as numeric strings, not numbers. Reading the old flat field names silently zeroed every wallet score (all fields undefined → every scoring condition false). Fixed in `wallet-score.service.ts`/`gmgn-client.ts`; verify against a live response before renaming any of these again. Activity items use `event_type`, not `type`.

- **Render has all trading secrets** (`SOLANA_PRIVATE_KEY`, `HELIUS_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) — Replit does NOT. Live trading only works on Render.
- **`GMGN_API_KEY`** is required for wallet-consensus entries to ever trigger — without it every wallet scores 0 and the bot only tracks/observes, never buys.
- **Always restart the API Server workflow after code changes** — esbuild rebuilds on `dev` start.
- **`pnpm --filter @workspace/api-server run dev`** rebuilds then starts; just `pnpm run start` skips the build.
