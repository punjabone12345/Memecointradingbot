---
name: GMGN Cloudflare curl fix
description: Node.js/axios gets 403 from Cloudflare on gmgn.ai even with X-APIKEY; curl subprocess bypasses it
---

# GMGN Cloudflare curl fix

## Rule
Never use axios/fetch/undici for `gmgn.ai` discovery requests. Use `child_process.execFile('curl', ...)` instead.

**Why:** Cloudflare on gmgn.ai blocks Node.js HTTP clients (axios, native fetch, undici) based on their JA3/TLS fingerprint — returns 403 even when `X-APIKEY` is present and valid. The system `curl` binary uses libcurl's TLS stack which Cloudflare allows through. curl is available on Replit and Render by default.

**How to apply:** See `artifacts/api-server/src/lib/gmgn-discovery.ts` — `discoveryGet()` spawns curl with `-s --max-time --compressed` flags and parses stdout as JSON.

## Also: broken endpoint
`/defi/quotation/v1/tokens/new_pairs/sol` always returns `{"code":40000300,"msg":"invalid argument"}` regardless of params — the endpoint is broken on GMGN's side. Replaced with `/defi/quotation/v1/rank/sol/swaps/1m` in `trenches.service.ts` (same purpose, fully functional).

## Dev/prod VITE_API_URL separation
`artifacts/terminal/src/lib/api.ts` now ignores `VITE_API_URL` in dev mode (`import.meta.env.DEV`), always using the Vite proxy to localhost:8080. `VITE_API_URL` only applies to production builds.
