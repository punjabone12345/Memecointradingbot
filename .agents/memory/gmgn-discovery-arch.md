---
name: GMGN Discovery Architecture
description: GMGN-first token discovery replacing GeckoTerminal; why it requires API key and how it bypasses Cloudflare
---

# GMGN Discovery Architecture

## Rule
Discovery endpoints (`/defi/quotation/v1/tokens/new_pairs/sol`, `/defi/quotation/v1/rank/sol/swaps/5m`) live on **gmgn.ai** (the web-app quotation API), NOT on `openapi.gmgn.ai` (wallet analytics OpenAPI). `gmgn.ai` is Cloudflare-protected — the `X-APIKEY` header bypasses the bot-detection. Without it, all requests from cloud IPs are blocked.

## Why
- `gmgn.ai` quotation paths return 200 with browser+key, Cloudflare-blocked without key
- `openapi.gmgn.ai` quotation paths time out (they don't exist there)
- Discovery rate limiter (500ms, `gmgn-discovery.ts`) is **separate** from wallet-scoring rate limiter (`gmgn-client.ts`) to avoid starvation

## How to apply
- **Replit (no key)**: `gmgnApiKeySet: false` → UI shows yellow "NO KEY" badge; polls still run but always fail → 0 discovered → expected
- **Render (key set)**: X-APIKEY header sent → Cloudflare bypassed → discovery works
- After any discovery code change, push via `push.sh` to deploy to Render
- Two pollers: new_pairs every 15s, trending/5m every 30s — staggered 7.5s apart

## Files
- `artifacts/api-server/src/lib/gmgn-discovery.ts` — quotation host = `GMGN_QUOTATION_HOST` (default: `https://gmgn.ai`)
- `artifacts/api-server/src/services/trenches.service.ts` — polling loops, suppression map, diagnostics
- `artifacts/terminal/src/pages/DiscoverPage.tsx` — `DiscoveryFeed` reads `gmgn.gmgnApiKeySet` to show NO KEY/BANNED/LIVE status
